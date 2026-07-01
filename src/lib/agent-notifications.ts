import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import type { AgentSessionStatusDetail, AgentSessionStatusKind } from "./agent-events";

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

export async function notifyAgentSessionStatus(detail: AgentSessionStatusDetail) {
  if (!NOTIFICATION_STATUSES.has(detail.status)) return false;

  const copy = agentNotificationCopy(detail);
  const group = agentNotificationGroup(detail);
  const dedupeKey = `${group}:${copy.title}:${copy.body}`;
  const now = Date.now();
  const recent = recentNotificationTimes(now);
  const previous = recent.get(dedupeKey);
  if (previous && now - previous < DEDUPE_WINDOW_MS) return false;

  let granted = await isPermissionGranted().catch(() => false);
  if (!granted) {
    const permission = await requestPermission().catch(() => "denied" as const);
    granted = permission === "granted";
  }
  if (!granted) return false;

  // Record the dedupe slot only once we know the notification will be shown,
  // so a permission denial does not swallow the next legitimate notification.
  recent.set(dedupeKey, now);

  sendNotification({
    title: copy.title,
    body: copy.body,
    group,
    sound: NOTIFICATION_SOUND,
  });
  playAgentNotificationTone(detail.status);
  return true;
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

function agentNotificationGroup(detail: AgentSessionStatusDetail) {
  if (detail.sessionId) {
    return `june-agent-${detail.sessionId}`;
  }
  const fallback = detail.title || detail.prompt || "session";
  return `june-agent-${detail.status}-${fallback.slice(0, 64)}`;
}

function playAgentNotificationTone(status: AgentSessionStatusKind) {
  if (typeof window === "undefined") return;
  const AudioContextCtor =
    window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
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
    let closed = false;
    const closeContext = () => {
      if (closed) return;
      closed = true;
      void context.close().catch(() => {});
    };
    oscillator.addEventListener("ended", closeContext);
    // WKWebView can keep the context suspended (no user gesture), in which
    // case "ended" never fires; resume it and close on a fallback timer so
    // contexts cannot accumulate.
    if (context.state === "suspended") {
      void context.resume().catch(() => {});
    }
    window.setTimeout(closeContext, 2_000);
  } catch {
    // Native notifications remain authoritative; the local tone is a fallback.
  }
}
