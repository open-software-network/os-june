# Focus

Focus is June's local time-intention workspace. It plans a bounded block of
work, records what actually happened, and keeps that history useful across
sleep, relaunch, and Project changes. The core does not call June API and does
not require an account balance, model request, or network connection.

The architectural decision is [ADR 0037](adr/0037-native-owned-focus-timeline.md).

## Product model

- A **Focus session** is one intention and its full lifecycle.
- A **Focus plan** is either one focus interval or an alternating sequence of
  focus and break intervals.
- A **Focus interval** is a planned focus or break duration.
- A **Focus segment** is an observed, timestamped span of focus, pause, break,
  or overtime. Use the qualified term because `segment` has another meaning in
  the audio pipeline.
- A session may be `planned`, `focusing`, `paused`, `overtime`, `on_break`,
  `completed`, or `abandoned`.

Only one session may be planned or active. The database enforces this invariant
globally, including races between the app, agent tools, and deep links.

### State transitions

| Current state | Action or boundary | Next state |
| --- | --- | --- |
| planned | Start | focusing |
| focusing | Pause | paused |
| paused | Resume | focusing |
| focusing or overtime | Start planned break | on_break |
| focusing | Planned time elapses | overtime |
| on_break | Break elapses | focusing on the next interval |
| any active state | Finish | completed |
| any active state | Abandon | abandoned |

Finishing early is explicit and remains visible as a shortened outcome.
Continuing after the planned focus duration is explicit overtime. Paused time
is excluded from focused time.

## Persistence and recovery

The schema is in `src-tauri/migrations/023_focus.sql`. The native repository
stores timestamps and derives durations when reading a session. It does not
write once per display tick.

Every active-lifecycle command reconciles elapsed boundaries before applying
its action. A native one-second scheduler does the same while June is open. If a Mac sleeps
through a break and the following focus interval, one reconciliation advances
through both boundaries and lands in overtime. If June is closed, reopening
the database and requesting status performs the same reconciliation.

Project UUIDs preserve relationships while Projects exist. Each planned
interval and observed Focus segment also stores a Project-name snapshot so a
past timeline remains readable after rename or deletion. A completed segment
can be reassigned or split at a strict interior timestamp; the total recorded
duration remains unchanged.

## App workspace

Focus is a primary sidebar destination with two views:

- **Focus** creates a single block or visible interval plan, chooses an
  intention, offers bounded duration presets and custom minutes, assigns each
  focus interval to an existing Project, and controls pause, resume, planned
  break, finish, or abandon.
- **History** filters by Project, shows planned and actual focus, pause, break,
  and overtime totals, edits reflection and quality, and supports split or
  Project reassignment on completed timeline segments.

The displayed clock ticks in React from the native snapshot timestamp. Native
transition events refresh the snapshot at boundaries. A pending-open handshake
ensures a cold-launch deep link reaches the Focus workspace after webview
listeners are registered.

## macOS Shortcuts

On macOS, Focus setup includes an optional **Start shortcut** selector populated
from the user's Shortcuts library. June stores the selected Shortcut name with
the local Focus plan and runs it once, after the session has successfully
entered `focusing`. It does not run again on pause, resume, breaks, wake, or
relaunch.

This supports workflows such as a user-authored Shortcut that enables a macOS
Focus mode, changes lighting, or starts another personal automation. June
invokes `/usr/bin/shortcuts` directly with the name as one argument; it neither
stores nor executes a shell command. If the Shortcut cannot be launched or
finishes unsuccessfully, the Focus session remains active and June shows an
actionable warning. The user can test and grant any required permissions by
running that Shortcut once in the Shortcuts app.

There is no automatic end Shortcut. A separate end action would need an
explicit product contract for finish versus abandon and for app termination.

### Open URL actions

Apple Shortcuts can use **Open URLs** with these exact routes:

```text
osjune://focus
osjune://focus/open
osjune://focus/start?minutes=25&intention=Write%20the%20draft
osjune://focus/start?minutes=50&project_id=PROJECT_UUID
osjune://focus/start?minutes=25&intervals=4&break_minutes=5&long_break_minutes=15
osjune://focus/pause
osjune://focus/resume
osjune://focus/break
osjune://focus/finish
osjune://focus/abandon
```

`start` accepts only `minutes`, `intention`, `project_id`, `intervals`,
`break_minutes`, and `long_break_minutes`; query keys must not repeat. Minutes,
interval counts, Project ids, and intention length are bounded before the
action is accepted. Values must be URL encoded. Unknown paths and parameters
are not treated as Focus actions, which keeps the existing OS Accounts
callback route unchanged. A failed action opens June and emits a local Focus
error instead of silently starting a second session.

These inbound actions use **Open URLs**, not native App Intents. They open June
and cannot return rich status values to a Shortcut. They are separate from the
outbound Start shortcut configured in Focus setup.

## June agent tools

The bundled `june_focus` MCP server exposes:

