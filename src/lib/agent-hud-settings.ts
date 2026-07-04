export const AGENT_HUD_ENABLED_KEY = "june:agent-hud:enabled";
export const AGENT_HUD_VISIBILITY_CHANGED_EVENT = "june:agent-hud:visibility-changed";

/* The HUD replaced the desktop mascot; honor the preference users set
 * under the old key so disabling the pet keeps the overlay hidden. */
const LEGACY_ENABLED_KEY = "june:mascot:enabled";

export type AgentHudVisibilityChangedDetail = {
  enabled: boolean;
};

export function getAgentHudEnabled() {
  const value =
    localStorage.getItem(AGENT_HUD_ENABLED_KEY) ?? localStorage.getItem(LEGACY_ENABLED_KEY);
  return value !== "false";
}

export function setAgentHudEnabled(enabled: boolean) {
  localStorage.setItem(AGENT_HUD_ENABLED_KEY, enabled ? "true" : "false");
  const detail: AgentHudVisibilityChangedDetail = { enabled };
  window.dispatchEvent(
    new CustomEvent<AgentHudVisibilityChangedDetail>(AGENT_HUD_VISIBILITY_CHANGED_EVENT, {
      detail,
    }),
  );
  void import("@tauri-apps/api/event")
    .then((api) =>
      typeof api.emit === "function"
        ? api.emit(AGENT_HUD_VISIBILITY_CHANGED_EVENT, detail)
        : undefined,
    )
    .catch(() => {});
}

export const AGENT_HUD_PLACEMENT_KEY = "june:agent-hud:placement";
export const AGENT_HUD_PLACEMENT_CHANGED_EVENT = "june:agent-hud:placement-changed";

/** Where the HUD window parks: the classic top-right notification spot, or
 * docked into the camera housing (notch) of the built-in display. Notch
 * placement floats a top-center pill on displays without a housing. */
export type AgentHudPlacement = "top-right" | "notch";

export type AgentHudPlacementChangedDetail = {
  placement: AgentHudPlacement;
};

export function getAgentHudPlacement(): AgentHudPlacement {
  return localStorage.getItem(AGENT_HUD_PLACEMENT_KEY) === "notch" ? "notch" : "top-right";
}

export function setAgentHudPlacement(placement: AgentHudPlacement) {
  localStorage.setItem(AGENT_HUD_PLACEMENT_KEY, placement);
  const detail: AgentHudPlacementChangedDetail = { placement };
  window.dispatchEvent(
    new CustomEvent<AgentHudPlacementChangedDetail>(AGENT_HUD_PLACEMENT_CHANGED_EVENT, {
      detail,
    }),
  );
  void import("@tauri-apps/api/event")
    .then((api) =>
      typeof api.emit === "function"
        ? api.emit(AGENT_HUD_PLACEMENT_CHANGED_EVENT, detail)
        : undefined,
    )
    .catch(() => {});
}
