const RECORDING_SOUND_PATHS = {
  start: "/sounds/record-start.mp3",
  pause: "/sounds/record-pause.mp3",
  stop: "/sounds/record-end.mp3",
} as const;

export type RecordingSound = keyof typeof RECORDING_SOUND_PATHS;

let audioConstructor: typeof Audio | undefined;
const audioElements = new Map<RecordingSound, HTMLAudioElement>();
const activeAudioElements = new Set<HTMLAudioElement>();

function getRecordingAudio(sound: RecordingSound) {
  if (typeof Audio === "undefined") return;

  if (audioConstructor !== Audio) {
    audioElements.clear();
    activeAudioElements.clear();
    audioConstructor = Audio;
  }

  const cachedAudio = audioElements.get(sound);
  if (cachedAudio) return cachedAudio;

  const audio = new Audio(RECORDING_SOUND_PATHS[sound]);
  audio.preload = "auto";
  audio.volume = 0.7;
  audio.load();
  audioElements.set(sound, audio);
  return audio;
}

export function preloadRecordingSounds() {
  (Object.keys(RECORDING_SOUND_PATHS) as RecordingSound[]).forEach((sound) => {
    getRecordingAudio(sound);
  });
}

export function playRecordingSound(sound: RecordingSound) {
  const audio = getRecordingAudio(sound);
  if (!audio) return;

  activeAudioElements.forEach((activeAudio) => {
    activeAudio.pause();
    activeAudio.currentTime = 0;
  });
  activeAudioElements.clear();

  const playbackAudio = audio.cloneNode(true) as HTMLAudioElement;
  playbackAudio.volume = 0.7;
  playbackAudio.currentTime = 0;
  activeAudioElements.add(playbackAudio);
  playbackAudio.addEventListener(
    "ended",
    () => activeAudioElements.delete(playbackAudio),
    { once: true },
  );

  void playbackAudio
    .play()
    .catch(() => {
      // Browsers and webviews may reject autoplay. Recording should continue.
    })
    .finally(() => {
      if (playbackAudio.paused) activeAudioElements.delete(playbackAudio);
    });
}
