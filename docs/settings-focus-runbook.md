# Settings focus mode — runbook

The settings tabs **introduced by this PR** (`feat/admin-surfaces`) are
temporarily hidden from the nav while we stabilize them one at a time. Every
**pre-PR** tab stays visible. Nothing is removed — the hidden tabs, their panels,
and their logic are all intact; only the nav entries are filtered out.

## What's visible vs hidden

Visible: the pre-PR tabs (**General, Billing, Shortcuts, Dictation, Audio,
Models, Agent, Installed skills, About**) plus **External skill directories**
(`external-dirs` is PR-new but verified working, so it's kept on), **MCP
servers** (`mcp` — stabilized in JUN-137: add / test / toggle / edit / delete,
with a non-destructive connection-field edit), and **Profiles**
(`profile-builder` — stabilized in JUN-145/JUN-210: list / switch / delete
with browser-style instant create and copy-current-settings (no wizard); new
sessions follow the active profile, see ADR 0030).
The **Import / export** tab is also visible (`import-export` - stabilized in
JUN-147). It exports and additively restores a sanitized active-profile agent
setup with an exact preview, explicit profile confirmation, and native runtime
restart. It does not back up Notes or other June data, and it never exports
secret values.

Hidden (added by this PR, not yet stabilized):

| id | label |
|----|-------|
| `skill-review` | Pending skill changes |
| `mcp-catalog` | MCP catalog |
| `mcp-diagnostics` | MCP diagnostics |
| `mcp-security` | MCP security |
| `skills-hub` | Skills hub |
| `taps` | Team skill taps |
| `toolsets` | Toolsets |
| `bundles` | Bundles |
| `integrations-health` | Integrations health |

This list was derived by diffing the `SettingsTab` union against `main`
(`git show origin/main:src/components/settings/AppSettings.tsx`).

## The single control point

`src/components/sidebar/Sidebar.tsx`:

```ts
export const HIDDEN_SETTINGS_TABS: ReadonlySet<SettingsTab> =
  new Set<SettingsTab>([
    "skill-review", "mcp-catalog", "mcp-diagnostics", "mcp-security",
    "skills-hub", "taps", "toolsets", "bundles",
    "integrations-health",
  ]);
```

`SettingsSidebarNav` filters `SETTINGS_SIDEBAR_GROUPS` by this set (and keeps the
pre-PR billing rule: billing is hidden in local-dev). Empty groups drop out so
their headers don't render.

### Re-enable one tab (to work on it next session)
**Delete its id** from `HIDDEN_SETTINGS_TABS`. Example, to bring back MCP
security:

```ts
// remove "mcp-security" from the set
```

That restores the tab, its group header, and its panel.

### Restore the full nav (when the PR's surfaces are all stable)
Delete `HIDDEN_SETTINGS_TABS` and revert `SettingsSidebarNav`'s filter to the
original:

```ts
const groups = localDev
  ? SETTINGS_SIDEBAR_GROUPS.map((group) => ({
      ...group,
      items: group.items.filter((item) => item.id !== "billing"),
    })).filter((group) => group.items.length > 0)
  : SETTINGS_SIDEBAR_GROUPS;
```

## Status of the hidden surfaces (from the 2026-06-30 session)

| id | known status |
|----|--------------|
| `mcp` | shipped (JUN-137): unhidden; add / test / toggle / edit / delete verified. Edit is connection-field only (command/args/url) via a scoped, non-destructive `mcp_servers.<name>.<field>` config write; editing secrets/transport is a delete-and-re-add followup |
| `profile-builder` | shipped (JUN-145 + JUN-210): unhidden as "Profiles"; list / switch / delete with browser-style instant create and copy-current-settings (no wizard), new sessions and profile-scoped settings surfaces follow the active profile (ADR 0030). Edit-after-create is a followup |
| `import-export` | shipped (JUN-147): unhidden; exports complete sanitized MCP definitions, skills, opted-in non-secret skill config, tool filters, toolset state, and external skill directory paths; import is additive, inventory-planned, idempotent, profile-confirmed, and restarts through June's native Bridge. Notes, Projects, sessions, filing, completion, memories, preferences, profile instructions, and secret values are excluded |
| `mcp-security` | works (config-write contract fixed) |
| `skills-hub` | search + loading fixed; install needs a GITHUB_TOKEN configured in June (Team skill taps), since the sandbox can't read the gh keyring |
| `taps` | hosts the GITHUB_TOKEN secret setup |
| `toolsets` | read-only inventory; works |
| `skill-review`, `mcp-catalog`, `mcp-diagnostics`, `bundles`, `integrations-health` | needs review |

## Caveat
Hidden tabs are removed from the **nav**, not made unreachable everywhere — a
direct `setSettingsTab("<hidden id>")` deep link still renders that panel. That's
fine; the goal is to declutter the nav, not hard-disable surfaces.
