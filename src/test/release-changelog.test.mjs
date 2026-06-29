import { describe, expect, it } from "vitest";
import {
  formatChangelog,
  parseGitLogRecords,
  parsePreviousReleaseLine,
  releaseNoteTitleForCommit,
} from "../../scripts/generate-release-changelog.mjs";

const field = "\x1f";
const record = "\x1e";

describe("parsePreviousReleaseLine", () => {
  it("extracts the release commit and version from the latest release subject", () => {
    expect(
      parsePreviousReleaseLine(`64be701${field}release: v0.0.22 (#508)`),
    ).toEqual({
      hash: "64be701",
      version: "0.0.22",
    });
  });

  it("ignores unrelated commits", () => {
    expect(
      parsePreviousReleaseLine(`b1fc9eb${field}Fix system audio (#511)`),
    ).toBeUndefined();
  });
});

describe("parseGitLogRecords", () => {
  it("parses git log records separated by control characters", () => {
    expect(
      parseGitLogRecords(
        [
          `abc123${field}Fix updater notes (#1)${field}`,
          `def456${field}Merge pull request #2 from branch${field}Add the feature`,
        ].join(record),
      ),
    ).toEqual([
      {
        hash: "abc123",
        subject: "Fix updater notes (#1)",
        body: "",
      },
      {
        hash: "def456",
        subject: "Merge pull request #2 from branch",
        body: "Add the feature",
      },
    ]);
  });
});

describe("releaseNoteTitleForCommit", () => {
  it("uses squash commit subjects directly", () => {
    expect(
      releaseNoteTitleForCommit({
        hash: "abc123",
        subject: "Fix system audio permission refresh (#511)",
        body: "",
      }),
    ).toBe("Fix system audio permission refresh (#511)");
  });

  it("uses merge commit body titles with the PR number", () => {
    expect(
      releaseNoteTitleForCommit({
        hash: "abc123",
        subject: "Merge pull request #476 from open-software-network/topic",
        body: "\nAllow short onboarding practice replies\n",
      }),
    ).toBe("Allow short onboarding practice replies (#476)");
  });

  it("omits release commits", () => {
    expect(
      releaseNoteTitleForCommit({
        hash: "abc123",
        subject: "release: v0.0.22 (#508)",
        body: "",
      }),
    ).toBeUndefined();
  });
});

describe("formatChangelog", () => {
  it("formats a release changelog from commit titles", () => {
    expect(
      formatChangelog({
        version: "0.0.23",
        previousVersion: "0.0.22",
        commits: [
          {
            hash: "b1fc9eb",
            subject: "Fix system audio permission refresh (#511)",
            body: "",
          },
          {
            hash: "d164dc7",
            subject: "Update Conductor env setup (#512)",
            body: "",
          },
        ],
      }),
    ).toBe(
      [
        "## June v0.0.23",
        "",
        "Changes since v0.0.22.",
        "",
        "### Changes",
        "- Fix system audio permission refresh (#511)",
        "- Update Conductor env setup (#512)",
        "",
      ].join("\n"),
    );
  });

  it("keeps releases with no source changes explicit", () => {
    expect(
      formatChangelog({
        version: "0.0.23",
        previousVersion: "0.0.22",
        commits: [],
      }),
    ).toContain("- No source changes recorded since the previous release.");
  });
});
