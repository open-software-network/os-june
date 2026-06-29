import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { RECORDING_INACTIVITY_RESPONSE_MS } from "./recording-inactivity";

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

export async function notifyRecordingStillMeetingPrompt(sessionId: string) {
  if (!(await canNotify())) return false;
  try {
    await sendNotification({
      title: "Still in a meeting?",
      body: `June will pause the recording in ${RESPONSE_SECONDS} seconds if you do not answer.`,
      group: `june-recording-${sessionId}`,
      sound: NOTIFICATION_SOUND,
    });
    return true;
  } catch {
    return false;
  }
}

export async function notifyRecordingAutoPaused(sessionId: string) {
  if (!(await canNotify())) return false;
  try {
    await sendNotification({
      title: "June paused recording",
      body: "No meeting audio was detected. Open June to resume or finish.",
      group: `june-recording-${sessionId}`,
      sound: NOTIFICATION_SOUND,
    });
    return true;
  } catch {
    return false;
  }
}
