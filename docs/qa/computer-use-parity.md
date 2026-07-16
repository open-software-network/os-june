# Computer use parity and acceptance matrix

Date: 2026-07-16
Scope: JUN-278 phase 2, JUN-288, JUN-293, JUN-296
Baseline: the attended macOS Computer Use experience documented for Codex on
2026-07-15.

This matrix defines parity by user outcome, not by reusing another product's
implementation. June deliberately applies stricter mutation and sensitive-data
policy where the PRD requires it.

## Outcome matrix

| Outcome | June behavior | Evidence and release gate |
| --- | --- | --- |
| Discover and enable | A top-level Plugins page contains a Computer use tile; Settings has a Computer use page backed by the same native grant. | `PluginsView`, `ComputerUseSettingsSection`, shared `ComputerUseControl`; component tests. |
| Understand access before prompts | The tile explains Accessibility, Screen Recording, selected-model routing, and that captures are not analytics before the explicit Continue action. Enabling the grant alone never opens a macOS prompt. | `computer-use-control.test.tsx`; manual first-run walkthrough. |
| Install safely | A June-owned helper is compiled from one exact upstream source commit. The upstream CLI, daemon, updater, full registry, and executable are not shipped. Universal builds merge arm64 and x86_64 slices, then sign and bundle the helper. | Git/Cargo pin, source fingerprint, SPDX SBOM, license, `prepare-cua-driver.mjs`, deterministic self-test. |
| Grant and inspect macOS access | Accessibility and Screen Recording are separate states with direct System Settings links. Readiness requires both preflight and a live ScreenCaptureKit probe for the helper identity. | Native status tests plus signed live release fixture. |
| Use a compatible model | The selected generation model must have authoritative vision capability. The current model and a Choose model action are shown. | Native readiness gate and component tests. |
| Meet plan eligibility | Computer use is available to active Pro and Max subscriptions; legacy paid subscriptions without a plan slug remain compatible. Education and revocation remain visible without an eligible plan. | Native plan tests and UI plan-gate test. |
| Choose a target app | June can list allowed running apps and select an exact app/window without raising it. June, terminals, security tools, and credential managers are omitted or rejected. | Broker allow/deny tests; live multi-window fixture. |
| Capture a bounded target | Capture addresses one exact process/window and returns a bounded AX tree plus the selected window image. Only the latest local capture remains, with private filesystem permissions. | Broker capture parsing, size/type/digest tests; signed live fixture. |
| Work in the background | Element actions use AX/background delivery; coordinates are window-local and posted to the target. The real pointer and frontmost app must not change. | Driver contract fixture; signed target/observer release test. Active-Space behavior is also checked in the manual support matrix. |
| Act across Mac apps | A task can recapture and retarget multiple allowed apps. Every target change is explicit and the next mutation requires a fresh action decision. | Broker target generation and stale-target tests; manual two-app walkthrough. |
| See the proposed action | Every mutating action appears in the always-mounted chat approval tray with target app, sanitized summary, expiry, and the relevant screenshot. | Approval registry and `ComputerUseApprovalsTray` component tests. |
| Approve or deny once | Each mutation has only Allow once, Deny, and Stop. There is no batch, Always allow, or autonomous option. | UI tests and Rust approval registry. |
| Prevent approval races | After approval, the exact window must still exist. Numbered controls must retain role and label; coordinate/key targets must retain the screenshot digest. | Stale capture and element tests. |
| Stop or take over | Stop immediately increments the task epoch, denies parked actions, kills the private driver child, clears the target/captures, and leaves the grant available for a later attended task. | Native stop semantics and live driver-exit test. |
| Stay attended | Only a turn submitted from visible June chat receives both the loopback token and a unique native run lease. A routine, manually named MCP server, restored background process, or task after Stop has no lease. | Hermes config tests, routine sanitization tests, native lease gate, app lifecycle integration. |
| Revoke | Turning the shared grant off performs the same stop path and removes the MCP server from the usable runtime. The UI explains that macOS TCC grants remain until removed in System Settings. | Shared grant integration and component tests. |
| Recover from permission/model changes | The UI polls while setup is incomplete. A real readiness transition reconfigures Hermes once; loss of readiness also stops active work. | Native runtime-readiness transition and UI polling behavior. |
| Recover from driver failure | A failed driver call discards and kills the child. The next eligible request starts a new private child; version/stamp mismatches fail closed. | Native lifecycle code, pin tests, self-test failure modes. |
| Keep routines out | The app-owned MCP server is never included in routine toolsets or earned-autonomy servers. | Rust config tests and `hermes-routines.test.ts`. |
| Stop a bad rollout | June API can disable the capability globally or for an exact/prefix June or macOS version. The desktop fails closed on its first unavailable decision and stops active work when readiness is lost. | API decision/unit and HTTP-boundary tests, desktop native gate, rollout UI test. |
| Ship only proven builds | RC and stable workflows require the pre-granted Mac Studio and run the signed capture/background-action fixture before notarization and publication. Staging also verifies the signed bundle and contract. | `computer-use-release-self-test.sh` and desktop release workflows. |

