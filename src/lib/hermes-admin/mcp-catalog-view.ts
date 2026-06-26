/**
 * Pure, render-free view logic for the native MCP catalog browser (spec 15):
 * transport / risk labeling (reused from the MCP servers view), auth-requirement
 * classification, install-status labeling (available / installed-disabled /
 * enabled), the search filter, and the secure env-value draft a one-click install
 * collects. Kept separate from the React component and the data hook so the
 * labeling and the "which values does install need" derivation are unit-testable
 * without rendering and without a network.
 *
 * Nothing here talks to Hermes; it only reshapes already-parsed catalog entries
 * and builds the install payload from a draft. Copy is sentence case, no
 * em/en-dashes, per June conventions.
 *
 * The hard rule this module shares with the MCP servers view: a value the user
 * types into an env field is SECRET. It rides in the install request body (built
 * by {@link buildInstallPayload}) and is never logged. This module only ever
 * reads env KEY NAMES from a catalog entry, never a value.
 */

import type { HermesInstallCatalogPayload } from "./client";
import type {
  HermesMcpCatalogAuthKind,
  HermesMcpCatalogEntry,
  HermesMcpCatalogEnvRequirement,
} from "./schemas";
import { transportMeta, type McpTransportMeta } from "./mcp-servers-view";

// The catalog UI reuses the SAME transport/risk metadata the MCP servers page
// uses (`transportMeta` / `McpTransportMeta`, exported from `mcp-servers-view`),
// so the local-subprocess vs remote-HTTP risk labels stay identical across both.

/** The transport/risk metadata for a catalog entry. */
export function catalogTransportMeta(
  entry: HermesMcpCatalogEntry,
): McpTransportMeta {
  return transportMeta(entry.transport);
}

/** True when installing this entry runs a local subprocess, so the UI can lead
 * with the sandbox/full-mode note for it. */
export function isLocalSubprocessEntry(entry: HermesMcpCatalogEntry): boolean {
  return catalogTransportMeta(entry).risk === "local-subprocess";
}

// ---------------------------------------------------------------------------
// Auth-requirement labels
// ---------------------------------------------------------------------------

/** A sentence-case label + blurb + tone for an entry's auth requirement, so the
 * install prompt explains what the user must provide before connecting. */
export type McpCatalogAuthMeta = {
  kind: HermesMcpCatalogAuthKind;
  /** Short pill label, sentence case. */
  label: string;
  /** One-line explanation for a secondary line / detail. */
  blurb: string;
  /** Tone the UI styles the badge with. */
  tone: "neutral" | "attention";
};

const AUTH_META: Readonly<
  Record<HermesMcpCatalogAuthKind, McpCatalogAuthMeta>
> = Object.freeze({
  "api-key": {
    kind: "api-key",
    label: "API key",
    blurb: "Needs an API key or token you provide during install.",
    tone: "attention",
  },
  oauth: {
    kind: "oauth",
    label: "OAuth",
    blurb: "You sign in through your browser after installing.",
    tone: "attention",
  },
  "third-party": {
    kind: "third-party",
    label: "Third-party auth",
    blurb: "You authorize access in an external system before it connects.",
    tone: "attention",
  },
  none: {
    kind: "none",
    label: "No auth",
    blurb: "Connects without any credentials.",
    tone: "neutral",
  },
  unknown: {
    kind: "unknown",
    label: "Auth unknown",
    blurb: "Hermes did not report an auth requirement for this entry.",
    tone: "neutral",
  },
});

/** The display metadata for an entry's auth requirement. */
export function catalogAuthMeta(
  kind: HermesMcpCatalogAuthKind,
): McpCatalogAuthMeta {
  return AUTH_META[kind];
}

// ---------------------------------------------------------------------------
// Install-status labels
// ---------------------------------------------------------------------------

/** The catalog status June surfaces per entry, distinct so the UI can tell
 * "available to install" from "installed but disabled" from "installed and
 * enabled". */
export type McpCatalogEntryStatus =
  | "available"
  | "installed-disabled"
  | "enabled";

/** A sentence-case label + tone for an entry's catalog status. */
export type McpCatalogEntryStatusMeta = {
  status: McpCatalogEntryStatus;
  label: string;
  tone: "ok" | "neutral";
};

/** Derives the catalog status: not installed -> available; installed with
 * `enabled === false` -> installed-disabled; installed and enabled (or enabled
 * not reported) -> enabled. */
export function catalogStatusOf(
  entry: HermesMcpCatalogEntry,
): McpCatalogEntryStatus {
  if (!entry.installed) return "available";
  if (entry.enabled === false) return "installed-disabled";
  return "enabled";
}

const STATUS_META: Readonly<
  Record<McpCatalogEntryStatus, McpCatalogEntryStatusMeta>
