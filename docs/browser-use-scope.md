# Browser use scope

Status: proposed scope for JUN-229 v1
Date: 2026-07-10

## Recommendation

Ship a June-owned `june_browser` internal MCP server backed by a token-gated
June browser broker and a pinned local automation runtime. Keep it off by
default. Enable it only through a new Browser access setting or an in-chat
`[REQUEST:BROWSER_ACCESS]` approval card. V1 should use a visible, dedicated,
ephemeral browser profile and expose one stateful page with navigation, a text
snapshot, click, fill, screenshot, and close operations.

This is the smallest product surface that closes the core interaction gap while
keeping consent, profile isolation, process lifecycle, and packaging under
June's control. A catalog-installed server and a directly exposed browser CLI
remain useful prototyping paths, but neither should be the shipping trust
boundary.

## Research basis

The baseline below is capability-based, not a comparison of named products.
It is grounded in the following primary sources:

- The [WebDriver standard](https://www.w3.org/TR/webdriver2/) defines navigation,
  browsing contexts, element discovery, click, clear and send-keys interaction,
  cookies, user prompts, and screenshots.
- [WebDriver BiDi](https://w3c.github.io/webdriver-bidi/) adds bidirectional
  browsing-context lifecycle, navigation events, context creation and switching,
  screenshots, input, storage, and network events.
- The [MCP specification's security principles](https://modelcontextprotocol.io/specification/2025-03-26/index#security-and-trust--safety)
  require explicit user consent and control over data access and tool actions.
- Browser [profile documentation](https://chromium.googlesource.com/chromium/src/+/main/docs/user_data_dir.md)
  identifies history, bookmarks, and cookies as profile data and documents a
  separate user-data directory. Current [remote-debugging security guidance](https://developer.chrome.com/blog/remote-debugging-port/)
  likewise recommends a non-default data directory to isolate automation from a
  real profile.
- The exact [pinned Hermes source documentation](https://github.com/NousResearch/hermes-agent/blob/2bd1977d8fad185c9b4be47884f7e87f1add0ce3/website/docs/user-guide/features/browser.md)
  describes an upstream browser toolset and local CLI-backed mode. June does not
  currently expose that mode as a supported June capability: its agent web
  contract remains the two-tool `june_web` surface
  ([`src-tauri/src/hermes_bridge.rs:173-179`](../src-tauri/src/hermes_bridge.rs#L173-L179)).

## Current surface inventory

### Read-only web access

June tells every Hermes runtime that `june_web` contains exactly `web_search`
and `web_fetch`: search returns current results and fetch reads one URL as
markdown ([`src-tauri/src/hermes_bridge.rs:173-179`](../src-tauri/src/hermes_bridge.rs#L173-L179)).
The MCP server's complete tool declaration contains only those two tools
([`src-tauri/src/hermes/june_web_mcp.py:33-83`](../src-tauri/src/hermes/june_web_mcp.py#L33-L83)),
and its dispatcher rejects every other tool name
([`src-tauri/src/hermes/june_web_mcp.py:170-181`](../src-tauri/src/hermes/june_web_mcp.py#L170-L181)).

The server is a standard-library Python process that calls a loopback proxy;
the Rust host adds the user's access token before forwarding to June API, so the
MCP process does not hold that account credential
([`src-tauri/src/hermes/june_web_mcp.py:1-12`](../src-tauri/src/hermes/june_web_mcp.py#L1-L12)).
June writes the script into app data at spawn
([`src-tauri/src/hermes_bridge.rs:6528-6541`](../src-tauri/src/hermes_bridge.rs#L6528-L6541))
and registers it as an enabled built-in MCP server with a per-spawn loopback URL
and environment token
([`src-tauri/src/hermes_bridge.rs:6996-7020`](../src-tauri/src/hermes_bridge.rs#L6996-L7020)).

This surface is retrieval, not browser automation. June's agent cannot
navigate a live page, retain page state, click an element, fill a form, operate
tabs, or take a screenshot today. The exhaustive `june_web` schema and dispatcher
have no such operation
([`src-tauri/src/hermes/june_web_mcp.py:33-83`](../src-tauri/src/hermes/june_web_mcp.py#L33-L83),
[`src-tauri/src/hermes/june_web_mcp.py:170-181`](../src-tauri/src/hermes/june_web_mcp.py#L170-L181)).

### Agent CLI access and the sandbox

Sandboxed Hermes sessions run under a macOS Seatbelt profile. The profile starts
from broad process rights, denies all writes, regrants app-owned roots, and is
inherited by subprocesses
([`src-tauri/src/hermes_bridge.rs:6301-6332`](../src-tauri/src/hermes_bridge.rs#L6301-L6332)).
Reads remain broad except for an explicit credential-store denylist
([`src-tauri/src/hermes_bridge.rs:6399-6415`](../src-tauri/src/hermes_bridge.rs#L6399-L6415)).

Selected coding CLIs need writable state directories to start, retain sessions,
and refresh logins. June keeps those writes off by default and grants the named
state directories only after the Agent CLI access opt-in
([`src-tauri/src/hermes_bridge.rs:240-248`](../src-tauri/src/hermes_bridge.rs#L240-L248),
[`src-tauri/src/hermes_bridge.rs:6357-6378`](../src-tauri/src/hermes_bridge.rs#L6357-L6378)).
The Settings surface exposes that opt-in and explains that the affected folders
configure software which also runs outside June's sandbox
([`src/components/settings/AgentSettingsSection.tsx:340-377`](../src/components/settings/AgentSettingsSection.tsx#L340-L377)).

When blocked, the agent emits `[REQUEST:AGENT_CLI_ACCESS]`; June strips the token
and renders an approval card instead
([`src/lib/agent-cli-access.ts:1-20`](../src/lib/agent-cli-access.ts#L1-L20)).
Approval persists the setting, retires the sandboxed runtime, and submits a retry
message on the new runtime
([`src/components/agent/AgentWorkspace.tsx:6776-6793`](../src/components/agent/AgentWorkspace.tsx#L6776-L6793)).
The card describes the grant and offers Enable or Not now
([`src/components/agent/AgentWorkspace.tsx:11779-11833`](../src/components/agent/AgentWorkspace.tsx#L11779-L11833)).

Agent CLI access is a strong consent pattern to reuse, but it is not browser
consent. Its current grant is limited to coding-CLI state paths
([`src-tauri/src/hermes_bridge.rs:277-301`](../src-tauri/src/hermes_bridge.rs#L277-L301)),
and June explicitly tells the agent that interactive browser login flows are the
user's task
([`src-tauri/src/hermes_bridge.rs:240-248`](../src-tauri/src/hermes_bridge.rs#L240-L248)).

### MCP catalog and admin surface

June has a native Hermes MCP catalog controller that browses, installs, polls
background actions, refreshes MCP and toolset state, and reports that a gateway
restart is required
([`src/lib/hermes-admin/use-mcp-catalog.ts:1-28`](../src/lib/hermes-admin/use-mcp-catalog.ts#L1-L28),
[`src/lib/hermes-admin/use-mcp-catalog.ts:226-305`](../src/lib/hermes-admin/use-mcp-catalog.ts#L226-L305)).
The catalog view distinguishes local subprocesses from remote servers and
models API-key, OAuth, third-party, and no-auth requirements
([`src/lib/hermes-admin/mcp-catalog-view.ts:28-40`](../src/lib/hermes-admin/mcp-catalog-view.ts#L28-L40),
[`src/lib/hermes-admin/mcp-catalog-view.ts:47-95`](../src/lib/hermes-admin/mcp-catalog-view.ts#L47-L95)).

June already classifies browser-driving MCP entries as high risk because they
can reach and act on signed-in sites
([`src/lib/hermes-admin/mcp-security-view.ts:233-285`](../src/lib/hermes-admin/mcp-security-view.ts#L233-L285)).
The settings UI asks for confirmation before a high-risk MCP server is enabled,
but the check is advisory rather than a permanent block
([`src/components/settings/McpSecuritySection.tsx:162-167`](../src/components/settings/McpSecuritySection.tsx#L162-L167)).
This is install or enable consent for a user-managed server, not a dedicated
browser capability grant requested from an agent turn.

`INTERNAL_MCP_SERVER_NAMES` currently names `june_context`, `june_web`,
`june_image`, and `june_recorder`
([`src/lib/hermes-admin/mcp-servers-view.ts:25-34`](../src/lib/hermes-admin/mcp-servers-view.ts#L25-L34)).
It gates presentation and user management: servers with those names are filtered
out of the user-managed MCP list
([`src/lib/hermes-admin/mcp-servers-view.ts:36-47`](../src/lib/hermes-admin/mcp-servers-view.ts#L36-L47),
[`src/components/settings/McpServersSection.tsx:234-235`](../src/components/settings/McpServersSection.tsx#L234-L235)).
It does not grant a tool or disable a server. A June-owned `june_browser` must be
added to this list so users cannot edit or remove an app-owned security boundary.

The Toolsets admin surface is inventory-only and has no toggle
([`src/lib/hermes-admin/use-toolsets.ts:1-19`](../src/lib/hermes-admin/use-toolsets.ts#L1-L19)).
The only browser-related toolset policy June currently writes is the routine
allowlist, which deliberately excludes browser and other machine-touching
toolsets from sandboxed routine defaults
([`src-tauri/src/hermes_bridge.rs:6481-6503`](../src-tauri/src/hermes_bridge.rs#L6481-L6503)).

### Packaging and platform boundary

June pins Hermes to a commit and source-tarball SHA-256
([`src-tauri/src/hermes_bridge.rs:35-40`](../src-tauri/src/hermes_bridge.rs#L35-L40)).
The release build creates a self-contained runtime from those pins
([`scripts/bundle-hermes-runtime.sh:1-20`](../scripts/bundle-hermes-runtime.sh#L1-L20))
and Tauri ships it as an app resource
([`src-tauri/tauri.conf.json:119-132`](../src-tauri/tauri.conf.json#L119-L132)).
The bundler prebuilds the Hermes dashboard but removes all Node modules because
they are not needed by June's current runtime surface
([`scripts/bundle-hermes-runtime.sh:198-220`](../scripts/bundle-hermes-runtime.sh#L198-L220)).
No separate browser-automation resource appears in Tauri's resource map
([`src-tauri/tauri.conf.json:129-132`](../src-tauri/tauri.conf.json#L129-L132)).
The independently installed CLI and browser engine described by the pinned
upstream source are therefore not part of June's self-contained bundle.

Every Hermes bump is gated by fixture replay, a live smoke test, and version
agreement checks
([`docs/hermes-upgrade-checklist.md:1-25`](hermes-upgrade-checklist.md#L1-L25)).
The project plan identifies June as macOS-first
([`specs/003-conversation-turns/plan.md:10-17`](../specs/003-conversation-turns/plan.md#L10-L17)),
and the Seatbelt enforcement itself is macOS-only
([`src-tauri/src/hermes_bridge.rs:6148-6202`](../src-tauri/src/hermes_bridge.rs#L6148-L6202)).

## Gap analysis

Modern browser use means control of a stateful browsing context, not better URL
fetching. The minimum categories are:

| Capability | Expected behavior | June today | V1 target |
| --- | --- | --- | --- |
| Navigate | Open an HTTP or HTTPS page, wait for readiness, follow redirects, and move back through history. | Fetches one URL as markdown without a live page ([`src-tauri/src/hermes/june_web_mcp.py:66-80`](../src-tauri/src/hermes/june_web_mcp.py#L66-L80)). | One public-web page with navigate, wait, redirect reporting, and back. |
| Read page state | Return current URL, title, visible text, and an accessibility-oriented snapshot with stable element references. | Search returns snippets and fetch returns markdown only ([`src-tauri/src/hermes/june_web_mcp.py:33-83`](../src-tauri/src/hermes/june_web_mcp.py#L33-L83)). | Snapshot the current live page and issue short-lived element references. |
| Click and fill | Click controls, fill or clear fields, press common keys, and observe the resulting page state. | No interaction tool is declared or dispatched ([`src-tauri/src/hermes/june_web_mcp.py:33-83`](../src-tauri/src/hermes/june_web_mcp.py#L33-L83), [`src-tauri/src/hermes/june_web_mcp.py:170-181`](../src-tauri/src/hermes/june_web_mcp.py#L170-L181)). | Click and fill by snapshot reference, plus common keys and an automatic post-action snapshot. |
| Screenshot | Capture the viewport for visual grounding and user verification. | No screenshot operation exists in `june_web` ([`src-tauri/src/hermes/june_web_mcp.py:33-83`](../src-tauri/src/hermes/june_web_mcp.py#L33-L83)). | Capture the visible viewport and return image content plus page metadata. |
| Tabs and contexts | Create, enumerate, switch, and close tabs or windows, including popups. | No browsing context exists to manage ([`src-tauri/src/hermes/june_web_mcp.py:33-83`](../src-tauri/src/hermes/june_web_mcp.py#L33-L83)). | Deliberately out of v1. One page only. |
| Login and session persistence | Choose whether cookies and authenticated state are ephemeral, task-persistent, or explicitly persistent across tasks. | June does not own an agent browser profile; interactive login is assigned to the user ([`src-tauri/src/hermes_bridge.rs:240-248`](../src-tauri/src/hermes_bridge.rs#L240-L248)). | Ephemeral June-owned profile only. No reuse of the user's normal profile and no cross-task login persistence. |
| Consent and control | Explain the data and action scope, require an explicit capability grant, show that automation is active, allow stop and revoke, and add action-level approval for consequential steps. | The closest pattern is the separate Agent CLI setting and approval card ([`src/lib/agent-cli-access.ts:1-26`](../src/lib/agent-cli-access.ts#L1-L26), [`src/components/agent/AgentWorkspace.tsx:11779-11833`](../src/components/agent/AgentWorkspace.tsx#L11779-L11833)). | Dedicated Browser access toggle and request card, visible browser window, stop and revoke. Consequential-action approval follows later. |

The distinction matters because a browser profile can contain cookies, history,
bookmarks, and other local state. Attaching to the user's everyday profile would
turn a navigation tool into access to every site that profile can reach. V1 must
instead make the profile boundary visible and technically enforced.

## Mechanisms evaluated

### Catalog-installed browser automation MCP server

This fits June's existing browse, install, credential, risk-label, restart, and
diagnostic surfaces
([`src/lib/hermes-admin/use-mcp-catalog.ts:1-28`](../src/lib/hermes-admin/use-mcp-catalog.ts#L1-L28),
[`src/lib/hermes-admin/mcp-catalog-view.ts:28-95`](../src/lib/hermes-admin/mcp-catalog-view.ts#L28-L95)).
It is the fastest path for an advanced user to experiment.

It is not the v1 recommendation. The exact availability, package version, and
browser binary of a suitable live catalog entry are **unverified**. Catalog
installation consent also does not define which browser profile is attached,
does not create June's requested Settings and in-chat approval path, and leaves
the tool contract and update cadence outside June's release pin. June would
still need a separate profile, lifecycle, and consent design.

### Browser CLI through the existing sandbox

A CLI can run as a Hermes subprocess and inherit the current Seatbelt profile
([`src-tauri/src/hermes_bridge.rs:6301-6332`](../src-tauri/src/hermes_bridge.rs#L6301-L6332)).
The pinned upstream source already documents a CLI-backed local browser mode, so
this is the shortest technical prototype. It could also reuse the general shape
of Agent CLI access.

It is not the shipping interface. Agent CLI access currently grants state for a
specific set of coding CLIs, not a browser profile
([`src-tauri/src/hermes_bridge.rs:277-301`](../src-tauri/src/hermes_bridge.rs#L277-L301)).
Exposing a browser CLI through the terminal would make output parsing, profile
selection, cleanup, and consent dependent on model discipline. It would also
make the packaged executable a bypass around any later MCP policy unless the CLI
were inaccessible without a host-issued capability. Use a pinned CLI or sidecar
behind the broker, not as the agent-facing contract.

### June-owned `june_browser` internal MCP server

This matches the proven internal MCP shape: June writes a small stdio server at
spawn, registers it in Hermes config, and can give it a token-gated loopback
route
([`src-tauri/src/hermes_bridge.rs:6528-6541`](../src-tauri/src/hermes_bridge.rs#L6528-L6541),
[`src-tauri/src/hermes_bridge.rs:6996-7020`](../src-tauri/src/hermes_bridge.rs#L6996-L7020)).
June owns the tool schemas, can expose only the v1 subset, can refuse every call
when consent is absent, and can keep browser process and profile policy in a
Rust broker. The automation engine can still be an independently pinned CLI or
sidecar, so this does not require June to invent browser automation.

This is the recommendation.

## V1 proposal

### Architecture

```text
Hermes session
  -> june_browser stdio MCP inside the Hermes sandbox
  -> per-spawn bearer token over a loopback-only route
  -> June Rust browser broker
  -> pinned local automation sidecar and visible browser
  -> unique ephemeral June browser profile
```

The MCP server is always app-owned and listed in
`INTERNAL_MCP_SERVER_NAMES`, but its Hermes config entry is `enabled: false`
until Browser access is granted. Rendering an explicit false value is important:
June deep-merges its owned config leaves over user-managed config on every spawn
([`src-tauri/src/hermes_bridge.rs:6724-6741`](../src-tauri/src/hermes_bridge.rs#L6724-L6741)),
so merely omitting the entry would not reliably revoke a previously enabled
server.

The browser sidecar must not be placed on the agent's `PATH`. Only the Rust
broker starts it, after validating a per-spawn capability token issued when the
setting is enabled. The broker owns timeouts, crash cleanup, session cleanup,
URL policy, and process termination. This prevents a terminal call from
bypassing the MCP consent surface.

### V1 tool contract

| Tool | V1 behavior |
| --- | --- |
| `browser_start` | Create one visible browser window with a new random session id and isolated ephemeral profile. |
| `browser_navigate` | Navigate the session to one public HTTP or HTTPS URL, wait for readiness, and return URL, title, and a compact snapshot. |
| `browser_snapshot` | Return visible text and accessibility-oriented interactive references for the current page. References expire after navigation or mutation. |
| `browser_click` | Click one current reference and return the resulting compact snapshot. |
| `browser_fill` | Replace the value of one form control without submitting it, then return the resulting compact snapshot. |
| `browser_press` | Send a small allowlist of common navigation and form keys. |
| `browser_screenshot` | Capture the current viewport and return image content with URL and viewport metadata. |
| `browser_back` | Move back once and return the resulting compact snapshot. |
| `browser_close` | Close the window, revoke the session id, and delete its profile directory. |

Every tool after `browser_start` requires its unguessable session id. V1 permits
one page per browser session and blocks `file:`, custom schemes, loopback,
link-local, and private-network destinations. The broker must re-check the final
resolved address after redirects. A browser session closes on explicit close,
runtime shutdown, app shutdown, or a short idle timeout.

### Sandbox and consent model

Browser access is a separate capability because controlling a website is not a
filesystem-write permission. It stays required in both sandboxed and
unrestricted runtime modes.

Add a Browser access toggle under Settings, Agent. The copy must say that June
can open pages, read what is displayed, click controls, and fill forms in a
separate browser profile. When disabled, the SOUL guidance tells the agent to
emit `[REQUEST:BROWSER_ACCESS]` on its own line. June replaces that token with an
approval card, just as it does for Agent CLI access
([`src/lib/agent-cli-access.ts:1-26`](../src/lib/agent-cli-access.ts#L1-L26)).

Approval persists the setting and retires both runtime modes before retrying the
turn. Agent CLI access only retires the sandboxed mode because it changes that
mode's Seatbelt grants
([`src-tauri/src/hermes_bridge.rs:2214-2245`](../src-tauri/src/hermes_bridge.rs#L2214-L2245));
Browser access changes the shared MCP catalog, so both modes need a fresh spawn.
Turning the setting off terminates all browser sessions, disables the config
entry, removes ephemeral profiles, and retires both runtimes.

The browser window stays visible and carries a June-controlled automation
indicator with Stop. V1 consent is capability-wide after the explicit opt-in.
Approval before a consequential page action is deliberately a later phase, not
an unenforced prompt instruction disguised as a security boundary.

### Privacy posture

V1 never attaches to the user's normal browser process or profile. It never
reads the normal profile's cookies, history, bookmarks, saved passwords,
extensions, or open tabs. Each `browser_start` gets a new June-owned directory
under app-controlled temporary storage, and that directory is deleted when the
session closes.

The agent can see only pages opened inside that session, data those pages render,
and values entered into those pages during the session. V1 does not persist
login state across tasks. It must not copy credentials from the user's browser
or credential stores. Site requests leave directly from the local automation
browser, not through `june_web`. Snapshots, screenshots, and entered values that
are returned to the agent can become inference context; June's current privacy
disclosure says prompts leave the device for model inference
([`src-tauri/src/hermes_bridge.rs:148-153`](../src-tauri/src/hermes_bridge.rs#L148-L153)).
The consent copy must make that boundary explicit.

Screenshots and snapshots must be assigned explicit local trace, retention, and
cleanup rules before implementation. The exact screenshot artifact cleanup hook
is **unverified**.

The broker launches the browser under a dedicated macOS Seatbelt profile that
allows its signed resources, its ephemeral profile, and its temporary files,
while denying reads of the user's home data and credential stores. Reusing the
Hermes profile unchanged would leave reads too broad for a browser process
([`src-tauri/src/hermes_bridge.rs:6399-6415`](../src-tauri/src/hermes_bridge.rs#L6399-L6415)).

### Packaging, pinning, and macOS-first delivery

Bundle the automation sidecar and compatible browser engine as signed Tauri
resources. Pin the source revision, package lock, browser revision, and hashes;
record third-party notices; prohibit first-run downloads; and fail the release
build on a hash or version mismatch. This follows the existing Hermes bundle's
commit and SHA discipline
([`src-tauri/src/hermes_bridge.rs:35-40`](../src-tauri/src/hermes_bridge.rs#L35-L40),
[`scripts/bundle-hermes-runtime.sh:111-166`](../scripts/bundle-hermes-runtime.sh#L111-L166)).

V1 is macOS-only. Produce and test the resource for each supported macOS
architecture, sign every executable and framework, notarize the final app, and
add a release self-test that starts the browser under its dedicated Seatbelt
profile. Package size and cold-start impact are **unverified** and are release
gates, not assumptions.

The browser MCP schemas, image return path, runtime events, and restart behavior
must be added to the Hermes compatibility fixtures and live smoke test. Any
Hermes pin change continues through `pnpm test:hermes-smoke` and
`pnpm hermes:upgrade-check`, which are the current release gates
([`package.json:15-29`](../package.json#L15-L29),
[`docs/hermes-upgrade-checklist.md:11-25`](hermes-upgrade-checklist.md#L11-L25)).
The browser sidecar and browser engine also need their own version-agreement
check because they can change without a Hermes bump.

### V1 acceptance boundary

V1 is shipped only when all of the following are true:

1. With Browser access off, neither runtime can invoke or directly launch the
   packaged browser capability.
2. The Settings toggle and approval-card flow both enable the same stored grant,
   restart both modes, and retry cleanly.
3. A sandboxed session can navigate, snapshot, click, fill, press, screenshot,
   go back, and close on a public test site.
4. The visible browser uses a fresh profile with no data from the user's normal
   browser, and the profile is removed on close, timeout, crash, revoke, and app
   exit.
5. Private and local network targets remain blocked before navigation and after
   redirects.
6. The signed release artifact passes the browser self-test, Hermes fixture
   replay, Hermes live smoke test, and version-agreement checks on macOS.

## Phased plan

### V1

Build the `june_browser` MCP contract and broker, package the pinned local
runtime, add the Browser access setting and request card, enforce the ephemeral
profile and public-web policy, and ship the single-page tool subset above on
macOS.

### Later phases

Add multi-context browsing, persistent isolated login state, action-level
approval for consequential operations, and the Windows sandbox and packaging
story. These are separate because each expands either the data boundary, the
action boundary, or the platform boundary.

## Follow-up issue list

### Add multi-tab, popup, and frame browser workflows

Extend `june_browser` with list, open, switch, and close operations for tabs, windows, popups, and frames.
Keep stable context ids, include the active origin in every result, and preserve isolation across concurrent agent turns.

### Add persistent isolated browser login sessions

Add an explicit opt-in June browser profile that can retain cookies and login state across tasks without attaching to the user's normal profile.
Provide profile naming, last-used visibility, clear-data controls, expiry, and a migration path back to ephemeral mode.

### Add action-level approval for consequential browser operations

Pause before submit, send, publish, purchase, delete, account change, or other consequential actions even when Browser access is enabled.
Show the origin, proposed action, and relevant values in an approval card with allow once and deny controls.

### Add Windows browser automation packaging and containment

Package and pin the browser runtime for Windows and define a containment boundary equivalent to the macOS broker profile.
Verify process cleanup, profile deletion, code signing, updater size, and the full browser acceptance suite before enabling the setting.
