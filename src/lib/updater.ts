import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

export type ScribeUpdate = Update;

export function checkScribeUpdate() {
  // No explicit target: let the runtime report its own platform and match it
  // against the manifest. We only publish darwin-aarch64 today (ADR-0001:
  // Intel is intentionally unsupported), but that scope lives in the published
  // manifest's `platforms` keys, not pinned here — so a future arch "just works"
  // once its build is added, instead of silently requesting the aarch64 key.
  return check();
}

export function relaunchScribe() {
  return relaunch();
}
