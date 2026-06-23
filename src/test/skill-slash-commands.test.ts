import { describe, expect, it } from "vitest";

import {
  displayedSkillInvocationText,
  explicitSkillInvocationPrompt,
  matchSkillSlashSuggestions,
  parseSkillSlashCommands,
  resolveSkillSlashCommands,
  skillSlashResolutionError,
} from "../lib/skill-slash-commands";
import type { HermesSkillDocument, HermesSkillInfo } from "../lib/tauri";

const skills: HermesSkillInfo[] = [
  {
    name: "repo-build-pr",
    description: "Build a branch and open a PR",
    enabled: true,
  },
  {
    name: "github:gh-address-comments",
    description: "Address GitHub review comments",
    enabled: true,
  },
  {
    name: "tools/gh-address-comments",
    description: "Address GitHub review comments from another source",
    enabled: true,
  },
  {
    name: "os-platform",
    description: "Query Open Software platform Issues",
    enabled: true,
  },
];

describe("skill slash commands", () => {
  it("extracts leading slash commands and leaves the user request", () => {
    expect(
      parseSkillSlashCommands(
        "  /repo-build-pr /os-platform implement issue JUN-46",
      ),
    ).toEqual({
      commandNames: ["repo-build-pr", "os-platform"],
      prompt: "implement issue JUN-46",
    });
  });

  it("resolves exact and qualified short names", () => {
    const resolutions = resolveSkillSlashCommands(
      ["repo-build-pr", "os-platform"],
      skills,
    );

    expect(resolutions).toMatchObject([
      { status: "resolved", skill: { name: "repo-build-pr" } },
      { status: "resolved", skill: { name: "os-platform" } },
    ]);
  });

  it("reports ambiguous short names with concrete choices", () => {
    const [resolution] = resolveSkillSlashCommands(
      ["gh-address-comments"],
      skills,
    );

    expect(resolution).toMatchObject({ status: "ambiguous" });
    expect(skillSlashResolutionError(resolution)).toBe(
      "/gh-address-comments matches more than one skill. Use /github:gh-address-comments, /tools/gh-address-comments.",
    );
  });

  it("offers nearby suggestions for missing skills", () => {
    const [resolution] = resolveSkillSlashCommands(["repo-build"], skills);

    expect(resolution).toMatchObject({ status: "missing" });
    expect(skillSlashResolutionError(resolution)).toBe(
      "Could not find skill /repo-build. Try /repo-build-pr.",
    );
  });

  it("ranks autocomplete suggestions by name and description", () => {
    expect(
      matchSkillSlashSuggestions("platform", skills).map((s) => s.name),
    ).toEqual(["os-platform"]);
    expect(
      matchSkillSlashSuggestions("review", skills).map((s) => s.name),
    ).toEqual(["github:gh-address-comments", "tools/gh-address-comments"]);
  });

  it("wraps skill documents and strips them back to the visible request", () => {
    const documents: HermesSkillDocument[] = [
      {
        name: "repo-build-pr",
        relativePath: "repo-build-pr/SKILL.md",
        content: "# Repo build PR\n\nOpen a draft PR.",
      },
    ];
    const wrapped = explicitSkillInvocationPrompt(
      documents,
      "implement issue JUN-46",
    );

    expect(wrapped).toContain("Skill: repo-build-pr");
    expect(wrapped).toContain("Open a draft PR.");
    expect(displayedSkillInvocationText(wrapped)).toBe(
      "implement issue JUN-46",
    );
  });

  it("does not strip ordinary messages that mention the marker strings", () => {
    const ordinary =
      "Explain this example:\n---USER REQUEST---\nhello\n---END USER REQUEST---";

    expect(displayedSkillInvocationText(ordinary)).toBe(ordinary);
  });
});
