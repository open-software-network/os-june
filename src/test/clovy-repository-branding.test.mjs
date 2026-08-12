import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Clovy repository branding", () => {
  it("uses the canonical source repository in current public surfaces", () => {
    const currentSurfaces = [
      ".conductor/settings.toml",
      "CONTEXT.md",
      "README.md",
      "CONTRIBUTING.md",
      ".github/ISSUE_TEMPLATE/bug_report.yml",
      ".github/ISSUE_TEMPLATE/config.yml",
      ".github/ISSUE_TEMPLATE/feature_request.yml",
      "clovy-api/config.toml",
      "clovy-api/crates/api/src/handlers/verify.rs",
      "clovy-api/crates/config/src/lib.rs",
      "docs/desktop-release-runner.md",
      "docs/private-connectors-implementation-plan.md",
      "docs/release-extension.md",
      "docs/telemetry-p3a-implementation-plan.md",
      "scripts/check-cargo-release-age.py",
      "scripts/check-pnpm-release-age.py",
      "src/lib/p3a.ts",
    ].map(read);

    for (const source of currentSurfaces) {
      expect(source).not.toMatch(/open-software-network\/os-june(?!-releases)/);
    }
    expect(read(".conductor/settings.toml")).not.toContain("os-june Tauri desktop app");
    expect(read("docs/private-connectors-implementation-plan.md")).toContain(
      "**Repos:** `os-clovy`",
    );
    expect(read("docs/telemetry-p3a-implementation-plan.md")).toContain("desktop (os-clovy)");
    expect(read("README.md")).toContain(
      "git clone https://github.com/open-software-network/os-clovy",
    );
    expect(read("README.md")).not.toContain("clovy-demo.gif");
    expect(read("README.md")).not.toContain("https://june-api.opensoftware.co/verify");
    expect(read("README.md")).toContain("https://opensoftware.co/verify");
    for (const source of [
      read("README.md"),
      read("CONTRIBUTING.md"),
      read(".github/ISSUE_TEMPLATE/config.yml"),
      read(".github/ISSUE_TEMPLATE/feature_request.yml"),
      read("src/lib/tauri.ts"),
      read("src-tauri/src/commands.rs"),
    ]) {
      expect(source).not.toContain("https://t.me/osjune");
      expect(source).toContain("https://t.me/+B4Z8KUqEsRc4ZGVh");
    }
    expect(read("clovy-api/config.toml")).toContain(
      'source_repo_url = "https://github.com/open-software-network/os-clovy"',
    );
  });

  it("keeps release workflows valid across the source repository cutover", () => {
    const workflows = [
      ".github/workflows/production-desktop-windows.yml",
      ".github/workflows/promote-desktop.yml",
      ".github/workflows/rc-desktop-dmg.yml",
    ].map(read);

    for (const workflow of workflows) {
      expect(workflow).not.toContain("repositories: os-june,os-june-releases");
      expect(workflow).toContain(`\${{ github.event.repository.name }},os-june-releases`);
    }
    expect(workflows[1]).toContain(
      `"repos/\${GITHUB_REPOSITORY}/compare/\${SOURCE_COMMIT}...main"`,
    );
  });
});
