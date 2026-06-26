import { describe, expect, it } from "vitest";
import {
  HERMES_UPGRADE_CHECK_FILES,
  checkHermesVersionAgreement,
  pinNoteFilenameFor,
  type HermesUpgradeCheckDoc,
} from "../lib/hermes-upgrade-check";
import { PINNED_HERMES_VERSION } from "../lib/hermes-control-plane/compatibility";

const PIN = "v2026.6.19";

// The doc filenames the release-gate check (scripts/hermes-upgrade-check.ts)
// reads and asserts agree with the matrix. Kept here so the unit test is the
// contract, not the script.
const CHECKLIST = "docs/hermes-upgrade-checklist.md";
const TEMPLATE = "docs/hermes-upstream-template.md";

/** Build a doc set that all honestly agrees on `version`, so a test can then
 * mutate one entry to force a single, isolated drift. */
function agreeingDocs(version: string): HermesUpgradeCheckDoc[] {
  return [
    {
      filename: pinNoteFilenameFor(version),
      contents: `# Hermes upstream ${version}\n\nNew June pin: \`${version}\`\n`,
    },
    {
      filename: CHECKLIST,
      contents: `# Hermes upgrade checklist\n\n## Version\n\nPinned Hermes version: \`${version}\`\n`,
    },
  ];
}

describe("pinNoteFilenameFor — derives the pin-note path from a version", () => {
  it("builds docs/hermes-upstream-v<version>.md", () => {
    expect(pinNoteFilenameFor(PIN)).toBe("docs/hermes-upstream-v2026.6.19.md");
  });
});

describe("HERMES_UPGRADE_CHECK_FILES — the version-agnostic doc contract", () => {
  it("requires the checklist", () => {
    expect(HERMES_UPGRADE_CHECK_FILES).toContain(CHECKLIST);
  });

  it("does not hard-code the version-named pin note (it is derived per pin)", () => {
    // The pin note path depends on the current version, so the static list must
    // not pin it; the drift check adds pinNoteFilenameFor(matrixVersion) itself
    // (covered by the missing-doc and filename-mismatch cases below).
    expect(HERMES_UPGRADE_CHECK_FILES).not.toContain(pinNoteFilenameFor(PIN));
  });

  it("does not gate on the template (it is version-agnostic)", () => {
    // The template ships placeholders, not a concrete pin, so it must never be
    // a version-agreement input or the check would always fail on it.
    expect(HERMES_UPGRADE_CHECK_FILES).not.toContain(TEMPLATE);
  });
});

describe("checkHermesVersionAgreement — drift detection", () => {
  it("passes when the matrix, the pin note, and the checklist all agree", () => {
    const result = checkHermesVersionAgreement({
      matrixVersion: PIN,
      docs: agreeingDocs(PIN),
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.matrixVersion).toBe(PIN);
  });

  it("flags a pin note whose filename does not match the matrix version", () => {
    // The matrix moved to a new pin but the note for it is missing: the only
    // present note is named for the OLD version.
    const result = checkHermesVersionAgreement({
      matrixVersion: "v2026.7.1",
      docs: [
        {
          filename: pinNoteFilenameFor(PIN), // old note still present
          contents: `# Hermes upstream ${PIN}\n\nNew June pin: \`${PIN}\`\n`,
        },
        {
          filename: CHECKLIST,
          contents: `## Version\n\nPinned Hermes version: \`v2026.7.1\`\n`,
        },
      ],
    });
    expect(result.ok).toBe(false);
    // The expected note path is reported so the operator knows what to add.
    expect(result.errors.join("\n")).toContain(
      "docs/hermes-upstream-v2026.7.1.md",
    );
  });

  it("flags a checklist that does not mention the matrix version", () => {
    const docs = agreeingDocs(PIN);
    const checklist = docs.find((d) => d.filename === CHECKLIST);
    if (!checklist) throw new Error("test setup: checklist doc missing");
    checklist.contents = "# Hermes upgrade checklist\n\nno version here\n";
    const result = checkHermesVersionAgreement({ matrixVersion: PIN, docs });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain(CHECKLIST);
    expect(result.errors.join("\n")).toContain(PIN);
  });

  it("flags a pin note present but not mentioning its own version inside", () => {
    // A note whose filename matches but whose body never states the pin (a
    // copy-paste-from-template slip) is still drift.
    const result = checkHermesVersionAgreement({
      matrixVersion: PIN,
      docs: [
        {
          filename: pinNoteFilenameFor(PIN),
          contents: "# Hermes upstream vX.Y.Z\n\nNew June pin: `vX.Y.Z`\n",
        },
        {
          filename: CHECKLIST,
          contents: `## Version\n\nPinned Hermes version: \`${PIN}\`\n`,
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain(pinNoteFilenameFor(PIN));
  });

  it("flags a missing required doc rather than silently passing", () => {
    // Only the checklist is provided; the pin note is absent entirely.
    const result = checkHermesVersionAgreement({
      matrixVersion: PIN,
      docs: [
        {
          filename: CHECKLIST,
          contents: `## Version\n\nPinned Hermes version: \`${PIN}\`\n`,
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain(pinNoteFilenameFor(PIN));
  });

  it("rejects a matrix version that is not vX.Y.Z shaped", () => {
    const result = checkHermesVersionAgreement({
      matrixVersion: "2026.6.19", // missing leading v
      docs: agreeingDocs("2026.6.19"),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n").toLowerCase()).toContain("version");
  });

  it("collects every drift, not just the first", () => {
    // Both docs are wrong at once: the result must list both, so an operator
    // fixes the whole set in one pass.
    const result = checkHermesVersionAgreement({
      matrixVersion: PIN,
      docs: [
        {
          filename: pinNoteFilenameFor(PIN),
          contents: "no version anywhere",
        },
        {
          filename: CHECKLIST,
          contents: "no version anywhere either",
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("agrees with the real shipped matrix constant", () => {
    // Guards against the test pinning a stale literal: the real exported
    // constant must be the version the agreeing-docs helper builds against.
    expect(PINNED_HERMES_VERSION).toBe(PIN);
  });
});
