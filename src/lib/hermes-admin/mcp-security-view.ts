/**
 * Pure, render-free security + sandbox-boundary view logic for the MCP surfaces
 * (spec 19): the per-server security LABELS June surfaces (local subprocess /
 * remote server / OAuth / secret-backed / sandbox constrained / unrestricted
 * capable), the RISK CLASSIFICATION heuristic that flags high-risk servers
 * (filesystem, shell, browser, databases, cloud admin, destructive-named tools),
 * the exact WARNING copy shown before a high-impact enable/install, and the
 * global default MCP exposure POLICY model (read/write through the config path).
 *
 * Kept separate from the React components and the data hooks so the label
 * derivation, the risk heuristics, and the policy round-trip are unit-testable
 * without rendering and without a network.
 *
 * Hard rules this module owns:
 * - Risk heuristics are WARNINGS, never silent blocks. `classifyServerRisk` and
 *   the destructive-tool-name detector only RANK and DESCRIBE; the UI may gate a
 *   high-impact change behind a confirmation, but it never refuses outright.
 * - It reuses the spec-14 transport metadata (`transportMeta`) and the spec-15
 *   catalog transport metadata rather than reinventing the local/remote split,
 *   so the labels stay identical across the servers and catalog pages.
 * - It reads only NON-SECRET facts: transport, auth status, the KEY NAMES of
 *   secret-bearing config (never values), and tool NAMES. No secret value is
 *   ever read here.
 *
 * Copy is sentence case, no em/en-dashes, per June conventions.
 */

import {
  isLocalSubprocess,
  redactedEnv,
  redactedHeaders,
  transportMeta,
} from "./mcp-servers-view";
import { isLocalSubprocessEntry } from "./mcp-catalog-view";
import type { HermesMcpCatalogEntry, HermesMcpServerInfo } from "./schemas";

// ---------------------------------------------------------------------------
// Security labels — the explicit, sentence-case badges spec 19 calls for.
// ---------------------------------------------------------------------------

/** A stable code for each security label, so the UI can style by code and a
 * test can assert which labels a server earns without matching copy. */
export type McpSecurityLabelCode =
  | "local-subprocess"
  | "remote-server"
  | "oauth"
  | "secret-backed"
  | "sandbox-constrained"
  | "unrestricted-capable";

/** One security label: a code, a short sentence-case pill label, and a one-line
 * blurb that explains the boundary in plain language. */
export type McpSecurityLabel = {
  code: McpSecurityLabelCode;
  label: string;
  blurb: string;
  /** The tone the UI styles the badge with. `caution` reads as a thing to be
   * aware of (secrets, a remote endpoint, an unrestricted runtime); `neutral`
   * is informational. */
  tone: "neutral" | "caution";
};

/** The fixed copy for each label. Centralized so the servers page and the
 * catalog page render identical wording. */
const LABEL_COPY: Readonly<Record<McpSecurityLabelCode, McpSecurityLabel>> =
  Object.freeze({
    "local-subprocess": {
      code: "local-subprocess",
      label: "Local subprocess",
      blurb:
        "Runs on this Mac as a child process of the Hermes and June runtime.",
      tone: "caution",
    },
    "remote-server": {
      code: "remote-server",
      label: "Remote server",
      blurb: "Receives requests over the network. Tools run outside this Mac.",
      tone: "caution",
    },
    oauth: {
      code: "oauth",
      label: "OAuth",
      blurb: "Can act as the connected account within the scopes you grant it.",
      tone: "caution",
    },
    "secret-backed": {
      code: "secret-backed",
      label: "Secret-backed",
      blurb:
        "Environment or header values are exposed to the server process or request.",
      tone: "caution",
    },
    "sandbox-constrained": {
      code: "sandbox-constrained",
      label: "Sandbox constrained",
      blurb:
        "In sandboxed sessions, writes outside allowed roots may be denied.",
      tone: "neutral",
    },
    "unrestricted-capable": {
      code: "unrestricted-capable",
      label: "Unrestricted capable",
      blurb:
        "In unrestricted sessions, it can write anywhere your user account can, unless the server limits itself.",
      tone: "caution",
    },
  });

