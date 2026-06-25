/**
 * Query helpers over the {@link hermesCompatibilityMatrix}. These are the only
 * entry points feature code should use to ask "can June rely on X against the
 * pinned Hermes?" — they keep the honest semantics in one place.
 */

import {
  hermesCompatibilityMatrix,
  PINNED_HERMES_VERSION,
  type HermesCompatibilityStatus,
} from "./matrix";

/**
 * The status of a tracked surface (`feature`) for a given Hermes version.
 *
 * - Looks the key up across methods, events, and features (a flat name space;
 *   keys are unique across sections).
 * - An unrecognized key returns `"unknown"` — NOT a guess, and never
 *   `"supported"`.
 * - A `version` other than the current pin returns `"unknown"`: this matrix only
 *   vouches for the pinned runtime, so it refuses to speak for any other.
 *
 * @param feature matrix key, e.g. `"message"`, `"session.steer"`, `"imageEditing"`.
 * @param version Hermes version to check; defaults to the current pin.
 */
export function getFeatureStatus(
  feature: string,
  version: string = PINNED_HERMES_VERSION,
): HermesCompatibilityStatus {
  if (version !== hermesCompatibilityMatrix.hermesVersion) return "unknown";

  const entry =
    hermesCompatibilityMatrix.methods[feature] ??
    hermesCompatibilityMatrix.events[feature] ??
    hermesCompatibilityMatrix.features[feature];

  return entry ? entry.status : "unknown";
}

/**
 * True ONLY when June genuinely supports `feature` against the given Hermes
 * version — i.e. its status is exactly `"supported"`. Everything else
 * (`partial`, `planned`, `unsupported`, `unknown`, an unrecognized key, or a
 * non-pinned version) returns false. This is intentionally fail-closed: callers
 * gating behavior on it should under-promise, never over-promise.
 *
 * @param feature matrix key to check.
 * @param version Hermes version to check; defaults to the current pin.
 */
export function isHermesFeatureSupported(
  feature: string,
  version: string = PINNED_HERMES_VERSION,
): boolean {
  return getFeatureStatus(feature, version) === "supported";
}
