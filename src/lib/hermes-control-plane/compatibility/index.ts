/**
 * Hermes version compatibility matrix — the honest, machine-readable record of
 * what June actually does with the pinned Hermes runtime, plus the gate
 * `isHermesFeatureSupported` and the lookup `getFeatureStatus`.
 *
 * ```ts
 * import {
 *   isHermesFeatureSupported,
 *   getFeatureStatus,
 *   hermesCompatibilityMatrix,
 * } from "../lib/hermes-control-plane/compatibility";
 *
 * if (isHermesFeatureSupported("message")) {
 *   // safe: classified AND rendered today
 * }
 * getFeatureStatus("session.steer"); // "planned" until feature 06 ships UI
 * ```
 *
 * See `./matrix.ts` for the entries, their statuses, and the rationale each
 * status is held to. Downstream features flip their `"planned"`/`"partial"`
 * entries to `"supported"` when they ship UI + tests (see `OWNERSHIP`).
 */

export * from "./matrix";
export * from "./support";
