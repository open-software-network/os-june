export const MASCOT_ENABLED_KEY = "scribe:mascot:enabled";
export const MASCOT_VISIBILITY_CHANGED_EVENT =
  "scribe:mascot:visibility-changed";

export type MascotVisibilityChangedDetail = {
  enabled: boolean;
};

export function getMascotEnabled() {
  return localStorage.getItem(MASCOT_ENABLED_KEY) !== "false";
}

export function setMascotEnabled(enabled: boolean) {
  localStorage.setItem(MASCOT_ENABLED_KEY, enabled ? "true" : "false");
  const detail: MascotVisibilityChangedDetail = { enabled };
  window.dispatchEvent(
    new CustomEvent<MascotVisibilityChangedDetail>(
      MASCOT_VISIBILITY_CHANGED_EVENT,
      { detail },
    ),
  );
  void import("@tauri-apps/api/event")
    .then((api) =>
      typeof api.emit === "function"
        ? api.emit(MASCOT_VISIBILITY_CHANGED_EVENT, detail)
        : undefined,
    )
    .catch(() => {});
}
