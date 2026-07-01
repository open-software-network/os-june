/**
 * Pure, render-free view logic for June's setup import/export surface (spec 23):
 * the sanitized snapshot schema, the snapshot BUILDER that aggregates every
 * landed admin surface (profiles, skills, hub installs, MCP servers + filters,
 * toolset readiness) into one redacted document, the permissive snapshot PARSER
 * that reads a snapshot back without ever throwing, and the import DIFF that says
 * what an import would add, change, or remove. Kept separate from the React
 * component and the data hook so redaction, parsing, and diffing are
 * unit-testable without rendering and without a network.
 *
 * Five hard rules this module owns:
 *
 * - SECRETS NEVER LEAVE. Every MCP `env` value, header value, token, OAuth
 *   credential, and API key is reduced to a KEY NAME plus a missing-value
 *   placeholder. The whole document is run through the shared structural
 *   redactor as a backstop, exactly as {@link buildDiagnosticBundle} does, so a
 *   secret-shaped value that slipped into a status message or a raw field is
 *   masked before export.
 * - REQUIRED SECRETS ARE PLACEHOLDERS. A server's configured env/header keys and
 *   a catalog entry's required-env are recorded as the secrets an importer must
 *   re-supply, never as values.
 * - NON-SECRET SKILL CONFIG IS OPT-IN. Plain skill config values are only
 *   captured when the user opts in; even then a value that looks secret-shaped is
 *   dropped.
 * - FORWARD-COMPATIBLE. Bundles (spec 11) and external skill dirs (spec 10) are
 *   landing in parallel and are NOT in this branch, so their fields exist in the
 *   schema (so an export written here reads cleanly once they land) but are gated
 *   behind an "if available" capability the builder only fills when given the
 *   data. A snapshot without them is valid.
 * - PARSING NEVER THROWS. Reading a snapshot back is permissive (unknown in,
 *   normalized out), matching the admin parsers, so a hand-edited or
 *   forward-version file degrades visibly rather than crashing the import.
 *
 * Copy is sentence case, no em/en-dashes, per June conventions.
 */

import { asRecord, nonEmptyString } from "../hermes-control-plane/parse";
import { redactForLog } from "./redact";
import type {
  HermesMcpCatalogEntry,
  HermesMcpServerInfo,
  HermesProfileSummary,
  HermesSkillInfo,
  HermesToolsetInfo,
} from "./schemas";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** The version stamp of the snapshot schema, bumped on a breaking shape change
 * so an importer can tell what it is reading and refuse a newer major. */
export const SETUP_SNAPSHOT_VERSION = 1;

/** The placeholder recorded wherever a real secret value would otherwise sit. A
 * snapshot carries the KEY but never the value, so an importer knows what to
 * re-enter without the secret travelling in the file. */
export const SECRET_PLACEHOLDER = "<provide-on-import>";

/** Profile metadata only. Private memory, session state, and soul/instruction
 * text are intentionally excluded, so the snapshot identifies the profile shape
 * without exporting what the user said or what the agent remembers. */
export type SnapshotProfile = {
  name: string;
  description?: string;
  provider?: string;
  model?: string;
};

/** One skill's enabled state and, when known, the install source and version so
 * an importer can re-install hub skills and re-toggle local ones. */
export type SnapshotSkill = {
  name: string;
  enabled: boolean;
  source: HermesSkillInfo["source"];
  /** True for a skill the install can re-fetch from the hub by identifier. */
  hubInstalled: boolean;
  version?: string;
};

/** A required secret an importer must supply: the env/header KEY and where it is
 * needed. The value is NEVER carried; this is the "missing placeholder" the spec
 * requires. */
export type SnapshotRequiredSecret = {
  /** The env or header key name (e.g. `GITHUB_TOKEN`, `Authorization`). */
  key: string;
  /** Where the secret is consumed, so the import prompt can explain it. */
  scope: "mcp-env" | "mcp-header" | "catalog-env";
  /** The owning server or catalog entry name. */
  owner: string;
  /** Always {@link SECRET_PLACEHOLDER}; present so a reader sees a non-value. */
  placeholder: typeof SECRET_PLACEHOLDER;
};

