import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

const NOTIFICATION_SOUND = "Ping";

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
      body: "June will pause the recording soon if you do not answer.",
      group: `scribe-recording-${sessionId}`,
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
      group: `scribe-recording-${sessionId}`,
      sound: NOTIFICATION_SOUND,
    });
    return true;
  } catch {
    return false;
  }
}
