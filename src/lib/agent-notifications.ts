import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import type {
  AgentSessionStatusDetail,
  AgentSessionStatusKind,
} from "./agent-events";

type NotificationCopy = {
  title: string;
  body: string;
};

const NOTIFICATION_STATUSES = new Set<AgentSessionStatusKind>([
  "waitingForUser",
  "completed",
  "failed",
  "cancelled",
]);

const DEDUPE_WINDOW_MS = 15_000;
const NOTIFICATION_SOUND = "Ping";

type AgentNotificationGlobal = typeof globalThis & {
  __scribeAgentNotificationTimes?: Map<string, number>;
};

function recentNotificationTimes() {
  const target = globalThis as AgentNotificationGlobal;
  target.__scribeAgentNotificationTimes ??= new Map<string, number>();
  return target.__scribeAgentNotificationTimes;
}

export async function notifyAgentSessionStatus(
  detail: AgentSessionStatusDetail,
) {
  if (!NOTIFICATION_STATUSES.has(detail.status)) return false;

  const copy = agentNotificationCopy(detail);
  const group = agentNotificationGroup(detail);
  const dedupeKey = `${group}:${copy.title}:${copy.body}`;
  const now = Date.now();
  const recent = recentNotificationTimes();
  const previous = recent.get(dedupeKey);
  if (previous && now - previous < DEDUPE_WINDOW_MS) return false;
  recent.set(dedupeKey, now);

  let granted = await isPermissionGranted().catch(() => false);
  if (!granted) {
    const permission = await requestPermission().catch(() => "denied" as const);
    granted = permission === "granted";
  }
  if (!granted) return false;

  sendNotification({
    title: copy.title,
    body: copy.body,
    group,
    sound: NOTIFICATION_SOUND,
  });
  playAgentNotificationTone(detail.status);
  return true;
}

export function agentNotificationCopy(
  detail: AgentSessionStatusDetail,
): NotificationCopy {
  const subject =
    detail.title?.trim() || detail.prompt?.trim() || "Agent session";
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

function agentNotificationGroup(detail: AgentSessionStatusDetail) {
  if (detail.sessionId) {
    return `scribe-agent-${detail.sessionId}`;
  }
  const fallback = detail.title || detail.prompt || "session";
  return `scribe-agent-${detail.status}-${fallback.slice(0, 64)}`;
}

function playAgentNotificationTone(status: AgentSessionStatusKind) {
  if (typeof window === "undefined") return;
  const AudioContextCtor =
    window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioContextCtor) return;

  try {
    const context = new AudioContextCtor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const now = context.currentTime;
    const frequency =
      status === "waitingForUser"
        ? 660
        : status === "completed"
          ? 880
          : status === "failed" || status === "cancelled"
            ? 220
            : 520;

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.05, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.24);
    oscillator.addEventListener("ended", () => void context.close());
  } catch {
    // Native notifications remain authoritative; the local tone is a fallback.
  }
}