/** One MCP server's definition, with env and header VALUES redacted to key
 * names only. Tool filters travel so an import re-applies the include/exclude
 * policy. */
export type SnapshotMcpServer = {
  name: string;
  enabled: boolean;
  transport: HermesMcpServerInfo["transport"];
  command?: string;
  url?: string;
  /** Env KEY names only (never values). */
  envKeys: string[];
  /** Header KEY names only (never values). */
  headerKeys: string[];
  includeTools: string[];
  excludeTools: string[];
};

/** A catalog-installed MCP entry an importer can re-install, plus the required
 * env keys it will prompt for (key names only). */
export type SnapshotCatalogInstall = {
  installName: string;
  enabled: boolean;
  requiredEnvKeys: string[];
};

/** A non-secret skill config value, only present when the user opted into
 * capturing config. A secret-shaped value is dropped even with opt-in. */
export type SnapshotSkillConfig = {
  skill: string;
  key: string;
  value: string;
};

/** An external skill directory recorded as a configurable path, with a warning
 * that the path must exist on the importing machine and runs outside the
 * sandbox. Gated behind spec 10; absent until that lands. */
export type SnapshotExternalDir = {
  path: string;
  /** Sentence-case warning surfaced on import. */
  warning: string;
};

/** A skill bundle reference (scripts/templates/assets). Gated behind spec 11;
 * absent until that lands. The shape is reserved so an export written now reads
 * cleanly once bundles are real. */
export type SnapshotBundle = {
  skill: string;
  hasScripts?: boolean;
  scriptCount?: number;
  templateCount?: number;
  referenceCount?: number;
  assetCount?: number;
};

/** The gateway/toolset readiness summary, so an importer sees what should be
 * configured and ready after applying the snapshot. */
export type SnapshotReadiness = {
  gatewayRunning?: boolean;
  gatewayVersion?: string;
  toolsets: Array<{ name: string; enabled: boolean; configured?: boolean }>;
};

/** The full sanitized setup snapshot. */
export type SetupSnapshot = {
  schemaVersion: number;
  generatedAt: string;
  /** The Hermes version the snapshot was taken against, so an importer can warn
   * on a mismatch. */
  hermesVersion?: string;
  /** The targeted profile and mode the snapshot was taken from. */
  profile: string;
  mode: string;
  /** A clear statement of what is and is not included, so a reader does not
   * mistake the file for a secret-bearing backup. */
  notes: string[];
  profiles: SnapshotProfile[];
  skills: SnapshotSkill[];
  mcpServers: SnapshotMcpServer[];
  catalogInstalls: SnapshotCatalogInstall[];
  toolFilters: Array<{
    server: string;
    includeTools: string[];
    excludeTools: string[];
  }>;
  /** Required secrets across every server/entry, as placeholders. Named
   * `requiredInputs` (not `requiredSecrets`) on purpose: the structural redactor
   * masks any object KEY containing "secret", so a `requiredSecrets` property
   * would be wiped to "[redacted]" by the backstop pass. The values here are
   * already non-secret (key names + placeholders), so the neutral name keeps the
   * section intact through redaction. */
  requiredInputs: SnapshotRequiredSecret[];
  /** Present only when the user opted into capturing non-secret config. */
  skillConfig?: SnapshotSkillConfig[];
  /** Gated behind spec 11; absent on this branch. */
  bundles?: SnapshotBundle[];
  /** Gated behind spec 10; absent on this branch. */
  externalDirs?: SnapshotExternalDir[];
  readiness: SnapshotReadiness;
};

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/** Optional, capability-gated inputs that are not in this branch yet. When a
 * caller cannot supply them (the parallel specs have not landed), they stay
 * absent and the snapshot is still valid. */
export type SnapshotCapabilities = {
  /** Spec 11: skill bundle references, when a bundles surface is available. */
  bundles?: SnapshotBundle[];
  /** Spec 10: external skill dirs, when a dirs surface is available. */
  externalDirs?: Array<{ path: string }>;
};