/** Looks up the fixed label metadata for a code. */
export function securityLabel(code: McpSecurityLabelCode): McpSecurityLabel {
  return LABEL_COPY[code];
}

/**
 * The security labels a configured MCP server earns, in a stable display order.
 * A local (stdio) server is a local subprocess and carries both sandbox
 * boundaries (constrained in sandboxed sessions, unrestricted-capable in Full
 * mode). A remote server is a remote-server; an OAuth server adds the OAuth
 * label. Any server with configured env/header KEYS is secret-backed.
 */
export function securityLabelsFor(
  server: HermesMcpServerInfo,
): McpSecurityLabel[] {
  const codes: McpSecurityLabelCode[] = [];
  const local = isLocalSubprocess(server);
  if (local) {
    codes.push("local-subprocess");
  } else if (server.transport !== "unknown") {
    codes.push("remote-server");
  }
  if (usesOauthAuth(server)) codes.push("oauth");
  if (isSecretBacked(server)) codes.push("secret-backed");
  // The sandbox boundary applies to LOCAL subprocesses: those are the ones the
  // Seatbelt write-jail constrains (a remote server runs off-machine, so June's
  // sandbox does not bound its filesystem reach).
  if (local) {
    codes.push("sandbox-constrained");
    codes.push("unrestricted-capable");
  }
  return codes.map(securityLabel);
}

/**
 * The security labels a CATALOG entry earns before install. Mirrors
 * {@link securityLabelsFor} but reads the entry's declared transport / auth /
 * subprocess flags (a catalog entry carries no live secret config yet, so it is
 * never secret-backed until installed). Lets the catalog page show the same
 * boundary badges the server will carry once installed.
 */
export function securityLabelsForEntry(
  entry: HermesMcpCatalogEntry,
): McpSecurityLabel[] {
  const codes: McpSecurityLabelCode[] = [];
  const local = isLocalSubprocessEntry(entry);
  if (local) {
    codes.push("local-subprocess");
  } else if (entry.transport !== "unknown") {
    codes.push("remote-server");
  }
  if (entry.auth === "oauth" || entry.transport === "http-oauth") {
    codes.push("oauth");
  }
  // A catalog entry that declares required env values will be secret-backed once
  // installed; surface that up front so the boundary is not a surprise.
  if ((entry.requiredEnv ?? []).length > 0) codes.push("secret-backed");
  if (local) {
    codes.push("sandbox-constrained");
    codes.push("unrestricted-capable");
  }
  return codes.map(securityLabel);
}

/** The labels the MCP server / catalog ROWS already show through their
 * transport pill (local subprocess vs remote server). Filtered out of the
 * inline security-label strip so the row does not show the same thing twice;
 * the full canonical set still comes from {@link securityLabelsFor} (used by the
 * legend and the risk model). */
const TRANSPORT_REDUNDANT: ReadonlySet<McpSecurityLabelCode> = new Set([
  "local-subprocess",
  "remote-server",
]);

/** The security labels to render INLINE on a row, given the full canonical set:
 * the transport-equivalent labels (local subprocess / remote server) are dropped
 * because the row's transport pill already conveys them. Keeps the OAuth /
 * secret-backed / sandbox boundary labels, which the transport pill does not. */
export function inlineSecurityLabels(
  labels: readonly McpSecurityLabel[],
): McpSecurityLabel[] {
  return labels.filter((label) => !TRANSPORT_REDUNDANT.has(label.code));
}

/** True when a server authenticates as a connected account (OAuth or a real,
 * non `not-required` auth status). A bare stdio server is never OAuth. */
