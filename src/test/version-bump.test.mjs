import { describe, expect, it } from "vitest";
import {
  bumpVersionContents,
  currentVersionFromCargoToml,
  readCurrentVersion,
  validateRequestedVersion,
} from "../../scripts/bump-version.mjs";

const files = {
  tauriConf: '{\n  "productName": "OS Scribe",\n  "version": "0.1.0"\n}\n',
  cargoToml: '[package]\nname = "os-scribe"\nversion = "0.1.0"\n',
  packageJson: '{\n  "name": "os-scribe",\n  "version": "0.1.0"\n}\n',
};

describe("validateRequestedVersion", () => {
  it("accepts a valid higher version", () => {
    expect(validateRequestedVersion("0.1.0", "0.2.0")).toEqual({ ok: true });
  });

  it("rejects non-semver values", () => {
    expect(validateRequestedVersion("0.1.0", "0.2")).toEqual({
      ok: false,
      reason: 'Requested version "0.2" is not valid semver (expected X.Y.Z).',
    });
  });

  it("rejects equal and lower versions", () => {
    expect(validateRequestedVersion("0.1.0", "0.1.0").ok).toBe(false);
    expect(validateRequestedVersion("0.1.0", "0.0.9").ok).toBe(false);
  });

  it("rejects malformed versions", () => {
    expect(validateRequestedVersion("0.1.0", "01.2.3").ok).toBe(false);
    expect(validateRequestedVersion("0.1.0", "1.2.3-beta.1").ok).toBe(false);
  });
});

describe("bumpVersionContents", () => {
  it("updates all version-bearing files", () => {
    const next = bumpVersionContents(files, "0.2.0");

    expect(JSON.parse(next.tauriConf).version).toBe("0.2.0");
    expect(next.cargoToml).toContain('version = "0.2.0"');
    expect(JSON.parse(next.packageJson).version).toBe("0.2.0");
  });
});

describe("readCurrentVersion", () => {
  it("returns the shared version when all three files agree", () => {
    expect(readCurrentVersion(files)).toEqual({ ok: true, version: "0.1.0" });
  });

  it("rejects drift across the version-bearing files", () => {
    const drifted = {
      ...files,
      cargoToml: '[package]\nname = "os-scribe"\nversion = "0.1.1"\n',
    };
    expect(readCurrentVersion(drifted).ok).toBe(false);
  });
});

describe("currentVersionFromCargoToml", () => {
  it("reads the [package] version, not another table's version", () => {
    const cargo =
      '[workspace.package]\nversion = "9.9.9"\n\n[package]\nname = "os-scribe"\nversion = "0.1.0"\n';
    expect(currentVersionFromCargoToml(cargo)).toBe("0.1.0");
  });

  it("bumps the [package] version while leaving other tables untouched", () => {
    const cargo =
      '[workspace.package]\nversion = "9.9.9"\n\n[package]\nname = "os-scribe"\nversion = "0.1.0"\n';
    const next = bumpVersionContents({ ...files, cargoToml: cargo }, "0.2.0");
    expect(next.cargoToml).toContain('[workspace.package]\nversion = "9.9.9"');
    expect(next.cargoToml).toContain('[package]\nname = "os-scribe"\nversion = "0.2.0"');
  });
});
