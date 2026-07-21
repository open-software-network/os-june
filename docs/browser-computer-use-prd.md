# PRD: Browser use and computer use plugins

Status: accepted direction for JUN-278 (parent epic JUN-275).
Supersedes the JUN-229 scope proposal (PR #689, closed unmerged); that
document's surface inventory and gap analysis inform this PRD.
Date: 2026-07-13

**Division of authority.** Two documents describe Browser use, and each is
canonical for one half. They must never re-decide the other's half.

| | Canonical document |
| --- | --- |
| **Implementation**: tool contract and tool names, trust boundary, transports, policy, distribution mechanics, tests | **this document** |
| **Business**: ranking, positioning, packaging and pricing, success measures, strategic risks | [plugins/browser-use-prd.md](plugins/browser-use-prd.md) (portfolio, JUN-309) |

The portfolio also carries
[plugins/browser-use-implementation-plan.md](plugins/browser-use-implementation-plan.md)
and the Computer use pair
([prd](plugins/computer-use-prd.md), [plan](plugins/computer-use-implementation-plan.md));
those are summaries of this document, not a second source of truth. Where an
implementation detail disagrees, this document wins and the other is the bug.
Where a business detail disagrees, the portfolio PRD wins and this one is the
bug.

**Packaging (from the portfolio PRD, binding on this build).** Attended Browser
use is available on Hobby at launch, to maximize trust feedback. Routine
browsing (the managed transport) and higher automation limits are Pro. There is
no provider API fee; model and support cost set the final packaging. This is a
capability gate the app must actually enforce, not a marketing line, and it is
tracked as its own slice.

## Problem statement

June's agent can search the web and fetch a single page as markdown, but it
cannot operate anything. It cannot open a live page, keep page state, click a
control, fill a form, take a screenshot, or use a site the user is signed in
to. On the desktop it cannot touch other applications at all. Users hand June
a task and then do the interactive web or app work themselves. Assistant
products in June's category ship both capabilities, and the Plugins area
(JUN-275) needs launch plugins that show June acting, not just reading.

## Solution

Two plugins in the Plugins area, each a consent surface over an app-owned
capability. A plugin tile here is not a catalog install. Computer use is
managed from its Plugins tile; capability-specific in-chat requests and the
Browser use Settings toggle set their corresponding stored grants.

**Browser use (v1).** The user connects once by installing the June extension
in their own Chromium-family browser. June then works in visibly marked tabs
it opens itself, with the user's signed-in sessions available, and pauses for
approval before any consequential action (submit, send, publish, purchase,
delete). The user can hand June a specific open tab, approve all actions on
one site for one task, and stop or disconnect at any time. Sandboxed routines
get a separate, anonymous, June-managed headless browser that reaches the
public web only.

**Computer use (phase 2).** June operates Mac apps in the background without
stealing the cursor, keyboard focus, or the active Space, using a pinned macOS
driver implementation behind a June-bundled, signed helper and native policy
broker. The first access to each verified app requires one authorization for
the active task, and the capability requires a vision-capable model. June can
open a missing app by display name. A parked window is added automatically to
June's current Stage Manager group after that app authorization.

## User stories

1. As a June user, I want Browser use and Computer use as tiles in the
   Plugins area, so that I discover and enable capabilities where I expect
   them.
2. As a June user, I want connecting Browser use to walk me through
   installing the June extension, so that setup is one guided flow.
3. As a June user, I want the agent to ask for browser access in chat when it
   needs it, so that I can grant the capability at the moment of need.
4. As a June user, I want June to work in its own visibly marked tabs, so
   that I always know which tabs belong to the agent.
5. As a June user, I want my signed-in sessions available in June's task
   tabs, so that the agent can act on my sites without re-authentication.
6. As a June user, I want to hand June a specific open tab, so that it can
   help with the page I am already on.
7. As a June user, I want June never to read or act on my other open tabs,
   so that my own work stays mine.
8. As a June user, I want an approval card before June submits, sends,
   publishes, purchases, or deletes anything, so that nothing consequential
   happens without me.
9. As a June user, I want an "approve all on this site for this task"
   choice, so that a multi-step flow on one site does not stop on every
   click.
10. As a June user, I want June to never type into password, one-time code,
    or payment fields, so that my credentials stay mine even mid-task.
11. As a June user, I want a visible indicator that cannot be faked while
    the agent drives my browser, so that I can always tell automation is
    active.
12. As a June user, I want to stop the agent's browsing instantly, so that I
    stay in control.
13. As a June user, I want disconnecting the plugin to revoke everything, so
    that off means off.
14. As a June user, I want screenshots the agent took shown in chat, so that
    I can verify what it saw and did.
15. As a June user, I want the consent copy to say what page content leaves
    my device for inference, so that my decision is informed.
16. As a routine author, I want my scheduled routine to browse public pages,
    so that background jobs can collect what a one-shot fetch cannot.
17. As a routine author, I want the routine browser to be anonymous and
    ephemeral, so that unattended jobs never carry my sessions.
18. As a routine author, I want a clear failure message when no compatible
    browser is installed, so that I know how to fix the job.
19. As a June user, I want computer use to operate apps without stealing my
    cursor or focus, so that the agent and I can co-work on one machine.
20. As a June user, I want every desktop action the agent takes to require
    my approval, so that background control never surprises me.
21. As a June user, I want a clear notice when my model cannot drive
    computer use, so that I know to switch to a vision-capable model.
22. As a June user, I want macOS permission prompts explained before they
    appear, so that Accessibility and Screen recording requests are not
    alarming.
23. As a June developer, I want to load the extension unpacked with a stable
    id, so that local testing never waits on the store.
24. As a June user, I want June to open the requested Mac app when needed, so
    that a desktop task does not depend on me preparing its window first.
25. As a Stage Manager user, I want June to recognize a parked thumbnail and
    offer to bring that exact window forward, so that it never mistakes the
    shelf preview for my document.
26. As a June developer, I want the extension and app to negotiate protocol
    versions on connect, so that a store-updated extension against an older
    app fails cleanly with an update prompt instead of misbehaving.

## Implementation decisions

### Capability model and consent

- One stored Browser access grant with three fronts: the Plugins tile, a
  Settings toggle, and an in-chat request card (the agent emits a request
  token on its own line; June strips it and renders the card, the shipped
  Agent CLI access pattern).
- The `june_browser` MCP server is app-owned and internal: listed with the
  other internal servers so users cannot edit or remove it, and its config
  entry renders an explicit disabled state when the grant is off, because
  config deep-merge means omission would not reliably revoke.
- Granting restarts both runtime modes and retries the turn. A turn is
  retried only when its blocking call never executed (the request-card
  path); a grant change never re-issues a call that already ran. Parked
  consequential actions are journaled in the broker with a stable action id,
  and a retried turn resumes at the parked call instead of re-running
  completed ones, so enabling or revoking access cannot duplicate a
  submission.
- Revocation is an ordered handshake, not a teardown race: the broker first
  refuses new commands, then has the extension detach debugger control from
  every task tab and drop task markings, then invalidates the shim's socket
  credentials and any parked approvals, and only then terminates sessions
  and deletes ephemeral profiles. If the app or broker dies instead, the
  native-messaging disconnect is the extension's own signal to detach from
  all tabs and clear task state.
- The upstream runtime's own browser and computer-use toolsets stay disabled
  regardless of the grant; June exposes capability only through its own
  contract.

### One tool contract, two transports

- A single transport-agnostic `june_browser` contract: session start and
  close, navigate, snapshot (visible text plus interactive references that
  expire on navigation or mutation), click, fill, press, screenshot, back,
  and tab operations (list, open, switch, close, accept a user-shared tab).
- The tool names are canonical here, because two documents naming them
  differently is how the contract drifts:

  | Group | Tools |
  | --- | --- |
  | Session | `start_session`, `close_session` |
  | Navigation | `navigate`, `back` |
  | Perception | `snapshot`, `screenshot` |
  | Interaction | `click`, `fill`, `press` |
  | Tabs | `list_tabs`, `open_tab`, `switch_tab`, `close_tab`, `accept_shared_tab` |

  Verb first, matching every other internal June MCP server
  (`start_recording`, `generate_image`, `search_threads`, `get_meeting_note`).
  A tool declared here but not yet implemented fails cleanly; it never
  silently no-ops.
- The Rust browser broker is the choke point. Policy decisions are made in
  Rust, never by prompting the model (the connectors precedent): grant
  checks, consequential-action classification, approval parking, per-task
  site allows, URL policy, artifact storage as file references, session and
  process lifecycle.

### Attended track (the extension)

- A TypeScript MV3 extension drives the user's own Chromium-family browser.
  It acts only in task-owned tabs it creates (kept in a June-labeled tab
  group) and in tabs the user explicitly shares; pre-existing tabs are
  otherwise untouchable.
- Page actions run over per-tab debugger control: trusted input events,
  accessibility-tree snapshots with stable references, and viewport
  screenshots. The browser's own debugging banner doubles as the automation
  indicator, which the model cannot suppress. Content scripts are used only
  for overlay UI such as element highlights and the human-takeover banner.
- Transport: the browser launches a small signed native-messaging shim that
  ships inside the app; the store-enforced host manifest pins the extension
  identity. The shim relays to the broker over an authenticated local
  socket. Large payloads (screenshots, big snapshots) pass as file
  references, never inline, because host messages are size-capped. The
  connect handshake negotiates a protocol version; a mismatch surfaces an
  update prompt.
- Consequential actions (submit, send, publish, purchase, delete, and other
  state-committing operations on a signed-in site) park in the broker for a
  chat approval card, reusing the connector approval surface. The card also
  offers "approve all on this site for this task". A site is a normalized
  origin (scheme, host, and port; exact match, no subdomain or URL-prefix
  matching), evaluated by the broker against the canonicalized URL of the
  page performing the action. The allowance lives only in broker memory and
  is cleared on task completion, task cancellation, session close, revoke,
  and app exit; an action arriving after cleanup parks again. Nothing
  persistent is stored. Typing into password, one-time
  code, or payment fields is never automated; the user is asked to take
  over.
- Task tabs cannot open windows or escape their session. Declarative
  (`target=_blank`) and scripted (`window.open`) attempts triggered by a
  task action are refused or closed immediately, because a new window would
  sit outside the task-tab isolation the grant covers.
- Sharing a tab is a user gesture in the extension popup, never a model
  request: the popup mints a one-use share code, the user pastes it into
  chat, and the agent redeems it with `accept_shared_tab`. An unredeemed
  code grants nothing, and redeeming consumes it.
- User gestures that break the markings end ownership immediately: closing
  a task tab, detaching its debugger (for example from the debugging
  banner's cancel action), renaming the June group, or dragging a task tab
  out of it. The extension detaches, every later command against that tab
  fails as an explicit ownership error, and a shared tab's release is
  reported to the broker at once. The extension never re-attaches to a tab
  the user took back.

### Routines track (the managed browser)

- For sandboxed routines the broker launches a detected system
  Chromium-family browser (Chrome, then Edge, then Brave, then stock
  Chromium) headless with a fresh ephemeral profile under app-controlled
  temporary storage.
- Public-web-only policy enforced at connection time, not only at
  navigation: non-HTTP schemes, loopback, link-local, and private-network
  destinations are blocked. The broker resolves each hostname itself,
  validates every resolved address, and pins the browser to the validated
  addresses, so a hostname cannot pass the check publicly and then
  re-resolve to a private address when the browser connects (DNS
  rebinding). Redirects re-enter the same resolve-validate-pin path.
- Consequential-action classes are hard-blocked (nobody is present to
  approve), and browser access is a per-routine opt-in, not a global side
  effect of the attended grant.
- No compatible browser installed is an actionable failure in the routine
  result, and the plugin tile states the requirement up front. No browser
  engine is bundled.

### Failure semantics of the attended track

The attended track drives a live user browser, so its failure modes are
user-visible. Each rule below is a testable commitment.

- Transport loss ends automation. Browser exit or crash, shim death, an
  extension reload, or app or broker death drops the native port. The
  extension detaches from every task tab and clears its state; the broker
  ends the affected sessions and fails the active task. A reconnect is a
  new pairing with empty state; automation never resumes silently on a
  fresh connection.
- Session-restored tabs are orphaned, never re-adopted. After a browser
  restart, restored task tabs can still carry the June group label, but
  the extension's ownership registry is empty and it must not attach to
  them. v1 leaves closing them to the user.
- An extension update lands mid-session on the store's schedule, not
  June's. The update reloads the extension, which is transport loss under
  the rule above: the active task fails safely, and pairing resumes only
  after the version handshake passes. June prefers a failed task over
  continued control after an unattended update.
- Parked approvals die with their tab. A consequential action waiting on
  an approval card is bound to its tab; if that tab leaves the session
  (closed, detached, ungrouped) before the card resolves, the action is
  discarded and the approval resolves as not executed. It never executes
  against a restored or reused tab.
- The version handshake runs at connect time only; there is no mid-session
  re-negotiation. An app or extension update takes effect on the next
  connect, and both update paths converge on transport loss above. Unknown
  frames are dropped, never fatal, so a newer app does not crash an older
  extension worker. The mismatch prompt names the outdated side (update
  the app versus update the extension), because the two update on
  independent cadences.

### Extension distribution

- The extension lives in this repository as its own package, built with the
  existing toolchain; CI builds the store zip.
- Published on the Chrome Web Store under the Open Software verified
  publisher account with the listing name June. The privacy policy and the
  debugger-permission justification ship with the listing. Store review
  latency gates only public release: development and dogfooding load the
  built extension unpacked, and a pinned manifest key keeps the extension id
  stable so one native-messaging host manifest serves local and store
  builds. The load-extension command-line flag is blocked on branded stable
  Chrome, so scripted QA uses developer mode or a Chrome for Testing binary.
- The Chrome Web Store listing is the only v1 store presence. Brave
  installs from the same listing; stock Chromium loads the built package
  unpacked. The host manifest is registered for every supported browser,
  so pairing works wherever the extension is installed. The Edge install
  path is undecided and tracked under Open questions.
- A store-review rejection of the `debugger` permission holds the attended
  launch. The response is a revised submission with a stronger
  justification and privacy policy, never a reduced-permission build:
  per-tab debugger control is the accepted ADR 0017 mechanism, and an
  attended track without it is a redesign that needs its own ADR. Unpacked
  loading remains a development path and is not a consumer answer to a
  rejection.

### Computer use (phase 2)

- Productize the pinned runtime's macOS capture and input implementation behind
  June's private helper and Rust policy broker. The runtime receives only the
  single app-owned Computer use action surface, never the upstream registry or
  helper transport.
- Bundle a pinned, signed cua-driver as an app resource and point the
  runtime at it through its supported binary-path and version overrides; the
  upstream network installer never runs.
- TCC onboarding (Accessibility, Screen recording) follows the dictation
  helper pattern: bundle-scoped, prompting variant, polled re-checks.
- First app access parks in Rust and surfaces as a native June authorization
  card. The agent invokes the operation immediately and never asks for a
  textual approval. Authorization clears when the task ends.
- App lifecycle is narrow: background launch accepts only an app display name;
  current-stage restoration accepts only the exact PID and window selected and
  revalidated by Rust after app authorization. Paths, URLs, launch arguments,
  debug options, and arbitrary process activation are unavailable.
- The capability hard-requires a vision-capable model; otherwise the plugin
  is unavailable with a switch-model notice. Routines never get the toolset.
- A release self-test starts the bundled driver and fails the build if the
  private system interfaces it relies on break on a macOS update.

### Operability and privacy of the capability itself

These come from the portfolio PRD and implementation plan
([plugins/browser-use-prd.md](plugins/browser-use-prd.md),
[plugins/browser-use-implementation-plan.md](plugins/browser-use-implementation-plan.md))
and are recorded here because they are release-gating and no slice owned them:

- **Two kill switches, not one.** The attended transport (the extension) and
  the managed transport (the routines browser) fail in different ways and are
  operated by different people, so each gets its own remote disable. Killing
  the extension must not silently take routines down with it, and the reverse.
- **The capability logs nothing about what it saw.** No URLs, page text,
  screenshots, or field values in telemetry or logs. What a browsing session
  touched is exactly the material the user is trusting June with, and a log
  line is a copy of it outside the boundary the rest of this PRD builds.
- **The broker records outcomes; the model does not get to grade itself.** A
  task's declared outcome is recorded by the broker before execution and
  checked after, because the launch metric ("browser tasks with a verifiable
  outcome") is meaningless if the agent's own claim of success is the
  evidence. Approval events (parked, approved, declined) are counted; their
  contents are not.

Each of these is a slice that does not exist yet; they are tracked separately
rather than folded into an existing one.

### Naming

- User-facing names are "Browser use" and "Computer use" (sentence case),
  recorded in the domain glossary.

## Testing decisions

A good test exercises external behavior at a module seam, not implementation
detail. Prior art: the connector approval gating tests, the runtime
compatibility fixtures and live smoke test, and the existing internal MCP
server coverage.

Committed coverage:

- **Broker policy and approvals** (Rust): consequential-action
  classification, grant and consent gating, per-task site allows, and URL
  policy including the post-redirect re-check.
- **Native-messaging protocol** (both halves): version negotiation, framing,
  and the oversize-payload file-reference path, tested against the Rust shim
  and the TypeScript client.
- **Ownership and transport loss** (both halves): user tab close, user
  debugger detach, group rename or ungroup, extension reload, and browser
  or broker death each end ownership deterministically and fail in-flight
  and parked work, covered on the pairing state machine, the tab registry,
  and the broker's session teardown.
- **MCP schema fixtures**: `june_browser` joins the runtime compatibility
  fixtures and the live smoke test, at release-gate level like the existing
  internal servers.

Extension driver integration tests (fixture pages driven end to end) start
best-effort and are not a release gate in v1.

## Out of scope

- Computer use in v1; it is phase 2 of this PRD, sequenced after browser use
  ships.
- Windows and Linux; non-Chromium browsers; Chromium forks beyond Chrome,
  Edge, Brave, and stock Chromium.
- Persistent per-origin autonomy grants (acting on a site without asking,
  across tasks).
- Bundling a browser engine into the app.
- Persistent login state in the managed routine browser.
- Automating password, one-time code, or payment entry: permanently out,
  not deferred.
- Reading or acting on the user's pre-existing tabs without an explicit
  share.
- Multi-account or browser-profile management inside the extension.
- A reduced-permission attended build (for example content-script-only
  input) as a store-review fallback; an attended track without debugger
  control is a redesign, not a fallback.

## Open questions

Implementation in `extension/` and `src-tauri/` has already answered some
questions this document is silent on, and in places the two disagree. Per
the division of authority at the top, this document winning makes some of
these items code bugs; they are recorded here so the fix is a deliberate
decision, not silent drift in either direction.

- **The `status` tool.** The `june_browser` MCP server exposes a `status`
  tool (grant state and active-session count) that the canonical tool
  table above does not list. Decide: add it to the table, or remove it
  from the server.
- **`inspect_reference` and the `expected` re-check.** The broker and the
  extension exchange a fourteenth wire verb, `inspect_reference`, and the
  broker injects the inspected element facts as an `expected` argument
  into click, fill, and press so the extension refuses when the element
  changed since the snapshot. Neither the verb nor the mutation guard
  appears in this document. Decide: document the broker-to-extension wire
  vocabulary here as a layer distinct from the model-facing table, or
  extend the table.
- **The large-payload path.** This document says large payloads pass as
  file references, never inline, because host messages are size-capped.
  The extension instead streams base64 chunks over the native port for
  every artifact, and inlines snapshots below its chunk threshold; file
  references exist only between the broker and the model. Decide which
  description is normative and bring the other side in line.
- **Snapshot value redaction.** The extension masks value-control contents
  in snapshots (reported as filled or empty, never the text); this
  document defines a snapshot as visible text plus interactive references
  and is silent on redaction. Decide whether redaction is designed
  behavior, noting it aligns with the rule that the capability logs
  nothing about what it saw.
- **Share-code expiry.** A share code lives until it is redeemed, revoked,
  its tab closes, or the transport drops; there is no time expiry. Decide
  whether unredeemed offers expire.
- **Edge distribution.** The host manifest is registered for Edge, but the
  only store listing is the Chrome Web Store. Decide the Edge install
  path (installing from the Chrome Web Store versus a separate Edge
  Add-ons listing) before Edge support is claimed anywhere user-facing.
- **Multiple app instances.** Two running June instances (for example a
  stable and an rc build) race on the same host manifest and connection
  descriptor. Decide the v1 behavior: refuse a second pairing,
  last-writer-wins, or per-channel manifests.

## Further notes

- Sequencing: design-independent build starts now (extension, shim, broker,
  MCP contract, store submission, driver spike); the tile UI adopts the
  Plugins design foundation (JUN-276) when it lands; launch order respects
  the Google plugin gate (JUN-277). The store publisher account is the
  longest external dependency and should be filed as a blocking task
  immediately.
- Spike before phase-2 planning hardens: the bundled driver under the app's
  sandbox profile; its private-interface lookups may require the broker to
  spawn it outside the write jail, as the dictation helper already is.
- Automatic selection of a vision-capable model belongs to the model-router
  work (JUN-273) and is referenced, not depended on.
- ADR 0017 records the trust-boundary decision. JUN-229 and PR #689 are
  superseded by this PRD.