function usesOauthAuth(server: HermesMcpServerInfo): boolean {
  if (server.transport === "http-oauth") return true;
  if (server.transport === "stdio") return false;
  return (
    server.auth === "authenticated" ||
    server.auth === "unauthenticated" ||
    server.auth === "expired"
  );
}

/** True when a server carries any configured env or header KEY (a value is set,
 * which June never reads — it only counts the key names). */
export function isSecretBacked(server: HermesMcpServerInfo): boolean {
  return redactedEnv(server).length > 0 || redactedHeaders(server).length > 0;
}

// ---------------------------------------------------------------------------
// Risk classification — heuristic, WARNING-only.
// ---------------------------------------------------------------------------

/** The risk tier June assigns a server/entry. `high` means a high-impact
 * enable/install that warrants a confirmation; `elevated` is worth a note but
 * not a gate; `standard` is the baseline. This is ADVISORY: it never blocks. */
export type McpRiskTier = "standard" | "elevated" | "high";

/** A single reason a server was flagged, with a sentence-case explanation, so
 * the warning can list exactly what tripped the heuristic rather than a bare
 * "high risk". */
export type McpRiskReason = {
  /** Stable code for the matched category, for styling / testing. */
  code:
    | "filesystem"
    | "shell"
    | "browser"
    | "database"
    | "cloud-admin"
    | "destructive-tool"
    | "local-write";
  /** Sentence-case explanation of why this matters. */
  detail: string;
};

/** The full risk assessment for a server or catalog entry. */
export type McpRiskAssessment = {
  tier: McpRiskTier;
  /** True when an enable/install should require an explicit confirmation. */
  requiresConfirmation: boolean;
  /** The reasons, highest-signal first. Empty for a standard-risk server. */
  reasons: McpRiskReason[];
  /** The destructive-named tools detected, if any, so the UI can name them. */
  destructiveTools: string[];
};

/** Keyword groups that mark a high-risk capability category. Matched against a
 * server's name, command/url, and tool names. Substrings are deliberate (a
 * `filesystem` server, an `fs` tool, a `postgres` command all match). */
const CATEGORY_KEYWORDS: Readonly<
  Record<
    Exclude<McpRiskReason["code"], "destructive-tool" | "local-write">,
    { keywords: string[]; detail: string }
  >
> = Object.freeze({
  filesystem: {
    keywords: [
      "filesystem",
      "file-system",
      "file_system",
      "filesystem",
      "files",
      "filer",
      "fs-",
      "-fs",
      "directory",
      "folder",
    ],
    detail:
      "Reads and writes files. In unrestricted sessions it can reach anything your user account can.",
  },
  shell: {
    keywords: [
      "shell",
      "bash",
      "zsh",
      "terminal",
      "command",
      "exec",
      "subprocess",
      "process",
      "run-command",
      "runcommand",
    ],
    detail:
      "Runs shell commands. A shell tool can do anything the running user can do.",
  },
  browser: {
    keywords: [
      "browser",
      "puppeteer",
      "playwright",
      "chromium",
      "chrome",
      "webdriver",
      "selenium",
      "headless",
    ],
    detail:
      "Drives a browser. It can reach any site you are signed in to and act there.",
  },
  database: {
    keywords: [
      "database",
      "postgres",
      "postgresql",
      "mysql",
      "mariadb",
      "sqlite",
      "mongo",
      "mongodb",
      "redis",
      "clickhouse",
      "snowflake",
      "bigquery",
      "-sql",
      "sql-",
    ],
    detail:
      "Connects to a database. It can read and modify the data it can reach.",
  },
  "cloud-admin": {
    keywords: [
      "aws",
      "gcp",
      "azure",
      "cloudformation",
      "terraform",
      "kubernetes",
      "kubectl",
      "k8s",
      "cloudflare",
      "digitalocean",
      "heroku",
      "admin-api",
      "cloud-admin",
    ],
    detail:
      "Administers cloud infrastructure. It can change or destroy live resources.",
  },
});