- `start_focus`
- `get_focus_status`
- `pause_focus`
- `resume_focus`
- `start_focus_break`
- `finish_focus`
- `abandon_focus`
- `list_focus_projects`

The agent may identify a Project by UUID or exact case-insensitive name. It
must ask when names are ambiguous and must not guess. The tool process has a
dedicated Focus proxy token. Focus tools are available to interactive June
sessions but are not in the routine cron allowlist, so a scheduled routine
cannot unexpectedly start or end a user's Focus session.

## Privacy and security

- `focus_sessions` stores intention, optional start Shortcut name, lifecycle
  status, created/started/ended timestamps, optional reflection, and optional
  quality. `focus_intervals` stores order, kind, planned duration, Project UUID,
  and Project-name snapshot. `focus_segments` stores observed kind, exact
  start/end timestamps, interval position, Project UUID, and Project-name
  snapshot.
- All of those fields stay in the local app database. Nothing in the Focus
  schema is sent to June API or another upstream service.
- The Focus command surface makes no June API request.
- June does not inspect a selected Shortcut's actions. Any network access or
  data sharing performed by that Shortcut is controlled by the user in the
  Shortcuts app.
- The Python MCP process holds no database path or broad provider token. It
  calls exact local loopback routes with a separate scoped token.
- Deep links accept a small, bounded schema and reuse the same native
  single-active-session invariant.
- Focus does not collect browser history, frontmost-app history, or blocking
  telemetry.

## Browser-site blocking assessment

The base used for this work (`origin/main` at `6f365121`) has no browser
extension or browser broker. The local `jakub/jun-278-integration` reference at
`d3e5b9d45ba959629fe621e69cdf6582a2801850` contains that foundation and ADR
0025, but it has not landed on this base. A remote refresh was attempted and
failed because GitHub rejected the available SSH key, so the integration
reference must be refreshed before its follow-up begins. Focus therefore does
not duplicate or partially merge the extension stack.

After that foundation lands, browser policy should be a separate, reversible
consumer of native Focus status:

1. Add a versioned broker message for the current Focus policy and a native
   subscription/event for changes.
2. Store user-chosen domain rules locally. Keep an explicit recovery allowlist
   for June, extension management, sign-in, and browser settings.
3. Let the paired extension enforce navigation only while the broker is
   authenticated and the session is actively focusing or in overtime.
4. Fail open when pairing or the broker is unavailable and show "Browser
   blocking unavailable" in June. Never imply enforcement while disconnected.
5. Keep policy active during pause by default unless the Blocker profile
   explicitly opts out, apply the profile's separate break behavior, and clear
   it synchronously on finish, abandon, or June shutdown.
6. Test direct navigation, redirects, existing tabs, private windows,
   extension disable/uninstall, broker restart, sleep, and browser crash.

This is intentionally an integration design, not shipped blocking. It should
be implemented on top of the landed broker so its authentication, release
pairing, and compatibility contract remain the single source of truth.

## macOS app-blocking feasibility

Strict app blocking is not feasible inside the current June desktop process
with the evidence available:

- The macOS 26.5 SDK installed on the build machine contains Family Controls
  and Managed Settings frameworks, but marks `ManagedSettingsStore` and the
  relevant consumer selection APIs as unavailable on macOS. The iOS shield
  model is therefore not a macOS enforcement path for June.
- Endpoint Security can authorize process-execution events, but requires a
  separately signed system extension and Apple's restricted entitlement. It
  would not prevent switching to a distracting app that is already running,
  so process execution alone does not satisfy the product promise.
- June's dictation helper observes frontmost-app changes and uses Accessibility
  for text insertion. Reusing Accessibility to hide, quit, or steal focus from
  apps would be bypassable and disruptive. It is friction, not strict blocking.

Relevant Apple references are [Family Controls entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.family-controls),
[Managed Settings UI](https://developer.apple.com/documentation/ManagedSettingsUI),
[Endpoint Security](https://developer.apple.com/documentation/endpointsecurity),
and [System Extensions](https://developer.apple.com/documentation/bundleresources/system-extensions).

No app-blocking toggle ships in this phase. A follow-up may prototype an
explicitly named **Friction mode** that warns and returns the user to June, but
must describe itself as bypassable. Any strict-mode proposal must first prove:

1. an API that covers launch and activation of already-running apps;
2. Developer ID distribution, entitlement approval, notarization, and update
   compatibility for the required extension;
3. a fail-safe disable path that cannot lock the user out of recovery tools;
4. behavior under extension crash, June crash, reboot, safe mode, and app
   rename or bundle-id changes;
5. an honest user-facing bypass matrix reviewed before implementation.

## Deliberate follow-ups

- Browser-site policy after JUN-278 lands and its broker contract is stable.
- A separately scoped, explicitly bypassable macOS Friction mode spike, only
  if user research supports it.
- A compact menu-bar Focus display after the existing agent-specific menu-bar
  contract is redesigned to host multiple independent lifecycles.

This desktop change needs no June API deploy.