/** Everything {@link buildSetupSnapshot} reads, all already-parsed admin data so
 * the builder stays pure (no client, no network). */
export type SnapshotInput = {
  profile: string;
  mode: string;
  hermesVersion?: string;
  profiles: readonly HermesProfileSummary[];
  skills: readonly HermesSkillInfo[];
  mcpServers: readonly HermesMcpServerInfo[];
  catalog: readonly HermesMcpCatalogEntry[];
  toolsets: readonly HermesToolsetInfo[];
  gatewayRunning?: boolean;
  gatewayVersion?: string;
  /** When true, capture non-secret skill config values; off by default so a
   * snapshot stays minimal and never risks a config-shaped secret. */
  includeSkillConfig?: boolean;
  /** Skill config values, keyed by skill then config key, supplied only when the
   * user opted in. A secret-shaped value is dropped here. */
  skillConfig?: Record<string, Record<string, string>>;
  /** Capability-gated, parallel-spec inputs (bundles, external dirs). */
  capabilities?: SnapshotCapabilities;
  now?: Date;
};

/** Reads the env/header KEY NAMES from a server's raw payload (the listing never
 * returns values), tolerating a `{ KEY: value }` map or an array of `{ key }`. */
function configKeyNames(server: HermesMcpServerInfo, keys: string[]): string[] {
  const record = asRecord(server.raw);
  if (!record) return [];
  for (const key of keys) {
    const names = keyNamesOf(record[key]);
    if (names.length > 0) return names;
  }
  return [];
}

function keyNamesOf(value: unknown): string[] {
  const record = asRecord(value);
  if (record) {
    return Object.keys(record).filter((key) => key.trim().length > 0);
  }
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const entry of value) {
      const entryRecord = asRecord(entry);
      const name = entryRecord
        ? (nonEmptyString(entryRecord.key) ??
          nonEmptyString(entryRecord.name) ??
          nonEmptyString(entryRecord.header))
        : undefined;
      if (name) out.push(name);
    }
    return out;
  }
  return [];
}

/** A separator-free, long alphanumeric run is almost never user-facing config;
 * it is a credential. Mirrors the sanitizer's value heuristic so opt-in skill
 * config still never captures a secret-shaped value. */
function looksSecretShaped(value: string): boolean {
  if (value.includes("/") || value.includes("\\")) return false;
  return value.length >= 32 && !/\s/.test(value) && /[A-Za-z0-9]/.test(value);
}

/**
 * Builds a SANITIZED setup snapshot from already-parsed admin data. Secrets are
 * reduced to key names, required secrets are recorded as placeholders, and the
 * whole document is run through the shared structural redactor as a backstop so
 * nothing secret-shaped can leave the machine. Pure: no client, no network.
 */
