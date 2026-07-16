# Computer use support runbook

Computer use has independent gates: June's stored grant, the June API rollout
decision, macOS access for the signed helper, an active plan, a vision-capable
model, and a visible attended turn. Do not treat one as proof that the others
are enabled.

## State guide

| State | Meaning | Action |
| --- | --- | --- |
| `unsupported` | This is not macOS. | Computer use is not shipped on Windows. |
| `rollout_disabled` | June API disabled this app/macOS version, or the first safety decision could not be fetched. | Keep the grant revocable, check connectivity, then inspect June API's `[computer_use]` config. Do not bypass the gate. |
| `plan_required` | No active Pro/Max or compatible legacy paid subscription is cached. | Refresh the account or open View plans. An existing June grant can still be revoked. |
| `off` | The June grant is off. The helper may still have macOS grants. | Enable from Plugins or Settings after reading the permission explanation. |
| `driver_missing` | The signed app does not contain the pinned helper/stamp. | Reinstall or update June. Do not run an upstream installer. |
| `driver_mismatch` | The helper version does not match the repo pin. | Stop rollout and inspect the build provenance/SBOM. |
| `permission_missing` | Accessibility, Screen Recording, or the live capture probe is absent. | Use Continue to macOS access, then the separate Open settings links. |
| `model_unsupported` | The selected generation model lacks authoritative vision capability. | Choose a vision-capable model. |
| `ready` | Every runtime gate is satisfied. | Start an attended agent task. |
| `error` | The helper could not start, handshake, or probe. | Stop the task, inspect logs and signature, then run the self-test. |

## User recovery

1. Press Stop current task before changing permissions or reinstalling.
2. Confirm the intended helper exists in the installed app at
   `Contents/Resources/native/bin/June Computer Use Driver.app` and has bundle
   identifier `co.opensoftware.june.computer-use-driver`. A packaged helper
   also requires the signed outer June app with the same Developer ID team.
3. In System Settings > Privacy & Security, inspect Accessibility and Screen
   Recording separately. Removing a macOS grant may require June to be quit and
   reopened before macOS reports the new state.
4. Return to June. The setup page polls while incomplete and reconfigures the
   runtime when the signed helper becomes capturable.
5. If the driver crashed, Stop clears its private child and the next eligible
   task starts a new one. Never start an upstream daemon beside June.
6. If the target changed while a card waited, recapture it and ask June to
   propose the action again. A stale-action failure is expected safety behavior.

Turning the June switch off removes June's runtime grant and immediately stops
the task. It cannot silently remove macOS TCC entries; the user removes those
from System Settings.

## Build and release diagnosis

Run the deterministic gate after a normal macOS Rust build has signed the
staging helper:

```sh
pnpm computer-use:prepare
cargo build --manifest-path src-tauri/Cargo.toml --bin os-june --locked
pnpm computer-use:self-test
```

The gate checks the exact upstream commit, June helper source fingerprint,
bundle metadata, declared architecture slices, signature, SPDX SBOM, MIT
notice, direct-launch rejection, authenticated June-parent handshake, narrow
driver schemas, and June MCP schema. A schema failure means the pin cannot be
upgraded without reviewing `computer_use.rs`, `computer_use_driver.rs`, and
`cua-driver-contract.json` together.

After a signed universal app build, run the actual nested helper gate:

```sh
./scripts/computer-use-release-self-test.sh --live --target universal-apple-darwin
```

Live mode requires an interactive login plus Accessibility and Screen Recording
for the stable Developer ID helper. On a new desktop release runner, use the
same command with `--prompt-permissions` passed directly to
`computer-use-self-test.mjs`, approve the two macOS dialogs, then rerun without
prompting. macOS does not provide a supported command that fabricates these
user grants.

The live fixture runs through the real signed June executable's fixed QA host,
which accepts only the bundled helper and the two disposable fixture bundle
identifiers. It captures the target, clicks a numbered button while the observer
remains frontmost, verifies the real pointer and current-Space window flags did
not change, kills both fixtures, and exits the private driver. RC and stable
workflows run this before notarization. A failure blocks publication.

## OS update or regression

- Run the live fixture on the oldest and newest supported macOS releases.
- Recheck both TCC states after an OS update; a preflight `true` with live
  capture `false` is treated as missing permission.
- Record driver version, macOS version, operation class, and failure class only.
  Never attach the screenshot, AX tree, typed value, app title, or approval text
  to analytics or an issue without explicit user attachment.
- If focus, pointer, Space, target binding, or unapproved-mutation behavior
  regresses, stop the RC/stable workflow and keep the previous release live.
  Do not bypass the release self-test.

## Emergency rollout

June API's `[computer_use]` section supports:

```toml
[computer_use]
enabled = true
disabled_june_versions = ["0.0.33", "0.1.*"]
disabled_macos_versions = ["15.5.*"]
```

Entries are exact or use one trailing wildcard. After changing production
configuration, deploy June API and verify `/v1/computer-use/rollout` with the
affected `x-june-app-version` and `x-june-macos-version` headers. A desktop
that observes a disable stops active work and keeps that disable sticky if the
API subsequently becomes unavailable. The normal successful-decision cache is
five minutes.
