import type { HermesMessagingEnvVarInfo, HermesToolsetInfo } from "../../../lib/tauri";

export function toolNames(toolset: HermesToolsetInfo) {
  return Array.isArray(toolset.tools) ? toolset.tools : [];
}

export function stateLabel(value: string) {
  return value.replaceAll("_", " ");
}

/** A meaningful capability status word for the list meta line, or undefined.
 * The row's switch already conveys enabled/disabled, so those (and the neutral
 * "unknown"/"configured" placeholders) are dropped to avoid a redundant word;
 * only states that carry real information (e.g. connected, needs setup, error)
 * survive, sentence-cased. */
export function meaningfulCapabilityStatus(state: string): string | undefined {
  const normalized = state.trim().toLowerCase();
  const redundant = new Set(["enabled", "disabled", "unknown", "configured", ""]);
  if (redundant.has(normalized)) return undefined;
  const label = stateLabel(normalized);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function envFieldSet(field: HermesMessagingEnvVarInfo) {
  return Boolean(field.isSet ?? field.is_set);
}

export function fieldLabel(field: HermesMessagingEnvVarInfo) {
  return field.prompt || field.key.replaceAll("_", " ").toLowerCase();
}

export function messagingTrimEdits(edits: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(edits)
      .map(([key, value]) => [key, value.trim()])
      .filter(([, value]) => value.length > 0),
  );
}
