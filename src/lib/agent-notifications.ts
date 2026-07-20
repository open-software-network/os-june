import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import type {
  AgentRunSettledDetail,
  AgentSessionStatusDetail,
  AgentSessionStatusKind,
} from "./agent-events";
import { playAgentSound, type AgentSound } from "./agent-sounds";
import { sendAppNotification } from "./tauri";

type NotificationCopy = {
  title: string;
  body: string;
};

export type AgentAttentionContext = {
  away: boolean;
  viewingSession: boolean;
  captureActive: boolean;
  soundsEnabled: boolean;
};

export type AgentAttentionDecision = {
  cue?: AgentSound;
  showNative: boolean;
};

type AgentAttentionKind = AgentSound | undefined;

const DEDUPE_WINDOW_MS = 15_000;

type AgentNotificationGlobal = typeof globalThis & {
  __juneAgentNotificationTimes?: Map<string, number>;
};

function recentNotificationTimes(now: number) {
  const target = globalThis as AgentNotificationGlobal;
  target.__juneAgentNotificationTimes ??= new Map<string, number>();
  const recent = target.__juneAgentNotificationTimes;
  for (const [key, timestamp] of recent) {
    if (now - timestamp >= DEDUPE_WINDOW_MS) recent.delete(key);
  }
  return recent;
}

function attentionKindForStatus(status: AgentSessionStatusKind): AgentAttentionKind {
  if (status === "waitingForUser" || status === "failed") return "needsInput";
  return undefined;
}

export function agentAttentionDecision(
  kind: AgentAttentionKind,
  context: AgentAttentionContext,
): AgentAttentionDecision {
  if (!kind || context.viewingSession) return { showNative: false };
  return {
    ...(context.soundsEnabled && !context.captureActive ? { cue: kind } : {}),
    showNative: context.away,
  };
}

export async function notifyAgentSessionStatus(
  detail: AgentSessionStatusDetail,
  context: AgentAttentionContext,
) {
  const kind = attentionKindForStatus(detail.status);
  return deliverAgentAttention({
    copy: agentNotificationCopy(detail),
    context,
    detail,
    kind,
  });
}

export async function notifyAgentRunSettled(
  detail: AgentRunSettledDetail,
  context: AgentAttentionContext,
) {
  return deliverAgentAttention({
    copy: {
      title: "June is ready",
      body: detail.title.trim() || detail.summary.trim() || "Agent session",
    },
    context,
    detail,
    kind: "ready",
  });
}

async function deliverAgentAttention({
  copy,
  context,
  detail,
  kind,
}: {
  copy: NotificationCopy;
  context: AgentAttentionContext;
  detail: { sessionId?: string; title?: string };
  kind: AgentAttentionKind;
}) {
  const decision = agentAttentionDecision(kind, context);
  if (!decision.cue && !decision.showNative) return false;

  const group = agentNotificationGroup(detail, kind);
  const dedupeKey = `${group}:${copy.title}:${copy.body}`;
  const now = Date.now();
  const recent = recentNotificationTimes(now);
  const previous = recent.get(dedupeKey);
  if (previous && now - previous < DEDUPE_WINDOW_MS) return false;
  // Reserve before any permission prompt or native delivery await. Two
  // lifecycle frames can arrive in the same tick, and both must not pass the
  // dedupe check while the first is waiting on Notification Center.
  recent.set(dedupeKey, now);

  let delivered = false;
  if (decision.cue) {
    playAgentSound(decision.cue);
    // The coordinator may fold this into a cue already playing. That still
    // covers the burst, so duplicate lifecycle frames should stay deduped.
    delivered = true;
  }

  if (decision.showNative && (await notificationPermissionGranted())) {
    try {
      await sendAppNotification({
        title: copy.title,
        body: copy.body,
        group,
        sessionId: detail.sessionId,
      });
      delivered = true;
    } catch {
      // The backend command owns click routing. Older app shells may not have
      // it yet, so keep the plugin as a silent visual fallback.
      try {
        sendNotification({
          title: copy.title,
          body: copy.body,
          group,
        });
        delivered = true;
      } catch {
        // The branded local cue remains useful if native delivery also fails.
      }
    }
  }

  // A denied native-only attempt did not reach the user, so let a later event
  // retry. Keep a newer reservation if another delivery replaced this one.
  if (!delivered && recent.get(dedupeKey) === now) recent.delete(dedupeKey);
  return delivered;
}

async function notificationPermissionGranted() {
  let granted = await isPermissionGranted().catch(() => false);
  if (!granted) {
    const permission = await requestPermission().catch(() => "denied" as const);
    granted = permission === "granted";
  }
  return granted;
}

export function agentNotificationCopy(detail: AgentSessionStatusDetail): NotificationCopy {
  const subject = detail.title?.trim() || detail.prompt?.trim() || "Agent session";
  const body = detail.summary?.trim() || subject;

  if (detail.status === "waitingForUser") {
    return { title: "June needs your input", body };
  }
  if (detail.status === "completed") {
    return { title: "June finished", body };
  }
  if (detail.status === "cancelled") {
    return { title: "June stopped", body };
  }
  return { title: "June hit a problem", body };
}

function agentNotificationGroup(
  detail: { sessionId?: string; title?: string },
  kind: AgentAttentionKind,
) {
  if (detail.sessionId) return `june-agent-${detail.sessionId}`;
  const fallback = detail.title || "session";
  return `june-agent-${kind ?? "status"}-${fallback.slice(0, 64)}`;
}
