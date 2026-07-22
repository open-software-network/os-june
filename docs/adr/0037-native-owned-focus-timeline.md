# ADR 0037: Native-owned Focus timeline

Status: accepted

## Context

June Focus has several entry points: the React workspace, `osjune://focus`
deep links used by Apple Shortcuts, and the embedded agent's local MCP server.
The state must survive webview reloads, app relaunches, and Mac sleep. A
JavaScript countdown cannot meet those requirements, and separate state
machines for each entry point would allow overlapping sessions and divergent
timelines.

Focus history also needs to remain understandable after a Project is renamed
or deleted. Browser and app restriction ideas add separate permissions,
distribution constraints, and failure modes; tying them to the timer would
make the reliable local core depend on optional platform integrations.

## Decision

- The Tauri Rust process owns Focus state and transitions. React displays a
  timestamped snapshot and derives the ticking clock locally; it does not own
  the countdown.
- SQLite stores sessions, plans, intervals, and timestamped Focus segments.
  Completed segments can be corrected through an atomic split or Project
  reassignment. A partial unique index enforces at most one planned or active
  session across every entry point.
- Elapsed values are derived from timestamps. June writes on lifecycle
  transitions, not every second.
- A native reconciliation loop and every command reconcile elapsed boundaries
  before acting. Sleep or relaunch may cross multiple interval boundaries;
  reconciliation advances through them deterministically and enters overtime
  when the current focus interval has elapsed.
- Overtime is an explicit state. June never silently completes a focus
  interval merely because its planned duration elapsed.
- Focus intervals store both the Project UUID and a name snapshot. Focus
  segments do the same, so history survives Project rename or deletion while
  still supporting current-Project filtering where the UUID remains valid.
- The UI, deep links, and `june_focus` MCP server call the same native command
  surface. The MCP server receives its own route-scoped loopback token and
  cannot use model, recorder, or connector routes.
- Browser-site policy and macOS app restriction are optional consumers of
  Focus state, not part of the core state machine. They require their own
  decisions after the relevant platform foundations and enforcement proofs
  exist.

## Consequences

Focus remains useful and accurate without network access, June API, Hermes,
browser extensions, or operating-system restriction privileges. Relaunch and
sleep recovery are testable with deterministic timestamps, while the database
constraint closes races between UI, agent, and Shortcuts entry points.

The native scheduler wakes once per second while June is running, but normally
writes only when a planned boundary is crossed. A closed app cannot deliver a
notification at the exact boundary; it reconciles immediately on relaunch and
shows the truthful current state.

Browser and app blocking are deliberately not claimed by this change. Shipping
either later requires a separately reviewable policy, permissions, recovery
path, and honest description of what can bypass it.