export function buildSetupSnapshot(input: SnapshotInput): SetupSnapshot {
  const now = input.now ?? new Date();

  const profiles: SnapshotProfile[] = input.profiles.map((profile) => ({
    name: profile.name,
    description: profile.description,
    provider: profile.provider,
    model: profile.model,
  }));

  const skills: SnapshotSkill[] = input.skills.map((skill) => ({
    name: skill.name,
    enabled: skill.enabled,
    source: skill.source,
    hubInstalled: skill.source === "hub",
    version: skill.version,
  }));

  const requiredSecrets: SnapshotRequiredSecret[] = [];

  const mcpServers: SnapshotMcpServer[] = input.mcpServers.map((server) => {
    const envKeys = configKeyNames(server, ["env", "environment", "env_vars"]);
    const headerKeys = configKeyNames(server, ["headers", "http_headers"]);
    for (const key of envKeys) {
      requiredSecrets.push({
        key,
        scope: "mcp-env",
        owner: server.name,
        placeholder: SECRET_PLACEHOLDER,
      });
    }
    for (const key of headerKeys) {
      requiredSecrets.push({
        key,
        scope: "mcp-header",
        owner: server.name,
        placeholder: SECRET_PLACEHOLDER,
      });
    }
    return {
      name: server.name,
      enabled: server.enabled,
      transport: server.transport,
      command: server.command,
      url: server.url,
      envKeys,
      headerKeys,
      includeTools: server.includeTools ?? [],
      excludeTools: server.excludeTools ?? [],
    };
  });

  const catalogInstalls: SnapshotCatalogInstall[] = input.catalog
    .filter((entry) => entry.installed)
    .map((entry) => {
      const requiredEnvKeys = (entry.requiredEnv ?? [])
        .filter((req) => req.required !== false)
        .map((req) => req.key);
      for (const key of requiredEnvKeys) {
        requiredSecrets.push({
          key,
          scope: "catalog-env",
          owner: entry.installName,
          placeholder: SECRET_PLACEHOLDER,
        });
      }
      return {
        installName: entry.installName,
        enabled: entry.enabled ?? true,
        requiredEnvKeys,
      };
    });

  const toolFilters = mcpServers
    .filter(
      (server) =>
        server.includeTools.length > 0 || server.excludeTools.length > 0,
    )
    .map((server) => ({
      server: server.name,
      includeTools: server.includeTools,
      excludeTools: server.excludeTools,
    }));

  let skillConfig: SnapshotSkillConfig[] | undefined;
  if (input.includeSkillConfig && input.skillConfig) {
    skillConfig = [];
    for (const [skill, values] of Object.entries(input.skillConfig)) {
      for (const [key, value] of Object.entries(values)) {
        if (typeof value !== "string") continue;
        // Opt-in captures NON-secret config only. Drop a secret-shaped value
        // even when the user opted in, so a config-disguised token never leaks.
        if (looksSecretShaped(value)) continue;
        skillConfig.push({ skill, key, value });
      }
    }
  }

  const readiness: SnapshotReadiness = {
    gatewayRunning: input.gatewayRunning,
    gatewayVersion: input.gatewayVersion,
    toolsets: input.toolsets.map((toolset) => ({
      name: toolset.name,
      enabled: toolset.enabled,
      configured: toolset.configured,
    })),
  };

  // Capability-gated, parallel-spec sections. Absent until specs 10/11 land.
  const bundles = input.capabilities?.bundles;
  const externalDirs = input.capabilities?.externalDirs?.map((dir) => ({
    path: dir.path,
    warning:
      "This external skill directory must exist on the importing machine and runs outside the sandbox. Review its scripts before enabling.",
  }));

  const snapshot: SetupSnapshot = {
    schemaVersion: SETUP_SNAPSHOT_VERSION,
    generatedAt: now.toISOString(),
    hermesVersion: input.hermesVersion,
    profile: input.profile,
    mode: input.mode,
    notes: [
      "Secret values are never included. Env, header, token, OAuth, and API key values are recorded as key names only.",
      "Required secrets are listed as placeholders; the importer must re-enter them.",
      "Private memory, session state, and profile instructions are excluded.",
      input.includeSkillConfig
        ? "Non-secret skill config values are included because you opted in."
        : "Skill config values are not included.",
    ],
    profiles,
    skills,
    mcpServers,
    catalogInstalls,
    toolFilters,
    requiredInputs: requiredSecrets,
    ...(skillConfig ? { skillConfig } : {}),
    ...(bundles ? { bundles } : {}),
    ...(externalDirs ? { externalDirs } : {}),
    readiness,
  };

  // Backstop: structurally redact the whole snapshot so anything secret-shaped
  // that slipped into a command, a description, or a config value is masked
  // before export. Mirrors buildDiagnosticBundle's final redaction pass.
  return redactForLog(snapshot) as SetupSnapshot;
}

/** Serializes a snapshot to pretty JSON for download. */
export function serializeSetupSnapshot(snapshot: SetupSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

/** A stable, filesystem-safe filename for a downloaded snapshot. */
export function setupSnapshotFilename(
  profile: string,
  now: Date = new Date(),
): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const safeProfile = profile.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `june-setup-${safeProfile}-${stamp}.json`;
}

