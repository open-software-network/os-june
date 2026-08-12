# Internal agent tool naming

**Rule.** Clovy-owned tools exposed to the agent as in-loop host tools are named
**`verb_object`**: the verb first, in `snake_case`, with no capability or
provider prefix repeated inside the tool name.

[ADR-0040](../docs/adr/0040-plugin-capabilities-as-host-tools.md) defines the
integration shape. Clovy-managed `june_*` MCP servers are retired; they are
historical architecture, not the namespace or template for a new internal
tool surface.

Good: `start_recording`, `stop_recording`, `generate_image`, `edit_image`,
`search_threads`, `read_thread`, `get_meeting_note`, `start_session`,
`accept_shared_tab`, `list_tabs`.

Not: `session_start`, `tab_accept_shared`, `recording_start`,
`june_browser_navigate`, `june_gmail_search_threads`.

Two carve-outs, both pre-existing and deliberate: a host-tool surface may use a
`namespace_verb` form when the namespace disambiguates an otherwise generic
verb (`web_search`, `web_fetch`), and a status reader may be named for what it
returns (`recording_status`, `status`).

**And: the name of every tool in a contract is fixed in exactly one document,
before the code is written.** For a Clovy-owned host-tool surface that document
is the subsystem PRD or contract that owns the capability. Other documents
reference those names; they never coin them.

**Why.** Two reasons, one aesthetic and one that cost real work.

The aesthetic one: a tool list is a menu the model reads on every turn. Mixed
conventions (`start_session` beside `tab_accept_shared`) make the surface look
like it was assembled by different people who never spoke, and the model has to
guess the shape of a name it has not seen.

The one that cost real work: in JUN-278 the canonical PRD described the
Browser use surface in prose ("session start and close ... accept a user-shared
tab") without naming the tools. The portfolio implementation plan then coined
`start_session` / `accept_shared_tab`; the implementing slice independently
coined `session_start` / `tab_accept_shared`. Both were reasonable. Both were
merged into different documents. Neither was wrong, which is exactly why
nobody caught it. A contract described but not *named* will be named twice.
That incident happened while Browser use was framed as the `june_browser` MCP
server. ADR-0040 retired that server shape, but the naming lesson remains.

**How to apply.** Before implementing a Clovy-owned host-tool surface, put the
names in the owning PRD or contract as a table, then implement against that
table. When adding a tool to an existing surface, match its established
convention and add the name to the owning document in the same change. When a
name in a document and a name in code disagree, the document that *owns* the
contract wins and the code is the bug; if no document owns it, that is the
defect to fix first.

Inspect the current host-tool catalog and dispatch before coining anything:
`src-tauri/src/agent_runtime/api.rs`,
`src-tauri/src/agent_runtime/native_connectors.rs`, and
`src-tauri/src/agent_runtime/tools.rs`.

**Exceptions.** Tools supplied by external MCP servers, including
user-connected and provider-hosted servers, are not ours to name; use them as
they come. A released execution name may also remain during a documented
rollback bridge when a subsystem contract proves that older binaries must read
newly persisted catalogs. This rule binds all other Clovy-owned in-loop host
tools.