/** Verb stems that mark a tool name as destructive. Matched as a substring of a
 * lowercased tool name, so `delete_workspace`, `dropTable`, `rm_file`, and
 * `destroy-stack` all match. These are WARNINGS: a destructive-named tool is
 * surfaced, never auto-removed (filtering is the user's call, owned by the tool
 * selection surface, spec 16). */
const DESTRUCTIVE_TOKENS: readonly string[] = [
  "delete",
  "destroy",
  "remove",
  "drop",
  "truncate",
  "wipe",
  "purge",
  "erase",
  "rmdir",
  "rm-",
  "rm_",
  "kill",
  "terminate",
  "revoke",
  "overwrite",
  "format",
  "reset",
];

/** True when a tool name reads as destructive. Substring match on a lowercased
 * name, with a couple of guards so `undelete` / `removed_at`-style false
 * positives stay rare. A WARNING signal only. */
export function isDestructiveToolName(name: string): boolean {
  const lower = name.toLowerCase();
  // `undelete` / `undo` are recoveries, not destructive.
  if (lower.startsWith("un")) return false;
  return DESTRUCTIVE_TOKENS.some((token) => {
    if (token.endsWith("-") || token.endsWith("_")) {
      // A separator-anchored token (rm-, rm_) must match at a boundary.
      return lower.includes(token);
    }
    return lower.includes(token);
  });
}

/** The destructive-named tools a server currently exposes, in input order. */
export function destructiveToolsFor(server: HermesMcpServerInfo): string[] {
  return (server.tools ?? [])
    .map((tool) => tool.name)
    .filter((name) => isDestructiveToolName(name));
}

/**
 * Classifies a configured server's risk. Reads the server's name, command/url,
 * and tool names against the high-risk capability keywords and the
 * destructive-tool-name heuristic. A LOCAL subprocess is at minimum elevated
 * (it runs code on this Mac); any high-risk category or a destructive-named
 * tool lifts it to `high` and requires a confirmation before enable.
 *
 * This NEVER blocks: it only ranks and explains. The caller decides whether to
 * show a note (elevated) or gate behind a confirmation (high).
 */
export function classifyServerRisk(
  server: HermesMcpServerInfo,
): McpRiskAssessment {
  const haystack = riskHaystack(
    server.name,
    server.command,
    server.url,
    (server.tools ?? []).map((tool) => tool.name),
  );
  const destructiveTools = destructiveToolsFor(server);
  return assess(haystack, isLocalSubprocess(server), destructiveTools);
}

/**
 * Classifies a CATALOG entry's risk before install, from its declared name,
 * description, transport, subprocess flag, and default tool names. Same
 * heuristic and same warning-only contract as {@link classifyServerRisk}, so
 * the catalog install confirmation matches what the enabled server will warn.
 */
export function classifyEntryRisk(
  entry: HermesMcpCatalogEntry,
): McpRiskAssessment {
  const haystack = riskHaystack(
    entry.name,
    entry.installName,
    entry.description,
    entry.defaultTools ?? [],
  );
  const destructiveTools = (entry.defaultTools ?? []).filter((name) =>
    isDestructiveToolName(name),
  );
  return assess(haystack, isLocalSubprocessEntry(entry), destructiveTools);
}