// ---------------------------------------------------------------------------
// Parser (permissive — never throws)
// ---------------------------------------------------------------------------

/** The outcome of reading a snapshot back: either a normalized snapshot or a
 * sentence-case reason it could not be read. Never throws. */
export type SnapshotParseResult =
  | { ok: true; snapshot: SetupSnapshot }
  | { ok: false; error: string };

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const str = nonEmptyString(entry);
    if (str) out.push(str);
  }
  return out;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Parses an unknown value (a parsed-JSON object or a JSON string) into a
 * normalized {@link SetupSnapshot}. Permissive like the admin parsers: missing
 * optional fields degrade to empty, a wrong-shaped section becomes an empty
 * list, and only a fundamentally unreadable input (not an object, or a newer
 * major schema) is rejected. Never throws.
 */
export function parseSetupSnapshot(input: unknown): SnapshotParseResult {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return { ok: false, error: "This file is not valid JSON." };
    }
  }
  const record = asRecord(value);
  if (!record) {
    return { ok: false, error: "This file is not a setup snapshot." };
  }

  const schemaVersion =
    typeof record.schemaVersion === "number" ? record.schemaVersion : 0;
  if (schemaVersion > SETUP_SNAPSHOT_VERSION) {
    return {
      ok: false,
      error: `This snapshot was written by a newer version of June (schema ${schemaVersion}). Update June to import it.`,
    };
  }

  const profiles = Array.isArray(record.profiles)
    ? record.profiles
        .map((entry): SnapshotProfile | undefined => {
          const r = asRecord(entry);
          const name = r && nonEmptyString(r.name);
          if (!name) return undefined;
          return {
            name,
            description: r ? nonEmptyString(r.description) : undefined,
            provider: r ? nonEmptyString(r.provider) : undefined,
            model: r ? nonEmptyString(r.model) : undefined,
          };
        })
        .filter((p): p is SnapshotProfile => p !== undefined)
    : [];

  const skills = Array.isArray(record.skills)
    ? record.skills
        .map((entry): SnapshotSkill | undefined => {
          const r = asRecord(entry);
          const name = r && nonEmptyString(r.name);
          if (!name) return undefined;
          const source = r && nonEmptyString(r.source);
          return {
            name,
            enabled: boolOr(r?.enabled, false),
            source: (source as HermesSkillInfo["source"]) ?? "unknown",
            hubInstalled: boolOr(r?.hubInstalled, source === "hub"),
            version: r ? nonEmptyString(r.version) : undefined,
          };
        })
        .filter((s): s is SnapshotSkill => s !== undefined)
    : [];

  const mcpServers = Array.isArray(record.mcpServers)
    ? record.mcpServers
        .map((entry): SnapshotMcpServer | undefined => {
          const r = asRecord(entry);
          const name = r && nonEmptyString(r.name);
          if (!name) return undefined;
          const transport = r && nonEmptyString(r.transport);
          return {
            name,
            enabled: boolOr(r?.enabled, false),
            transport:
              (transport as HermesMcpServerInfo["transport"]) ?? "unknown",
            command: r ? nonEmptyString(r.command) : undefined,
            url: r ? nonEmptyString(r.url) : undefined,
            envKeys: stringList(r?.envKeys),
            headerKeys: stringList(r?.headerKeys),
            includeTools: stringList(r?.includeTools),
            excludeTools: stringList(r?.excludeTools),
          };
        })
        .filter((s): s is SnapshotMcpServer => s !== undefined)
    : [];

  const catalogInstalls = Array.isArray(record.catalogInstalls)
    ? record.catalogInstalls
        .map((entry): SnapshotCatalogInstall | undefined => {
          const r = asRecord(entry);
          const installName = r && nonEmptyString(r.installName);
          if (!installName) return undefined;
          return {
            installName,
            enabled: boolOr(r?.enabled, true),
            requiredEnvKeys: stringList(r?.requiredEnvKeys),
          };
        })
        .filter((c): c is SnapshotCatalogInstall => c !== undefined)
    : [];

  const requiredSecrets = Array.isArray(record.requiredInputs)
    ? record.requiredInputs
        .map((entry): SnapshotRequiredSecret | undefined => {
          const r = asRecord(entry);
          const key = r && nonEmptyString(r.key);
          const owner = r && nonEmptyString(r.owner);
          const scope = r && nonEmptyString(r.scope);
          if (!key || !owner || !scope) return undefined;
          return {
            key,
            owner,
            scope: scope as SnapshotRequiredSecret["scope"],
            placeholder: SECRET_PLACEHOLDER,
          };
        })
        .filter((s): s is SnapshotRequiredSecret => s !== undefined)
    : [];

  const readinessRecord = asRecord(record.readiness);
  const readiness: SnapshotReadiness = {
    gatewayRunning:
      typeof readinessRecord?.gatewayRunning === "boolean"
        ? readinessRecord.gatewayRunning
        : undefined,
    gatewayVersion: readinessRecord
      ? nonEmptyString(readinessRecord.gatewayVersion)
      : undefined,
    toolsets: Array.isArray(readinessRecord?.toolsets)
      ? readinessRecord.toolsets
          .map((entry): SnapshotReadiness["toolsets"][number] | undefined => {
            const r = asRecord(entry);
            const name = r && nonEmptyString(r.name);
            if (!name) return undefined;
            return {
              name,
              enabled: boolOr(r?.enabled, false),
              configured:
                typeof r?.configured === "boolean" ? r.configured : undefined,
            };
          })
          .filter(
            (t): t is SnapshotReadiness["toolsets"][number] => t !== undefined,
          )
      : [],
  };

  const snapshot: SetupSnapshot = {
    schemaVersion: schemaVersion || SETUP_SNAPSHOT_VERSION,
    generatedAt:
      nonEmptyString(record.generatedAt) ?? new Date(0).toISOString(),
    hermesVersion: nonEmptyString(record.hermesVersion),
    profile: nonEmptyString(record.profile) ?? "default",
    mode: nonEmptyString(record.mode) ?? "sandboxed",
    notes: stringList(record.notes),
    profiles,
    skills,
    mcpServers,
    catalogInstalls,
    toolFilters: mcpServers
      .filter(
        (server) =>
          server.includeTools.length > 0 || server.excludeTools.length > 0,
      )
      .map((server) => ({
        server: server.name,
        includeTools: server.includeTools,
        excludeTools: server.excludeTools,
      })),
    requiredInputs: requiredSecrets,
    readiness,
  };

  return { ok: true, snapshot };
}

