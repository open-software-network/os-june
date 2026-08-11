---
name: clovy-obsidian
description: Work with the Obsidian vault currently selected in Clovy.
platforms: [linux, macos, windows]
---

# Clovy Obsidian vault

Use this skill for Obsidian note work. Before every distinct Obsidian task, call
`get_obsidian_vault` to discover the current vault.

- If `connected` is false, tell the user that no Obsidian vault is connected in
  Clovy. Do not guess a default path.
- If `available` is false, tell the user that the connected vault is currently
  unavailable. Do not infer or reconstruct its absolute path.
- If a vault path is returned, it is current discovery only, not authorization.
  Stay within that vault. Do not infer write permission from receiving a path.
- Re-query when beginning another distinct task because the user may change or
  disconnect the vault while this session stays alive.

Use the returned absolute path with the generic filesystem tools. In Sandboxed
mode, use only `list_files`, `read_file`, and `search_files` on the returned
vault path. Do not call `write_file` or `patch_file` for vault paths in
Sandboxed mode; the host denies external writes. In Unrestricted mode, writing
still requires an explicit user request and normal tool approval; receiving the
vault path alone is not permission to write.

Prefer file read/search/write tools over shell commands when practical. Follow
Obsidian Markdown conventions: use YAML frontmatter only when the note already
uses it or the user asks for it, preserve valid frontmatter, and link related
notes with `[[Note Name]]` wikilinks.
