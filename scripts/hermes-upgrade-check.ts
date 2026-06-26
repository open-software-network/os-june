#!/usr/bin/env node
// Run with: node --experimental-strip-types scripts/hermes-upgrade-check.ts
// (wired as `pnpm hermes:upgrade-check`). Node strips the TypeScript types at
// load time so this script imports the exact pure helper the Vitest unit tests
// cover (`src/lib/hermes-upgrade-check.ts`) and the single source-of-truth
// constant (`compatibility/matrix.ts`) instead of duplicating either.
//
// Release-gate version-agreement check for a Hermes pin bump (feature 20).
//
// It reads the matrix's PINNED_HERMES_VERSION and asserts the pin note
// (docs/hermes-upstream-v<version>.md) and the upgrade checklist
// (docs/hermes-upgrade-checklist.md) all name that same version. Any drift
// exits non-zero with a clear, per-doc message; a clean run prints the agreed
// version and the full upgrade checklist as a reminder of the manual steps the
// pin bump still requires (fixture replay, smoke test, matrix re-audit).
//
// It is the cheap, no-runtime complement to `pnpm test:hermes-smoke`: the smoke
// test proves the live runtime still speaks the protocol; this proves the docs
// and the matrix did not drift apart.
//
// Exit codes: 0 = the matrix, pin note, and checklist agree; 1 = drift (or a
// required doc could not be read).

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { PINNED_HERMES_VERSION } from "../src/lib/hermes-control-plane/compatibility/matrix.ts";
import {
  HERMES_UPGRADE_CHECKLIST_FILE,
  HERMES_UPGRADE_CHECK_FILES,
  checkHermesVersionAgreement,
  pinNoteFilenameFor,
  type HermesUpgradeCheckDoc,
} from "../src/lib/hermes-upgrade-check.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

main();

function main(): void {
  const pinNote = pinNoteFilenameFor(PINNED_HERMES_VERSION);
  const required = [...HERMES_UPGRADE_CHECK_FILES, pinNote];

  const docs: HermesUpgradeCheckDoc[] = [];
  for (const filename of required) {
    const absolute = resolve(REPO_ROOT, filename);
    // A missing file is left out of `docs` on purpose: the pure check reports
    // it as a missing required doc with the same wording as any other drift,
    // so the script does not need its own special case.
    if (existsSync(absolute)) {
      docs.push({ filename, contents: readFileSync(absolute, "utf8") });
    }
  }

  const result = checkHermesVersionAgreement({
    matrixVersion: PINNED_HERMES_VERSION,
    docs,
  });

  if (!result.ok) {
    console.error(
      `hermes:upgrade-check: FAILED. The matrix, pin note, and checklist do not agree on the Hermes version.`,
    );
    for (const error of result.errors) {
      console.error(`  - ${error}`);
    }
    console.error(
      `\nOn a Hermes pin bump, update all three together:\n` +
        `  1. PINNED_HERMES_VERSION in src/lib/hermes-control-plane/compatibility/matrix.ts\n` +
        `  2. the pin note ${pinNote} (copy docs/hermes-upstream-template.md)\n` +
        `  3. ${HERMES_UPGRADE_CHECKLIST_FILE}\n` +
        `Then re-run: pnpm hermes:upgrade-check`,
    );
    process.exit(1);
  }

  console.log(
    `hermes:upgrade-check: OK. Matrix, pin note, and checklist all agree on ${result.matrixVersion}.`,
  );
  console.log(
    `  matrix:    src/lib/hermes-control-plane/compatibility/matrix.ts`,
  );
  console.log(`  pin note:  ${pinNote}`);
  console.log(`  checklist: ${HERMES_UPGRADE_CHECKLIST_FILE}`);
  console.log(
    `\nReminder: the checklist's manual gates still apply on a pin bump:\n` +
      `  - pnpm test            (fixture replay, feature 05)\n` +
      `  - pnpm test:hermes-smoke (release-gate smoke, feature 17)\n` +
      `  - re-audit every compatibility matrix entry (feature 16)\n` +
      `See ${HERMES_UPGRADE_CHECKLIST_FILE} for the full list.`,
  );
  process.exit(0);
}
