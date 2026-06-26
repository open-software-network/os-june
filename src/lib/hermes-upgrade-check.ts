/**
 * Pure, dependency-free version-agreement check for the Hermes upgrade
 * checklist (feature 20). Given the matrix's `PINNED_HERMES_VERSION` and the
 * contents of the release docs, it returns the drift between them. The thin
 * release-gate script (`scripts/hermes-upgrade-check.ts`) supplies real file
 * reads; this module holds the logic so it is unit-tested in `src/test/`
 * without touching the filesystem (the same split the smoke test uses in
 * `hermes-smoke/helpers.ts`).
 *
 * The invariant it guards: a Hermes pin bump must move the matrix constant
 * (`compatibility/matrix.ts`), the pin note (`docs/hermes-upstream-v<version>.md`),
 * and the checklist (`docs/hermes-upgrade-checklist.md`) together. If any one
 * lags behind, June would claim support against a version it no longer pins.
 * This check makes that drift fail loudly instead of shipping silently.
 */

/** A `vX.Y.Z` Hermes pin string, e.g. `v2026.6.19`. The leading `v` is part of
 * the version June uses everywhere (matrix constant, pin-note filename). */
const HERMES_VERSION_RE = /^v\d+\.\d+\.\d+$/;

/** One doc the check inspects: a repo-relative filename and its full contents.
 * The script reads these; tests construct them in-memory. */
export type HermesUpgradeCheckDoc = {
  /** Repo-relative path, e.g. `docs/hermes-upgrade-checklist.md`. */
  filename: string;
  /** The whole file body, used for the "mentions the version" assertion. */
  contents: string;
};

export type HermesUpgradeCheckInput = {
  /** The matrix's `PINNED_HERMES_VERSION`, the source of truth to agree with. */
  matrixVersion: string;
  /** The release docs to check (pin note + checklist). */
  docs: HermesUpgradeCheckDoc[];
};

export type HermesUpgradeCheckResult = {
  /** True when no drift was found. */
  ok: boolean;
  /** The matrix version the check ran against, echoed for the script's output. */
  matrixVersion: string;
  /** One plain-language line per drift (sentence case, no dashes). Empty when
   * `ok`. */
  errors: string[];
};

/**
 * The repo-relative checklist path. The version-named pin note is derived per
 * version via `pinNoteFilenameFor`, so it is added by the script/tests rather
 * than hard-coded here.
 */
export const HERMES_UPGRADE_CHECKLIST_FILE =
  "docs/hermes-upgrade-checklist.md" as const;

/**
 * The version-agnostic doc filenames the check always requires, independent of
 * the current pin. The version-named pin note is added on top by the caller
 * (it depends on `matrixVersion`). The template
 * (`docs/hermes-upstream-template.md`) is deliberately NOT here: it ships
 * placeholders, so gating on a concrete version would make it always fail.
 */
export const HERMES_UPGRADE_CHECK_FILES: readonly string[] = [
  HERMES_UPGRADE_CHECKLIST_FILE,
];

/** The pin-note path June uses for a given version:
 * `docs/hermes-upstream-v<version>.md`. The argument already carries its `v`
 * prefix (e.g. `v2026.6.19`), matching `PINNED_HERMES_VERSION`. */
export function pinNoteFilenameFor(version: string): string {
  return `docs/hermes-upstream-${version}.md`;
}

/**
 * Checks that the matrix version, the pin note, and the checklist all name the
 * same Hermes version. Returns every drift it finds (not just the first) so an
 * operator can fix the whole set in one pass.
 *
 * Drift cases reported:
 * - the matrix version is not `vX.Y.Z` shaped;
 * - the pin note named for the matrix version is missing;
 * - a required doc never mentions the matrix version in its body.
 */
export function checkHermesVersionAgreement(
  input: HermesUpgradeCheckInput,
): HermesUpgradeCheckResult {
  const { matrixVersion, docs } = input;
  const errors: string[] = [];

  if (!HERMES_VERSION_RE.test(matrixVersion)) {
    errors.push(
      `Matrix version "${matrixVersion}" is not a valid pinned Hermes version (expected vX.Y.Z, e.g. v2026.6.19). Check PINNED_HERMES_VERSION in compatibility/matrix.ts.`,
    );
    // A malformed matrix version makes every downstream comparison meaningless,
    // so stop here with the single clear error.
    return { ok: false, matrixVersion, errors };
  }

  const byName = new Map(docs.map((doc) => [doc.filename, doc] as const));
  const pinNote = pinNoteFilenameFor(matrixVersion);
  const required = [...HERMES_UPGRADE_CHECK_FILES, pinNote];

  for (const filename of required) {
    const doc = byName.get(filename);
    if (!doc) {
      const hint =
        filename === pinNote
          ? ` Create it from docs/hermes-upstream-template.md for ${matrixVersion}.`
          : "";
      errors.push(`Required doc ${filename} is missing.${hint}`);
      continue;
    }
    if (!doc.contents.includes(matrixVersion)) {
      errors.push(
        `Doc ${filename} does not mention the pinned Hermes version ${matrixVersion}. Update it so the matrix, the pin note, and the checklist agree.`,
      );
    }
  }

  return { ok: errors.length === 0, matrixVersion, errors };
}
