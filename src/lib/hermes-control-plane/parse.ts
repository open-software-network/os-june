/**
 * Defensive parsing primitives shared across the Hermes control plane and the
 * features that read raw gateway payloads. Hermes payloads are `unknown` by
 * design (the gateway can add, rename, or drop fields between pins, and nests
 * vs hoists the same metric inconsistently), so every Hermes-aware parser needs
 * the same handful of "missing in, undefined out; never throw on junk" helpers.
 *
 * These used to be copy-pasted into a dozen modules. This is the ONE canonical
 * copy — import from here (or the `../hermes-control-plane` barrel) instead of
 * redefining them, so a tweak to the trimming/coercion rules lands everywhere.
 */

/** A non-empty trimmed string, or undefined. Accepts an already-narrowed
 * `string | undefined`; returns the trimmed value only when it has content. */
export function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** A non-empty trimmed string from an arbitrary `unknown`, or undefined.
 * The variant {@link pickString} builds on when scanning raw payload values,
 * and the right primitive when the input is not yet narrowed to a string. */
export function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** A plain object (not null, not an array) as a string-keyed record, or
 * undefined. The safe entry point before indexing into raw payload. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A finite number, or undefined. Rejects NaN, Infinity, strings, and the rest
 * so a bad wire value never renders as a real metric. */
export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** First finite number found across the given containers (checked in order)
 * under any of the given keys. Lets us read a metric whether the gateway nests
 * it (`usage.prompt_tokens`) or hoists it (`promptTokens`), in either case. */
export function pickNumber(
  containers: Array<Record<string, unknown> | undefined>,
  keys: string[],
): number | undefined {
  for (const container of containers) {
    if (!container) continue;
    for (const key of keys) {
      const found = finiteNumber(container[key]);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** First non-empty string found across the given containers (checked in order)
 * under any of the given keys. The string analogue of {@link pickNumber}. */
export function pickString(
  containers: Array<Record<string, unknown> | undefined>,
  keys: string[],
): string | undefined {
  for (const container of containers) {
    if (!container) continue;
    for (const key of keys) {
      const found = nonEmptyString(container[key]);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}
