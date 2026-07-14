# Internal MCP tool naming

**Rule.** Tools exposed by June's own internal MCP servers (`june_context`,
`june_web`, `june_image`, `june_video`, `june_recorder`, `june_browser`,
`june_gmail*`, `june_gcal*`, and any future `june_*` server) are named
**`verb_object`**: the verb first, in `snake_case`, with no server-name prefix
repeated inside the tool name.

Good: `start_recording`, `stop_recording`, `generate_image`, `edit_image`,
`search_threads`, `read_thread`, `get_meeting_note`, `start_session`,
`accept_shared_tab`, `list_tabs`.

Not: `session_start`, `tab_accept_shared`, `recording_start`,
`june_browser_navigate`.

Two carve-outs, both pre-existing and deliberate: a server may use a
`namespace_verb` form when the namespace disambiguates an otherwise generic
verb (`web_search`, `web_fetch`), and a status reader may be named for what it
returns (`recording_status`, `status`).

**And: the name of every tool in a contract is fixed in exactly one document,
before the code is written.** For an internal MCP server that document is the
subsystem PRD that owns the server (for `june_browser`,
`docs/browser-computer-use-prd.md`). Other documents reference those names;
they never coin them.

**Why.** Two reasons, one aesthetic and one that cost real work.

The aesthetic one: a tool list is a menu the model reads on every turn. Mixed
conventions (`start_session` beside `tab_accept_shared`) make the surface look
like it was assembled by different people who never spoke, and the model has to
guess the shape of a name it has not seen.

The one that cost real work: in JUN-278 the canonical PRD described the
`june_browser` surface in prose ("session start and close ... accept a
user-shared tab") without naming the tools. The portfolio implementation plan
then coined `start_session` / `accept_shared_tab`; the implementing slice
independently coined `session_start` / `tab_accept_shared`. Both were
reasonable. Both were merged into different documents. Neither was wrong, which
is exactly why nobody caught it. A contract described but not *named* will be
named twice.

**How to apply.** Before implementing a tool surface, put the names in the
owning PRD as a table, then implement against that table. When adding a tool to
an existing server, match the server's established convention and add the name
to the owning document in the same change. When a name in a document and a name
in code disagree, the document that *owns* the contract wins and the code is
the bug; if no document owns it, that is the defect to fix first.

Grep the existing servers before coining anything:
`src-tauri/src/hermes/june_*_mcp.py`.

**Exceptions.** Tools of the *upstream* runtime and third-party MCP servers are
not ours to name; use them as they come. This rule binds June's own `june_*`
servers only.
