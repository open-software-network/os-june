# PRD: Browser use and computer use plugins

Status: accepted direction for JUN-278 (parent epic JUN-275).
Supersedes the JUN-229 scope proposal (PR #689, closed unmerged); that
document's surface inventory and gap analysis inform this PRD.
Date: 2026-07-13

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
capability. A plugin tile here is not a catalog install: enabling the tile,
the Settings toggle, or the in-chat request card all set one stored grant.

**Browser use (v1).** The user connects once by installing the June extension
in their own Chromium-family browser. June then works in visibly marked tabs
it opens itself, with the user's signed-in sessions available, and pauses for
approval before any consequential action (submit, send, publish, purchase,
delete). The user can hand June a specific open tab, approve all actions on
one site for one task, and stop or disconnect at any time. Sandboxed routines
get a separate, anonymous, June-managed headless browser that reaches the
public web only.

**Computer use (phase 2).** June operates Mac apps in the background without
stealing the cursor, keyboard focus, or the active Space, using the pinned
agent runtime's computer-use toolset backed by a June-bundled, pinned, signed
driver. Every mutating action requires approval, and the capability requires
a vision-capable model.

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
24. As a June developer, I want the extension and app to negotiate protocol
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
- Granting or revoking restarts both runtime modes and retries the turn;
  revoking also terminates all browser sessions and deletes ephemeral
  profiles.
- The upstream runtime's own browser and computer-use toolsets stay disabled
  regardless of the grant; June exposes capability only through its own
  contract.

### One tool contract, two transports

- A single transport-agnostic `june_browser` contract: session start and
  close, navigate, snapshot (visible text plus interactive references that
  expire on navigation or mutation), click, fill, press, screenshot, back,
  and tab operations (list, open, switch, close, accept a user-shared tab).
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
  offers "approve all on this site for this task"; that allowance dies with
  the task and nothing persistent is stored. Typing into password, one-time
  code, or payment fields is never automated; the user is asked to take
  over.

### Routines track (the managed browser)

- For sandboxed routines the broker launches a detected system
  Chromium-family browser (Chrome, then Edge, then Brave, then stock
  Chromium) headless with a fresh ephemeral profile under app-controlled
  temporary storage.
- Public-web-only policy: non-HTTP schemes, loopback, link-local, and
  private-network destinations are blocked before navigation and re-checked
  after redirects.
- Consequential-action classes are hard-blocked (nobody is present to
  approve), and browser access is a per-routine opt-in, not a global side
  effect of the attended grant.
- No compatible browser installed is an actionable failure in the routine
  result, and the plugin tile states the requirement up front. No browser
  engine is bundled.

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

### Computer use (phase 2)

- Productize the pinned runtime's computer-use toolset rather than building
  an executor: it already provides background control (events posted to the
  target process, no cursor or focus theft), element-indexed captures, an
  accessibility-only mode, and built-in approval hooks on every mutating
  action.
- Bundle a pinned, signed cua-driver as an app resource and point the
  runtime at it through its supported binary-path and version overrides; the
  upstream network installer never runs.
- TCC onboarding (Accessibility, Screen recording) follows the dictation
  helper pattern: bundle-scoped, prompting variant, polled re-checks.
- Runtime action approvals surface as June chat approval cards.
- The capability hard-requires a vision-capable model; otherwise the plugin
  is unavailable with a switch-model notice. Routines never get the toolset.
- A release self-test starts the bundled driver and fails the build if the
  private system interfaces it relies on break on a macOS update.

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
