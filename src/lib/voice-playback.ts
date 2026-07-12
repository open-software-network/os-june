import { messageFromError } from "./errors";
import {
  VOICE_PLAYBACK_STATUS_EVENT,
  type VoicePlaybackSettingsDto,
  type VoicePlaybackStatusDto,
  voicePlaybackCancel,
  voicePlaybackPlay,
  voicePlaybackSettings,
  voicePlaybackStatus,
  voicePlaybackSynthesize,
  voicePlaybackWarm,
} from "./tauri";
import { speakableVoiceText, voiceTextChunks } from "./voice-playback-text";

export type VoicePlaybackState = {
  turnId: string | null;
  loading: boolean;
  status: VoicePlaybackStatusDto | null;
  settings: VoicePlaybackSettingsDto | null;
  error: string | null;
};

type Listener = () => void;

let state: VoicePlaybackState = {
  turnId: null,
  loading: false,
  status: null,
  settings: null,
  error: null,
};
const listeners = new Set<Listener>();
let queue: string[] = [];
let streamTurnId: string | null = null;
let generation = 0;
let pumpPromise: Promise<void> | undefined;
let controlChain = Promise.resolve();
let statusListenerStarted = false;

function setState(next: Partial<VoicePlaybackState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function scheduleControl<T>(operation: () => Promise<T>): Promise<T> {
  const result = controlChain.then(operation, operation);
  controlChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function subscribeVoicePlayback(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function voicePlaybackState() {
  return state;
}

export async function initVoicePlayback() {
  if (statusListenerStarted) return;
  statusListenerStarted = true;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<VoicePlaybackStatusDto>(VOICE_PLAYBACK_STATUS_EVENT, (event) => {
      setState({ status: event.payload });
    });
    const [settings, status] = await Promise.all([voicePlaybackSettings(), voicePlaybackStatus()]);
    setState({ settings, status, error: null });
    if (settings.playbackMode === "streaming" && status.state === "idle") {
      await voicePlaybackWarm();
    }
  } catch (error) {
    statusListenerStarted = false;
    setState({ error: messageFromError(error) });
  }
}

export function applyVoicePlaybackSettings(settings: VoicePlaybackSettingsDto) {
  setState({ settings });
}

export function clearVoicePlaybackError() {
  if (state.error) setState({ error: null });
}

export function voicePlaybackAvailable() {
  return (
    state.status?.state === "idle" ||
    state.status?.state === "starting" ||
    state.status?.state === "ready"
  );
}

export function streamingVoicePlaybackEnabled() {
  return voicePlaybackAvailable() && state.settings?.playbackMode === "streaming";
}

export function voicePlaybackSetupError() {
  const status = state.status;
  if (!status) return "Voice playback is still loading. Try again in a moment.";
  if (status.state === "unavailable") return status.reason;
  if (status.state === "error") return status.message;
  if (status.state === "notInstalled" || status.state === "installing") {
    return "Set up voice playback in Settings, under Audio.";
  }
  return null;
}

export function speakVoiceTurn(turnId: string, markdown: string) {
  return scheduleControl(async () => {
    if (state.turnId === turnId) {
      await cancelVoicePlayback(false);
      return;
    }
    const setupError = voicePlaybackSetupError();
    if (setupError) {
      setState({ error: setupError });
      throw new Error(setupError);
    }
    const text = speakableVoiceText(markdown);
    if (!text) return;
    if (state.turnId) await cancelVoicePlayback(false);
    queue = voiceTextChunks(text);
    streamTurnId = null;
    setState({ turnId, loading: true, error: null });
    startPump();
  });
}

export function queueStreamedVoiceChunk(turnId: string, chunk: string) {
  return scheduleControl(async () => {
    if (!streamingVoicePlaybackEnabled()) return;
    if (state.turnId !== turnId) {
      if (state.turnId) await cancelVoicePlayback(false);
      setState({ turnId, loading: true, error: null });
    }
    streamTurnId = turnId;
    queue.push(chunk);
    startPump();
  });
}

export function rekeyStreamedVoiceTurn(fromTurnId: string, toTurnId: string) {
  return scheduleControl(async () => {
    if (streamTurnId !== fromTurnId) return;
    streamTurnId = toTurnId;
    if (state.turnId === fromTurnId) setState({ turnId: toTurnId });
  });
}

export function finishStreamedVoiceTurn(turnId: string) {
  return scheduleControl(async () => {
    if (streamTurnId !== turnId) return;
    streamTurnId = null;
    if (!pumpPromise && queue.length === 0 && state.turnId === turnId) {
      setState({ turnId: null, loading: false });
    }
  });
}

export function stopVoicePlayback({ releaseModel = false }: { releaseModel?: boolean } = {}) {
  return scheduleControl(() => cancelVoicePlayback(releaseModel));
}

export function isVoiceTurnPlaying(turnId: string) {
  return state.turnId === turnId;
}

async function cancelVoicePlayback(releaseModel: boolean) {
  generation += 1;
  queue = [];
  streamTurnId = null;
  try {
    await voicePlaybackCancel(releaseModel);
    pumpPromise = undefined;
    setState({ turnId: null, loading: false, error: null });
  } catch (error) {
    pumpPromise = undefined;
    const message = messageFromError(error);
    setState({ loading: false, error: message });
    throw error;
  }
}

function startPump() {
  if (pumpPromise) return;
  const currentGeneration = generation;
  pumpPromise = pump(currentGeneration).finally(() => {
    if (generation !== currentGeneration) return;
    pumpPromise = undefined;
    if (queue.length > 0) {
      startPump();
    } else if (state.turnId && state.turnId !== streamTurnId) {
      setState({ turnId: null, loading: false });
    }
  });
}

async function pump(currentGeneration: number) {
  try {
    while (generation === currentGeneration) {
      const text = queue.shift();
      if (text === undefined) return;
      const { wavPath } = await voicePlaybackSynthesize(text);
      if (generation !== currentGeneration) return;
      setState({ loading: false });
      await voicePlaybackPlay(wavPath);
    }
  } catch (error) {
    if (generation !== currentGeneration) return;
    queue = [];
    streamTurnId = null;
    setState({ turnId: null, loading: false, error: messageFromError(error) });
  }
}