// ---------------------------------------------------------------------------
// Diff (preview: added / changed / removed)
// ---------------------------------------------------------------------------

/** How an item in the snapshot relates to the live setup. */
export type DiffStatus = "added" | "changed" | "removed" | "unchanged";

/** One line of the import preview: a thing the import would add, change, or
 * remove relative to the current setup. */
export type DiffEntry = {
  category: "skill" | "mcp-server" | "catalog-install" | "tool-filter";
  /** The identifying name (skill name, server name, install name). */
  name: string;
  status: DiffStatus;
  /** Sentence-case detail of the change, e.g. "Will be enabled.". */
  detail: string;
};

/** The full import preview: the diff entries plus the required secrets the
 * importer must supply before applying. */
export type SnapshotDiff = {
  entries: DiffEntry[];
  /** Required secrets the import will prompt for. */
  requiredSecrets: SnapshotRequiredSecret[];
  /** Count of entries that change the live setup (excludes "unchanged"). */
  changeCount: number;
};

/** The live setup the snapshot is diffed against, parsed from the current admin
 * surfaces. */
export type LiveSetup = {
  skills: readonly HermesSkillInfo[];
  mcpServers: readonly HermesMcpServerInfo[];
  catalog: readonly HermesMcpCatalogEntry[];
};

function sameList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((item) => setB.has(item));
}

/**
 * Diffs a parsed snapshot against the live setup, producing the import preview's
 * added/changed/removed lines. "Removed" means the snapshot omits something the
 * live setup has; June reports it but never deletes on import (an import is
 * additive and re-configuring, never destructive), so removals are advisory.
 */
