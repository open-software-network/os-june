/** Pure profile-name helpers shared by the profiles settings surface and tests. */

import type { HermesProfileSummary } from "./schemas";

/** Derives the conservative slug Hermes uses as a profile identifier. */
export function slugifyProfileName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const RESERVED_PROFILE_SLUGS: ReadonlySet<string> = new Set(["default", "active", "sessions"]);

/** Validates a profile name and its derived slug against the loaded list. */
export function validateProfileName(
  name: string,
  existing: readonly HermesProfileSummary[],
): string | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Enter a profile name.";
  const slug = slugifyProfileName(trimmed);
  if (slug.length === 0) return "Use letters or numbers in the profile name.";
  if (slug.length > 64) return "Keep the profile name under 64 characters.";
  if (RESERVED_PROFILE_SLUGS.has(slug)) {
    return `"${slug}" is reserved. Choose another name.`;
  }
  if (profileNameCollides(trimmed, existing)) {
    return `A profile named "${slug}" already exists.`;
  }
  return undefined;
}

/** The create control is enabled only for a valid, non-colliding name. */
export function canCreateProfile(name: string, existing: readonly HermesProfileSummary[]): boolean {
  return validateProfileName(name, existing) === undefined;
}

/** Checks both the display name and derived slug against existing profiles. */
export function profileNameCollides(
  candidate: string,
  existing: readonly HermesProfileSummary[],
): boolean {
  const normalizedName = candidate.trim().toLowerCase();
  const slug = slugifyProfileName(candidate);
  return existing.some(
    (profile) =>
      profile.name.trim().toLowerCase() === normalizedName ||
      slugifyProfileName(profile.name) === slug,
  );
}

/** Returns the first free automatic name, beginning with Profile 2. */
export function nextNumberedProfileName(existing: readonly HermesProfileSummary[]): string {
  for (let index = 2; ; index += 1) {
    const candidate = `Profile ${index}`;
    if (!profileNameCollides(candidate, existing)) return candidate;
  }
}

/** Returns the first free copy name for the active profile. */
export function nextCopyProfileName(
  activeName: string,
  existing: readonly HermesProfileSummary[],
): string {
  const base = `${activeName} copy`;
  if (!profileNameCollides(base, existing)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base} ${index}`;
    if (!profileNameCollides(candidate, existing)) return candidate;
  }
}