/** Shared assessment from a prepared haystack + the local/destructive signals. */
function assess(
  haystack: string,
  local: boolean,
  destructiveTools: string[],
): McpRiskAssessment {
  const reasons: McpRiskReason[] = [];

  for (const [code, group] of Object.entries(CATEGORY_KEYWORDS)) {
    if (group.keywords.some((keyword) => haystack.includes(keyword))) {
      reasons.push({
        code: code as McpRiskReason["code"],
        detail: group.detail,
      });
    }
  }

  if (destructiveTools.length > 0) {
    reasons.push({
      code: "destructive-tool",
      detail: `Exposes tools whose names suggest destructive actions: ${destructiveTools.join(", ")}.`,
    });
  }

  // A local subprocess always carries the local-write boundary note, even with
  // no category match, so the sandbox/full-mode implication is never silent.
  const hasHighCategory = reasons.length > 0;
  if (local) {
    reasons.push({
      code: "local-write",
      detail:
        "Runs local code. In unrestricted sessions it may modify files your user account can modify.",
    });
  }

  // High when a high-risk category or a destructive tool is present. A local
  // subprocess with no category match is elevated (worth a note, no gate). A
  // remote server with no category match is standard.
  const tier: McpRiskTier = hasHighCategory
    ? "high"
    : local
      ? "elevated"
      : "standard";

  return {
    tier,
    requiresConfirmation: tier === "high",
    reasons,
    destructiveTools,
  };
}

/** Builds the lowercased haystack risk keywords are matched against: the name,
 * the command/url (or install id / description), and every tool name. */
