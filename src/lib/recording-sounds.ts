const RECORDING_SOUND_PATHS = {
  start: "/sounds/record-start.mp3",
  stop: "/sounds/record-end.mp3",
} as const;

export type RecordingSound = keyof typeof RECORDING_SOUND_PATHS;

export function playRecordingSound(sound: RecordingSound) {
  if (typeof Audio === "undefined") return;

  const audio = new Audio(RECORDING_SOUND_PATHS[sound]);
  audio.volume = 0.7;

  void audio.play().catch(() => {
    // Browsers and webviews may reject autoplay. Recording should continue.
  });
}
