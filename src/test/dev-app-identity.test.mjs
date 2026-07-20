import { describe, expect, it } from "vitest";
import { devAppIdentityForBranch } from "../../scripts/dev-app-identity.mjs";

describe("development app identity", () => {
  it("names a Codex issue branch with its issue and harness suffix", () => {
    expect(devAppIdentityForBranch("codex/jun-278-computer-use")).toEqual({
      productName: "June JUN-278 Codex",
      identifier: "co.opensoftware.june.codex.jun278",
    });
  });

  it("normalizes the issue key while preserving its numeric identity", () => {
    expect(devAppIdentityForBranch("codex/fix-JUN-00278-permissions")).toEqual({
      productName: "June JUN-00278 Codex",
      identifier: "co.opensoftware.june.codex.jun00278",
    });
  });

  it("supports Claude issue worktrees without conflating their identity", () => {
    expect(devAppIdentityForBranch("claude/jun-278-computer-use")).toEqual({
      productName: "June JUN-278 Claude",
      identifier: "co.opensoftware.june.claude.jun278",
    });
  });

  it.each([
    "main",
    "codex/refactor-dev-launch",
    "jakub/jun-278-integration",
    "",
  ])("keeps the normal identity for %s", (branch) => {
    expect(devAppIdentityForBranch(branch)).toEqual({
      productName: "June",
      identifier: "co.opensoftware.june",
    });
  });
});