function riskHaystack(
  name: string,
  secondary: string | undefined,
  tertiary: string | undefined,
  tools: readonly string[],
): string {
  return [name, secondary, tertiary, ...tools]
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Warning copy — the exact strings spec 19 specifies.
// ---------------------------------------------------------------------------

/** The headline warning shown before enabling/installing a high-risk server
 * that runs local code and exposes file tools. This is the spec's exact copy. */
export const LOCAL_FILE_TOOLS_WARNING =
  "This MCP server runs local code and exposes file tools. In unrestricted sessions it may modify files your user account can modify.";

/** The recommendation June makes for a high-risk server after its first
 * successful test: switch to allowlist mode (the include filter), which the
 * tool selection surface owns (spec 16). Advisory copy only; June links there,
 * it does not build the editor here. */
export const ALLOWLIST_RECOMMENDATION =
  "This server is high risk. After you test it, allow only the specific tools you need rather than every tool it exposes.";

/** Builds the confirmation copy for a high-impact enable. Leads with the
 * file-tools warning when the server runs local code, then lists the matched
 * reasons so the user sees exactly what tripped the heuristic. Returns a
 * structured object (title + lines) so the dialog can render without parsing a
 * blob. */
export type McpRiskConfirmation = {
  title: string;
  /** The lead warning sentence. */
  lead: string;
  /** The matched reasons, sentence-case, for a bulleted list. */
  reasons: string[];
};

/** Confirmation copy for enabling an already-configured high-risk server. */
export function enableConfirmationFor(
  server: HermesMcpServerInfo,
): McpRiskConfirmation {
  const assessment = classifyServerRisk(server);
  const local = isLocalSubprocess(server);
  return {
    title: `Enable ${server.name}?`,
    lead: local
      ? LOCAL_FILE_TOOLS_WARNING
      : "This MCP server can act on your behalf. Review what it can do before enabling it.",
    reasons: assessment.reasons.map((reason) => reason.detail),
  };
}

/** Confirmation copy for installing a high-risk catalog entry. */
export function installConfirmationFor(
  entry: HermesMcpCatalogEntry,
): McpRiskConfirmation {
  const assessment = classifyEntryRisk(entry);
  const local = isLocalSubprocessEntry(entry);
  return {
    title: `Install ${entry.name}?`,
    lead: local
      ? LOCAL_FILE_TOOLS_WARNING
      : "This MCP server can act on your behalf. Review what it can do before installing it.",
    reasons: assessment.reasons.map((reason) => reason.detail),
  };
}

// ---------------------------------------------------------------------------
// Global default MCP exposure policy.
// ---------------------------------------------------------------------------

/** The global default policy for how new MCP servers are exposed. Conservative
 * by default: a freshly installed server is disabled until the user opts it in.
 *
 * - `install-disabled` (DEFAULT): install servers disabled; the user enables
 *   each one deliberately after reviewing it.
 * - `enable-with-allowlist`: enable a new server but recommend an allowlist of
 *   tools (the include filter, spec 16) so only chosen tools are exposed.
 * - `enable-all`: enable a new server with all of its tools. The least
 *   conservative option; June warns when it is selected.
 */
export type McpExposurePolicy =
  | "install-disabled"
  | "enable-with-allowlist"
  | "enable-all";

/** The conservative default the spec calls for: nothing is enabled until the
 * user opts in. */
export const DEFAULT_MCP_EXPOSURE_POLICY: McpExposurePolicy =
  "install-disabled";

/** The dotted config path the policy persists at in a profile's `config.yaml`.
 * Stored through the same `PUT /api/config` REST surface the jailed dashboard
 * owns (so there is no June-side EPERM), and read back from `GET /api/config`.
 * The one source of truth for the read and the write. */
export const MCP_EXPOSURE_POLICY_CONFIG_PATH = "mcp.exposure_policy";

/** A sentence-case label + description for each policy option, for the setting
 * surface. Centralized so the radio group and any summary read identically. */
export type McpExposurePolicyMeta = {
  policy: McpExposurePolicy;
  label: string;
  description: string;
  /** True for the conservative recommended default, so the UI can mark it. */
  recommended: boolean;
};

const POLICY_META: Readonly<Record<McpExposurePolicy, McpExposurePolicyMeta>> =
  Object.freeze({
    "install-disabled": {
      policy: "install-disabled",
      label: "Install disabled by default",
      description:
        "New servers install turned off. You enable each one after reviewing it. Most conservative.",
      recommended: true,
    },
    "enable-with-allowlist": {
      policy: "enable-with-allowlist",
      label: "Enable with a safe allowlist",
      description:
        "New servers turn on, but allow only the tools you choose rather than every tool they expose.",
      recommended: false,
    },
    "enable-all": {
      policy: "enable-all",
      label: "Enable all tools",
      description:
        "New servers turn on with every tool they expose. Least conservative.",
      recommended: false,
    },
  });

/** The display metadata for a policy. */
export function exposurePolicyMeta(
  policy: McpExposurePolicy,
): McpExposurePolicyMeta {
  return POLICY_META[policy];
}

/** Every policy option in display order (most conservative first). */
export function exposurePolicyOptions(): McpExposurePolicyMeta[] {
  return [
    POLICY_META["install-disabled"],
    POLICY_META["enable-with-allowlist"],
    POLICY_META["enable-all"],
  ];
}

/** Normalizes an arbitrary config value into a known policy, falling back to the
 * conservative default for anything unrecognized (a missing key, a typo, a junk
 * value). Tolerates the hyphen and underscore spellings. */
export function normalizeExposurePolicy(value: unknown): McpExposurePolicy {
  if (typeof value !== "string") return DEFAULT_MCP_EXPOSURE_POLICY;
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  if (
    normalized === "install-disabled" ||
    normalized === "disabled" ||
    normalized === "install-disabled-by-default"
  ) {
    return "install-disabled";
  }
  if (
    normalized === "enable-with-allowlist" ||
    normalized === "enable-with-safe-allowlist" ||
    normalized === "allowlist"
  ) {
    return "enable-with-allowlist";
  }
  if (normalized === "enable-all" || normalized === "all") {
    return "enable-all";
  }
  return DEFAULT_MCP_EXPOSURE_POLICY;
}

/** Reads the exposure policy out of a parsed config tree. Walks
 * `mcp.exposure_policy`, normalizing whatever is found (or the default when
 * absent). Defensive: tolerates the key being absent or malformed. */
export function readExposurePolicy(
  config: Record<string, unknown>,
): McpExposurePolicy {
  const mcp = config.mcp;
  if (mcp && typeof mcp === "object" && !Array.isArray(mcp)) {
    return normalizeExposurePolicy(
      (mcp as Record<string, unknown>).exposure_policy,
    );
  }
  return DEFAULT_MCP_EXPOSURE_POLICY;
}
