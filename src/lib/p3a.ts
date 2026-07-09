import type { P3aSettingsDto } from "./tauri";

// The telemetry docs link to main, not the build's commit: a pinned commit
// only resolves on GitHub if that exact commit was pushed, so dev and
// squash-merged builds served 404s. main always resolves, at the cost of the
// doc occasionally running ahead of an older installed build.
const TELEMETRY_DOCS_REF = "main";

export const P3A_SETTINGS_CHANGED_EVENT = "june:p3a";
export const TELEMETRY_INFO_URL = `https://github.com/open-software-network/os-june/blob/${TELEMETRY_DOCS_REF}/docs/telemetry.md`;
export const TELEMETRY_QUESTIONS_URL = `https://github.com/open-software-network/os-june/blob/${TELEMETRY_DOCS_REF}/docs/telemetry-questions.md`;

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
