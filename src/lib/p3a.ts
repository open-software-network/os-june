import type { P3aSettingsDto } from "./tauri";

export const P3A_SETTINGS_CHANGED_EVENT = "june:p3a";
export const TELEMETRY_QUESTIONS_URL =
  "https://github.com/open-software-network/os-june/blob/main/docs/telemetry-questions.md";

export type P3aSettingsChangedDetail = {
  settings: P3aSettingsDto;
};

export function dispatchP3aSettingsChanged(settings: P3aSettingsDto) {
  window.dispatchEvent(
    new CustomEvent<P3aSettingsChangedDetail>(P3A_SETTINGS_CHANGED_EVENT, {
      detail: { settings },
    }),
  );
}
