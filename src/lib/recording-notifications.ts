import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { RECORDING_INACTIVITY_RESPONSE_MS } from "./recording-inactivity";
import { sendAppNotification } from "./tauri";

const NOTIFICATION_SOUND = "Ping";
const RESPONSE_SECONDS = Math.round(RECORDING_INACTIVITY_RESPONSE_MS / 1000);

async function canNotify() {
  let granted = await isPermissionGranted().catch(() => false);
  if (!granted) {
    const permission = await requestPermission().catch(() => "denied" as const);
    granted = permission === "granted";
  }
  return granted;
}

// Recording notifications go through the same backend command as agent ones:
// the plugin's desktop sender replaces the notification-center delegate on
// every send, which would break click deep-linking for agent notifications
// (JUN-327). No sessionId here; clicking still just opens the app.
async function deliver(notification: { title: string; body: string; group: string }) {
  try {
    await sendAppNotification({ ...notification, sound: NOTIFICATION_SOUND });
  } catch {
    await sendNotification({ ...notification, sound: NOTIFICATION_SOUND });
  }
}

export async function notifyRecordingStillMeetingPrompt(sessionId: string) {
  if (!(await canNotify())) return false;
  try {
    await deliver({
      title: "Still in a meeting?",
      body: `June will pause the recording in ${RESPONSE_SECONDS} seconds if you do not answer.`,
      group: `june-recording-${sessionId}`,
    });
    return true;
  } catch {
    return false;
  }
}

export async function notifyRecordingAutoPaused(sessionId: string) {
  if (!(await canNotify())) return false;
  try {
    await deliver({
      title: "June paused recording",
      body: "No meeting audio was detected. Open June to resume or finish.",
      group: `june-recording-${sessionId}`,
    });
    return true;
  } catch {
    return false;
  }
}
