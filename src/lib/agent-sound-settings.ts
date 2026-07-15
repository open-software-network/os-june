export const AGENT_SOUNDS_ENABLED_KEY = "june:agent-sounds:enabled";
export const AGENT_SOUNDS_CHANGED_EVENT = "june:agent-sounds:changed";

export type AgentSoundsChangedDetail = {
  enabled: boolean;
};

export function getAgentSoundsEnabled() {
  return localStorage.getItem(AGENT_SOUNDS_ENABLED_KEY) !== "false";
}

export function setAgentSoundsEnabled(enabled: boolean) {
  localStorage.setItem(AGENT_SOUNDS_ENABLED_KEY, enabled ? "true" : "false");
  window.dispatchEvent(
    new CustomEvent<AgentSoundsChangedDetail>(AGENT_SOUNDS_CHANGED_EVENT, {
      detail: { enabled },
    }),
  );
}