export function diffSnapshot(
  snapshot: SetupSnapshot,
  live: LiveSetup,
): SnapshotDiff {
  const entries: DiffEntry[] = [];

  // Skills.
  const liveSkills = new Map(live.skills.map((skill) => [skill.name, skill]));
  for (const skill of snapshot.skills) {
    const current = liveSkills.get(skill.name);
    if (!current) {
      entries.push({
        category: "skill",
        name: skill.name,
        status: "added",
        detail: skill.hubInstalled
          ? `Will be installed from the hub${skill.enabled ? " and enabled" : " (disabled)"}.`
          : `Not installed locally. ${skill.enabled ? "Enable it after installing." : "Leave disabled."}`,
      });
    } else if (current.enabled !== skill.enabled) {
      entries.push({
        category: "skill",
        name: skill.name,
        status: "changed",
        detail: skill.enabled ? "Will be enabled." : "Will be disabled.",
      });
    } else {
      entries.push({
        category: "skill",
        name: skill.name,
        status: "unchanged",
        detail: "Already matches.",
      });
    }
  }
  for (const skill of live.skills) {
    if (!snapshot.skills.some((s) => s.name === skill.name)) {
      entries.push({
        category: "skill",
        name: skill.name,
        status: "removed",
        detail: "Installed locally but not in the snapshot. Left as is.",
      });
    }
  }

  // MCP servers.
  const liveServers = new Map(
    live.mcpServers.map((server) => [server.name, server]),
  );
  for (const server of snapshot.mcpServers) {
    const current = liveServers.get(server.name);
    if (!current) {
      entries.push({
        category: "mcp-server",
        name: server.name,
        status: "added",
        detail: `Will be added${server.enabled ? " and enabled" : " (disabled)"}. ${
          server.envKeys.length + server.headerKeys.length > 0
            ? "Requires secrets you must re-enter."
            : "No secrets required."
        }`,
      });
    } else {
      const enabledChanged = current.enabled !== server.enabled;
      const filtersChanged =
        !sameList(current.includeTools ?? [], server.includeTools) ||
        !sameList(current.excludeTools ?? [], server.excludeTools);
      if (enabledChanged || filtersChanged) {
        const parts: string[] = [];
        if (enabledChanged) {
          parts.push(server.enabled ? "will be enabled" : "will be disabled");
        }
        if (filtersChanged) parts.push("tool filters will be updated");
        entries.push({
          category: "mcp-server",
          name: server.name,
          status: "changed",
          detail: `${capitalize(parts.join(", "))}.`,
        });
      } else {
        entries.push({
          category: "mcp-server",
          name: server.name,
          status: "unchanged",
          detail: "Already matches.",
        });
      }
    }
  }
  for (const server of live.mcpServers) {
    if (!snapshot.mcpServers.some((s) => s.name === server.name)) {
      entries.push({
        category: "mcp-server",
        name: server.name,
        status: "removed",
        detail: "Configured locally but not in the snapshot. Left as is.",
      });
    }
  }

  // Catalog installs.
  const installedCatalog = new Set(
    live.catalog.filter((entry) => entry.installed).map((e) => e.installName),
  );
  for (const install of snapshot.catalogInstalls) {
    if (!installedCatalog.has(install.installName)) {
      entries.push({
        category: "catalog-install",
        name: install.installName,
        status: "added",
        detail: `Will be installed from the catalog${
          install.requiredEnvKeys.length > 0
            ? ". Requires secrets you must re-enter."
            : "."
        }`,
      });
    } else {
      entries.push({
        category: "catalog-install",
        name: install.installName,
        status: "unchanged",
        detail: "Already installed.",
      });
    }
  }

  const changeCount = entries.filter(
    (entry) => entry.status !== "unchanged" && entry.status !== "removed",
  ).length;

  return {
    entries,
    requiredSecrets: snapshot.requiredInputs,
    changeCount,
  };
}

function capitalize(value: string): string {
  return value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value;
}
