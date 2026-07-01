import { describe, expect, it } from "vitest";
import {
  compareBuildVersion,
  isBuildVersion,
  setBuildVersionContents,
} from "../../scripts/set-build-version.mjs";

describe("isBuildVersion", () => {
  it("accepts plain releases and rc prereleases", () => {
    for (const version of ["0.0.25", "1.2.3", "0.0.25-rc.1", "1.2.3-rc.10"]) {
      expect(isBuildVersion(version)).toBe(true);
    }
  });

  it("rejects malformed or non-rc prerelease versions", () => {
    // dangling -rc, wrong channel, leading-zero rc number, partial semver,
    // v-prefix, trailing junk, empty — none may stamp an artifact version.
    for (const version of [
      "0.0.25-rc",
      "0.0.25-beta.1",
      "0.0.25-rc.01",
      "1.2",
      "v1.2.3",
      "0.0.25-rc.1-extra",
      "",
    ]) {
      expect(isBuildVersion(version)).toBe(false);
    }
  });
});

describe("setBuildVersionContents", () => {
  const files = {
    tauriConf: '{\n  "version": "0.0.24"\n}\n',
    cargoToml: '[package]\nname = "june"\nversion = "0.0.24"\n',
    packageJson: '{\n  "version": "0.0.24"\n}\n',
  };

  it("stamps an rc prerelease into all three version files", () => {
    const next = setBuildVersionContents(files, "0.0.25-rc.1");
    expect(JSON.parse(next.tauriConf).version).toBe("0.0.25-rc.1");
    expect(JSON.parse(next.packageJson).version).toBe("0.0.25-rc.1");
    expect(next.cargoToml).toContain('version = "0.0.25-rc.1"');
  });

  it("does not enforce monotonic increase (rc sorts below its base)", () => {
    // 0.0.24-rc.1 < 0.0.24, which bump-version.mjs would reject; here it's fine.
    const next = setBuildVersionContents(files, "0.0.24-rc.1");
    expect(JSON.parse(next.packageJson).version).toBe("0.0.24-rc.1");
  });

  it("throws on an invalid version rather than writing garbage", () => {
    expect(() => setBuildVersionContents(files, "1.2")).toThrow();
  });
});

describe("compareBuildVersion", () => {
  it("orders rc iterations of the same base", () => {
    expect(compareBuildVersion("0.0.25-rc.2", "0.0.25-rc.1")).toBe(1);
    expect(compareBuildVersion("0.0.25-rc.1", "0.0.25-rc.2")).toBe(-1);
    expect(compareBuildVersion("0.0.25-rc.10", "0.0.25-rc.9")).toBe(1);
  });

  it("treats a clean base as greater than its prereleases", () => {
    expect(compareBuildVersion("0.0.25", "0.0.25-rc.9")).toBe(1);
    expect(compareBuildVersion("0.0.25-rc.9", "0.0.25")).toBe(-1);
  });

  it("orders across bases before rc number", () => {
    expect(compareBuildVersion("0.0.26-rc.1", "0.0.25-rc.9")).toBe(1);
    // A lower base still loses even with a higher rc number.
    expect(compareBuildVersion("0.0.25-rc.9", "0.0.26-rc.1")).toBe(-1);
  });

  it("reports equality for identical versions", () => {
    expect(compareBuildVersion("0.0.25-rc.2", "0.0.25-rc.2")).toBe(0);
  });

  it("throws on an unparseable operand", () => {
    expect(() => compareBuildVersion("0.0.25-rc.2", "garbage")).toThrow();
  });
});
