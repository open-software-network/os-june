const INTERFACE_SOUND_PATHS = {
  recordStart: "/sounds/record-start.mp3",
  recordPause: "/sounds/record-pause.mp3",
  recordStop: "/sounds/record-end.mp3",
  agentReady: "/sounds/agent-ready.mp3",
  agentNeedsInput: "/sounds/agent-needs-input.mp3",
} as const;

export type InterfaceSound = keyof typeof INTERFACE_SOUND_PATHS;
type SoundKind = "recording" | "agent";

const AGENT_CUE_COALESCE_MS = 1_000;

let audioConstructor: typeof Audio | undefined;
const audioElements = new Map<InterfaceSound, HTMLAudioElement>();
let activePlayback: { audio: HTMLAudioElement; kind: SoundKind } | undefined;
let lastAgentCueAt = Number.NEGATIVE_INFINITY;

function soundKind(sound: InterfaceSound): SoundKind {
  return sound.startsWith("record") ? "recording" : "agent";
}

function syncAudioConstructor() {
  if (typeof Audio === "undefined") return;
  if (audioConstructor !== Audio) {
    audioElements.clear();
    activePlayback = undefined;
    lastAgentCueAt = Number.NEGATIVE_INFINITY;
    audioConstructor = Audio;
  }
  return Audio;
}

function getAudio(sound: InterfaceSound) {
  if (!syncAudioConstructor()) return;

  const cachedAudio = audioElements.get(sound);
  if (cachedAudio) return cachedAudio;

  const audio = new Audio(INTERFACE_SOUND_PATHS[sound]);
  audio.preload = "auto";
  audio.volume = 0.7;
  audio.load();
  audioElements.set(sound, audio);
  return audio;
}

export function preloadInterfaceSounds(sounds: readonly InterfaceSound[]) {
  for (const sound of sounds) getAudio(sound);
}

export function playInterfaceSound(sound: InterfaceSound) {
  if (!syncAudioConstructor()) return false;
  const kind = soundKind(sound);
  const now = Date.now();

  if (kind === "agent") {
    if (activePlayback?.kind === "recording" && !activePlayback.audio.paused) return false;
    if (now - lastAgentCueAt < AGENT_CUE_COALESCE_MS) return false;
  }

  const audio = getAudio(sound);
  if (!audio) return false;

  if (activePlayback) {
    activePlayback.audio.pause();
    activePlayback.audio.currentTime = 0;
    activePlayback = undefined;
  }

  const playbackAudio = audio.cloneNode(true) as HTMLAudioElement;
  playbackAudio.volume = 0.7;
  playbackAudio.currentTime = 0;
  activePlayback = { audio: playbackAudio, kind };
  if (kind === "agent") lastAgentCueAt = now;
  playbackAudio.addEventListener(
    "ended",
    () => {
      if (activePlayback?.audio === playbackAudio) activePlayback = undefined;
    },
    { once: true },
  );

  void playbackAudio
    .play()
    .catch(() => {
      // Browsers and webviews may reject autoplay. The underlying action continues.
    })
    .finally(() => {
      if (playbackAudio.paused && activePlayback?.audio === playbackAudio) {
        activePlayback = undefined;
      }
    });
  return true;
}
