import { describe, expect, it } from "vitest";
import promoteWorkflow from "../../.github/workflows/promote-desktop.yml?raw";
import rcWorkflow from "../../.github/workflows/rc-desktop-dmg.yml?raw";
import architectureAudit from "../../scripts/audit-hermes-runtime.sh?raw";
import signedDmgBuilder from "../../scripts/build-signed-dmg.sh?raw";
import macBundler from "../../scripts/bundle-hermes-runtime.sh?raw";
import nativeImportSmoke from "../../scripts/hermes-native-import-smoke.py?raw";
import tauriBuild from "../../src-tauri/build.rs?raw";

function expectInOrder(source: string, needles: string[]) {
  let previous = -1;
  for (const needle of needles) {
    const index = source.indexOf(needle);
    expect(index, `missing release step: ${needle}`).toBeGreaterThan(previous);
    previous = index;
  }
}

describe("macOS Hermes universal runtime bundle", () => {
  it("installs complete target-qualified runtime trees for both architectures", () => {
    expect(macBundler).toContain("bundle_architectures=(arm64 x86_64)");
    expect(macBundler).toContain("python/$arch/current/bin/python3.11");
    expect(macBundler).toContain("site-packages/$arch");
    expect(macBundler).toContain("cpython-3.11-macos-$" + "{uv_arch}-none");
    expect(macBundler).toContain('--python-platform "$target"');
    expect(macBundler).toContain("--no-build");
    expect(macBundler).not.toContain("lockfile sync unavailable");
    expect(macBundler).not.toContain('pip install -p "$venv"');
    expect(macBundler).toContain("aarch64-apple-darwin");
    expect(macBundler).toContain("x86_64-apple-darwin");
  });

  it("selects the runtime from the executing architecture without unquoted paths", () => {
    expect(macBundler.match(/machine="\$\(\/usr\/bin\/uname -m\)"/g)).toHaveLength(2);
    expect(macBundler.match(/arm64\|x86_64\) ;;/g)?.length).toBeGreaterThanOrEqual(2);
    expect(macBundler.match(/exec "\$python"/g)).toHaveLength(2);
    expect(macBundler.match(/does not support architecture/g)).toHaveLength(2);
  });

  it("audits every native file against its owning tree and preserves provenance", () => {
    expect(architectureAudit).toContain("for arch in arm64 x86_64");
    expect(architectureAudit).toContain('find "$bundle" -type f -exec file -0 -N {} +');
    expect(architectureAudit).toContain("native library is not Mach-O");
    expect(architectureAudit).toContain("executable uses a non-macOS native format");
    expect(architectureAudit).toContain('lipo -archs "$candidate"');
    expect(architectureAudit).toContain('codesign --verify --strict "$candidate"');
    expect(architectureAudit).toContain("flags=.*runtime");
    expect(architectureAudit).toContain("bundle contains symlinks");
    expect(macBundler).toContain("printf 'arm64\\nx86_64\\n' > \"$out/ARCHITECTURES\"");
    expect(tauriBuild).toContain('const EXPECTED_MACOS_ARCHITECTURES: &str = "arm64 x86_64"');
  });

  it("executes the relocated Hermes and native dependency smoke tests for both CPUs", () => {
    expect(macBundler).toContain('for arch in "$' + '{bundle_architectures[@]}"');
    expect(macBundler).toContain('/usr/bin/arch "-$arch" "$@"');
    expect(macBundler).toContain("Install Rosetta 2 on the ARM release runner");
    expect(macBundler).toContain("cryptography.hazmat.bindings._rust");
    expect(macBundler).toContain("hermes_cli.main");
    expect(macBundler).toContain("pydantic_core");
    expect(macBundler).toContain("hermes-native-import-smoke.py");
    expect(nativeImportSmoke).toContain('site_packages.rglob("*.so")');
    expect(nativeImportSmoke).toContain("importlib.import_module(name)");
    expect(macBundler).toContain("hermes-approval-patch-smoke.py");
    expect(macBundler).toContain("from cron import jobs");
    expect(macBundler).toContain("--invalidation-mode checked-hash");
  });

  it("gates both release workflows and publishes one universal updater payload", () => {
    for (const workflow of [rcWorkflow, promoteWorkflow]) {
      expect(workflow).toContain("hermes-bundle-macos-universal-v2-");
      expect(workflow).toContain("./scripts/audit-hermes-runtime.sh");
      expect(workflow).toContain("--require-signed");
      expect(workflow).toContain('"darwin-aarch64": platform');
      expect(workflow).toContain('"darwin-x86_64": platform');
    }
    expect(signedDmgBuilder).toContain('computer_use_target="universal-apple-darwin"');
    expect(signedDmgBuilder).toContain(
      'pnpm computer-use:prepare -- "${computer_use_prepare_args[@]}"',
    );
    expect(signedDmgBuilder).toContain('--target "$computer_use_target"');
    expect(signedDmgBuilder).not.toContain('--target universal-apple-darwin "$@"');
    expect(signedDmgBuilder).toContain("audit-hermes-runtime.sh");
    expect(signedDmgBuilder).toContain("--require-signed");
  });

  it("validates notarization only after stapling the published DMG", () => {
    for (const releasePath of [rcWorkflow, promoteWorkflow, signedDmgBuilder]) {
      expectInOrder(releasePath, [
        'codesign --verify --deep --strict --verbose=2 "$app"',
        'xcrun notarytool submit "$dmg"',
        'xcrun stapler staple "$dmg"',
        'xcrun stapler validate "$dmg"',
        'spctl --assess --type install --verbose "$dmg"',
      ]);
      expect(releasePath).not.toContain('xcrun stapler validate "$app"');
      expect(releasePath).not.toContain('spctl --assess --type execute --verbose "$app"');
    }
  });
});
