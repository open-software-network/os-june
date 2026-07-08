import { APP_COMMIT_HASH } from "../app/build-info";
import type { P3aSettingsDto } from "./tauri";

const TELEMETRY_DOCS_REF =
  APP_COMMIT_HASH && APP_COMMIT_HASH !== "unknown" ? APP_COMMIT_HASH : "main";

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