> = Object.freeze({
  available: { status: "available", label: "Available", tone: "neutral" },
  "installed-disabled": {
    status: "installed-disabled",
    label: "Installed, disabled",
    tone: "neutral",
  },
  enabled: { status: "enabled", label: "Enabled", tone: "ok" },
});

/** The display metadata for a catalog status. */
export function catalogStatusMeta(
  status: McpCatalogEntryStatus,
): McpCatalogEntryStatusMeta {
  return STATUS_META[status];
}

// ---------------------------------------------------------------------------
// Install draft (secure env collection)
// ---------------------------------------------------------------------------

/** The env values an install collects, keyed by env var name. Values are
 * SECRET-class (masked inputs); they ride in the install body and are never
 * logged. */
export type McpInstallDraft = {
  /** Whether to enable the server immediately after install (defaults true). */
  enable: boolean;
  /** Collected env values, by key. Secret. */
  env: Record<string, string>;
};

/** A blank install draft seeded with the entry's required env keys (empty
 * values) so the form renders one field per requirement. */
export function emptyInstallDraft(
  entry: HermesMcpCatalogEntry,
): McpInstallDraft {
  const env: Record<string, string> = {};
  for (const requirement of entry.requiredEnv ?? []) {
    env[requirement.key] = "";
  }
  return { enable: true, env };
}

/** The env requirements an entry needs supplied at install (the api-key style).
 * OAuth / third-party entries collect nothing here — their flow runs after
 * install — so this returns []. */
export function envRequirementsFor(
  entry: HermesMcpCatalogEntry,
): HermesMcpCatalogEnvRequirement[] {
  if (entry.auth === "oauth" || entry.auth === "third-party") return [];
  return entry.requiredEnv ?? [];
}

/** True when an entry needs the user to supply secret env values before it can
 * be installed (so the install button opens a form rather than installing
 * straight away). */
export function needsCredentials(entry: HermesMcpCatalogEntry): boolean {
  return envRequirementsFor(entry).some(
    (requirement) => requirement.required !== false,
  );
}

/** True when an entry's install is followed by an OAuth / third-party auth flow
 * that June must hand off to (feature 17), rather than pretending install is
 * complete. */
export function needsAuthHandoff(entry: HermesMcpCatalogEntry): boolean {
  return entry.auth === "oauth" || entry.auth === "third-party";
}

/** The outcome of validating an install draft: a ready-to-send payload, or a
 * map of env-key -> sentence-case error so the form can mark fields. */
export type McpInstallValidation =
  | { ok: true; payload: HermesInstallCatalogPayload }
  | { ok: false; errors: Record<string, string> };

/**
 * Validates a draft against an entry's requirements and, when valid, builds the
 * `POST /api/mcp/catalog/install` payload. Required env values must be non-empty;
 * blank optional values are dropped. The payload carries env as a plain map (the
 * values are secrets — they ride in the body and are never logged).
 */
export function validateInstallDraft(
  entry: HermesMcpCatalogEntry,
  draft: McpInstallDraft,
): McpInstallValidation {
  const errors: Record<string, string> = {};
  const env: Record<string, string> = {};

  for (const requirement of envRequirementsFor(entry)) {
    const value = draft.env[requirement.key] ?? "";
    const required = requirement.required !== false;
    if (!value.trim()) {
      if (required) {
        errors[requirement.key] =
          `Enter a value for ${requirement.label ?? requirement.key}.`;
      }
      continue; // do not send a blank value
    }
    env[requirement.key] = value;
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  const payload: HermesInstallCatalogPayload = { name: entry.installName };
  if (Object.keys(env).length > 0) payload.env = env;
  // Only send `enable` when the user opted out of the default-on behavior, so the
  // body stays minimal and Hermes' default is respected otherwise.
  if (!draft.enable) payload.enable = false;
  return { ok: true, payload };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** The lowercased haystack a catalog entry is searched against: name, id,
 * description, transport label, auth label, source, and default tool names.
 * Centralized so the filter is testable. */
export function catalogHaystack(entry: HermesMcpCatalogEntry): string {
  const parts: Array<string | undefined> = [
    entry.name,
    entry.id,
    entry.installName,
    entry.description,
    catalogTransportMeta(entry).label,
    catalogAuthMeta(entry.auth).label,
    entry.source,
    ...(entry.defaultTools ?? []),
  ];
  return parts
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .toLowerCase();
}

/** Applies the search filter, preserving input order. */
export function filterCatalog(
  entries: readonly HermesMcpCatalogEntry[],
  query: string,
): HermesMcpCatalogEntry[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...entries];
  return entries.filter((entry) => catalogHaystack(entry).includes(normalized));
}
