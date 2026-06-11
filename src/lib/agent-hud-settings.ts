export const AGENT_HUD_ENABLED_KEY = "scribe:agent-hud:enabled";
export const AGENT_HUD_VISIBILITY_CHANGED_EVENT =
  "scribe:agent-hud:visibility-changed";

/* The HUD replaced the desktop mascot; honor the preference users set
 * under the old key so disabling the pet keeps the overlay hidden. */
const LEGACY_ENABLED_KEY = "scribe:mascot:enabled";

export type AgentHudVisibilityChangedDetail = {
  enabled: boolean;
};

export function getAgentHudEnabled() {
  const value =
    localStorage.getItem(AGENT_HUD_ENABLED_KEY) ??
    localStorage.getItem(LEGACY_ENABLED_KEY);
  return value !== "false";
}

export function setAgentHudEnabled(enabled: boolean) {
  localStorage.setItem(AGENT_HUD_ENABLED_KEY, enabled ? "true" : "false");
  const detail: AgentHudVisibilityChangedDetail = { enabled };
  window.dispatchEvent(
    new CustomEvent<AgentHudVisibilityChangedDetail>(
      AGENT_HUD_VISIBILITY_CHANGED_EVENT,
      { detail },
    ),
  );
  void import("@tauri-apps/api/event")
    .then((api) =>
      typeof api.emit === "function"
        ? api.emit(AGENT_HUD_VISIBILITY_CHANGED_EVENT, detail)
        : undefined,
    )
    .catch(() => {});
}