## Deliberately stricter than the baseline

- Every mutation requires a separate decision, not only actions classified as
  sensitive.
- June offers no Always allow, approve-all, or task-wide autonomous mode.
- Computer use cannot operate June itself, terminals, System Settings,
  keychains, password managers, installers, security agents, or other blocked
  administration surfaces.
- It cannot enter passwords, secrets, one-time codes, payment details, or use
  clipboard and destructive/system shortcuts.
- It is unavailable to routines, locked/background sessions, Windows, and
  models without vision support.
- Its helper rejects direct launch and requires a signed June parent plus a
  fresh in-memory initialization capability.
- It fails a delayed approval when the target image or control changed instead
  of guessing that the action is still safe.

These differences preserve the baseline outcomes of app selection, capture,
background control, visible progress, approval, stop/takeover, and revocation
while honoring June's accepted PRD.

## Implementation QA evidence

The implementation pass on 2026-07-16 exercised the real helper against two
signed disposable Mac app fixtures. The live test captured the background
target, clicked and typed through Accessibility, and verified that the
foreground app, pointer, physical key and modifier state, and active Space did
not change. The helper's direct-launch refusal, authenticated MCP handshake,
closed tool schemas, exact upstream pin, source fingerprint, universal
architectures, bundle metadata, and code signature were also checked.

The production React surface was then exercised in an isolated June QA app and
browser harness across `off`, `permission_missing`, `model_unsupported`,
`plan_required`, `driver_missing`, `rollout_disabled`, `unsupported`, and
`ready`. Both Allow once and Deny removed a parked approval without a batch or
persistent-approval path.

![Computer use ready state](./jun-278-computer-use-ready.png)

![Computer use macOS access state](./jun-278-computer-use-permissions.png)

![Computer use single-action approval](./jun-278-computer-use-approval.png)

## Required walkthrough before release

1. Start with the June grant off and both helper TCC grants absent. Confirm the
   switch shows education without prompting.
2. Enable the grant, choose Continue, deny each macOS prompt once, and verify
   the states remain distinct and the tool stays unavailable.
3. Grant both permissions to the signed helper and verify the UI becomes Ready
   without restarting June.
4. Use a supported vision model to list two fixture apps and capture the
   background target.
5. Propose an action, deny it, and verify the fixture did not change.
6. Propose again, allow once, and verify the target changes while the observer
   stays frontmost, the real pointer stays fixed, and the active Space does not
   change.
7. Park an action, change/close the target, then approve. Verify it fails stale.
8. Park an action and press Stop. Verify the card disappears, the child exits,
   the action does not run, and captures are removed.
9. Revoke the June grant during an active task. Verify the same stop behavior
   and that macOS permissions remain independently removable.
10. Repeat model mismatch, driver mismatch, helper crash, app quit, multiple
    windows, modal, menu, text, list, and scrolling cases on the oldest and
    newest supported macOS versions.

The deterministic and signed live fixtures are release blockers. The broader
manual matrix remains the RC dogfood gate because TCC denial UI, cross-Space
placement, and OS update behavior cannot be made reliable on ephemeral hosted
runners.
