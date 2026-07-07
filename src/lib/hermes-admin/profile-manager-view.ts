/**
 * Pure, framework-free helpers for June's Hermes profile manager. The React
 * hook owns I/O and pending state; this module owns deterministic list ordering
 * and action guards so the future settings UI can render the same rules without
 * touching Hermes or Tauri.
 */

import type { HermesProfileSummary } from "./schemas";

export type ProfileActionGuard =
  | { ok: true }
  | {
      ok: false;
      reason: string;
    };

/** Orders profiles with `default` first, then all other profile names
 * alphabetically. The input is never mutated. */
export function orderProfiles(profiles: readonly HermesProfileSummary[]): HermesProfileSummary[] {
  return [...profiles].sort((a, b) => {
    if (a.name === "default" && b.name !== "default") return -1;
    if (b.name === "default" && a.name !== "default") return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/** Activating the already-active profile is a no-op and should not hit Hermes. */
export function canActivateProfile(name: string, activeName: string): ProfileActionGuard {
  if (name === activeName) {
    return { ok: false, reason: "This profile is already active." };
  }
  return { ok: true };
}

/** Deleting the default profile or the active profile is blocked client-side so
 * the UI can explain the rule before Hermes refuses the request. */
export function canRemoveProfile(name: string, activeName: string): ProfileActionGuard {
  if (name === "default") {
    return { ok: false, reason: "The default profile can't be deleted." };
  }
  if (name === activeName) {
    return {
      ok: false,
      reason: "Switch to another profile before deleting this one.",
    };
  }
  return { ok: true };
}

/** A compact one-line summary for profile rows, preferring the declared
 * description and appending provider/model when Hermes reports them. */
export function describeProfile(profile: HermesProfileSummary): string {
  const model = [profile.provider, profile.model].filter(Boolean).join(" / ");
  if (profile.description && model) return `${profile.description} (${model})`;
  return profile.description ?? model;
}
