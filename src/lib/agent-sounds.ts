import {
  playInterfaceSound,
  preloadInterfaceSounds,
  type InterfaceSound,
} from "./interface-sounds";

const AGENT_INTERFACE_SOUNDS = {
  ready: "agentReady",
  needsInput: "agentNeedsInput",
} as const;

export type AgentSound = keyof typeof AGENT_INTERFACE_SOUNDS;

export function preloadAgentSounds() {
  preloadInterfaceSounds(Object.values(AGENT_INTERFACE_SOUNDS) as InterfaceSound[]);
}

export function playAgentSound(sound: AgentSound) {
  return playInterfaceSound(AGENT_INTERFACE_SOUNDS[sound]);
}
