import {
  playInterfaceSound,
  preloadInterfaceSounds,
  type InterfaceSound,
} from "./interface-sounds";

const RECORDING_INTERFACE_SOUNDS = {
  start: "recordStart",
  pause: "recordPause",
  stop: "recordStop",
} as const;

export type RecordingSound = keyof typeof RECORDING_INTERFACE_SOUNDS;

export function preloadRecordingSounds() {
  preloadInterfaceSounds(Object.values(RECORDING_INTERFACE_SOUNDS) as InterfaceSound[]);
}

export function playRecordingSound(sound: RecordingSound) {
  playInterfaceSound(RECORDING_INTERFACE_SOUNDS[sound]);
}
