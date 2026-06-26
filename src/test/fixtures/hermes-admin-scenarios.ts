/**
 * Named scenario fixtures for the fake Hermes dashboard server (spec 24). Test
 * infrastructure — not a test. Each factory returns a fresh, isolated
 * {@link FakeHermesScenario} (call them per test so state does not bleed across
 * cases). Together they cover the spec's required matrix: empty install, rich
 * install with bundled/hub/external skills, a skill security warning, pending
 * skill writes, MCP with no servers, MCP stdio with tools, MCP HTTP OAuth with
 * auth missing, MCP bad-command/timeout, tool include/exclude filtering, gateway
 * restart pending, and profile-switch data isolation.
 *
 * SECURITY: every secret-shaped value here is OBVIOUSLY FAKE (`sk-FAKE-...`,
 * `Bearer FAKE-...`) so a redaction-leak test has a concrete token to assert is
 * absent from logs. Never commit a real credential.
 */

import type { FakeHermesScenario } from "./fake-hermes-server";

/** A fake, unmistakably-not-real API key for redaction assertions. */
export const FAKE_SECRET = "sk-FAKE-0000000000000000000000000000";
/** A fake bearer header value for header-redaction assertions. */
export const FAKE_BEARER = "Bearer FAKE-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** A clean install: nothing configured. Empty-state surfaces render from this. */
export function emptyInstallScenario(): FakeHermesScenario {
  return {
    token: "fake-token-empty",
    skills: [],
    toolsets: [],
    mcpServers: [],
    mcpCatalog: [],
    hubResults: [],
    gateway: { gateway_running: false },
  };
}

/** A rich install: bundled + hub + external skills, toolsets with met/unmet
 * requirements, a healthy stdio MCP server, a catalog with one installed entry,
 * and hub search results. The general happy-path fixture. */
export function richInstallScenario(): FakeHermesScenario {
  return {
    token: "fake-token-rich",
    skills: [
      {
        name: "pdf",
        description: "Read and write PDFs",
        enabled: true,
        source: "bundled",
        version: "1.0.0",
      },
      {
        name: "research",
        description: "Multi-source research",
        enabled: false,
        source: "hub",
        version: "0.4.2",
      },
      {
        name: "company-style",
        description: "Internal style guide (loaded from ~/.agents/skills)",
        enabled: true,
        source: "external",
        read_only: true,
      },
    ],
    toolsets: [
      {
        name: "web",
        description: "Web search and fetch",
        enabled: true,
        tools: ["web_search", "web_fetch"],
      },
      {
        name: "github",
        description: "GitHub operations",
        enabled: false,
        tools: ["gh_issue", "gh_pr"],
        requirements: [{ label: "GITHUB_TOKEN", satisfied: false }],
      },
    ],
    mcpServers: [
      {
        name: "filesystem",
        enabled: true,
        transport: "stdio",
        command: "mcp-server-filesystem",
        status: "connected",
        auth_status: "not-required",
        tools: [
          { name: "read_file", enabled: true },
          { name: "write_file", enabled: true },
        ],
      },
    ],
    mcpCatalog: [
      {
        // Catalog entries are keyed by `name` (the install identifier).
        name: "github",
        description: "GitHub MCP server",
        transport: "http-oauth",
        installed: false,
        requires_oauth: true,
      },
      {
        name: "filesystem",
        description: "Local filesystem access",
        transport: "stdio",
        installed: true,
      },
    ],
    hubResults: [
      {
        identifier: "skills.sh/data-science",
        name: "Data science",
        description: "Notebooks, pandas, plotting",
        source: "skills.sh",
        installed: false,
      },
      {
        identifier: "github:acme/internal-skills/deploy",
        name: "Deploy",
        description: "Deploy helpers",
        source: "github",
        installed: false,
      },
    ],
    gateway: { gateway_running: true },
  };
}

/** A rich Skills Hub browse fixture: results across multiple sources and trust
 * levels, with tags/urls/version, plus a backgrounded install that progresses
 * over polls. Drives the hub browser's search states, source filter, inspect
 * drawer, and install-progress path. */
export function hubBrowseScenario(): FakeHermesScenario {
  return {
    token: "fake-token-hub",
    skills: [],
    hubResults: [
      {
        identifier: "official/pdf",
        name: "PDF",
        description: "Read and write PDFs",
        source: "official",
        trust: "official",
        category: "Documents",
        tags: ["documents", "office"],
        version: "1.2.0",
        installed: false,
      },
      {
        identifier: "skills.sh/data-science",
        name: "Data science",
        description: "Notebooks, pandas, plotting",
        source: "skills.sh",
        trust: "verified",
        tags: ["python", "data"],
        urls: ["https://skills.sh/data-science"],
        author: "skills.sh",
        installed: false,
      },
      {
        identifier: "github:acme/internal-skills/deploy",
        name: "Deploy",
        description: "Deploy helpers",
        source: "github",
        trust: "community",
        urls: ["https://github.com/acme/internal-skills"],
        installed: true,
        update_available: true,
      },
      {
        identifier: "https://example.test/raw/SKILL.md",
        name: "Quick note formatter",
        description: "Single-file skill from a URL",
        source: "url",
        trust: "unknown",
        installed: false,
      },
    ],
    backgroundActions: true,
    actionScripts: {
      install: {
        states: [
          { state: "queued" },
          { state: "running", progress: 40, message: "Fetching" },
          { state: "running", progress: 80, message: "Indexing" },
          { state: "succeeded", progress: 100 },
        ],
      },
    },
  };
}

/** A Skills Hub search result that should trigger a security review (a direct
 * URL single-file install from an untrusted source). The install endpoint still
 * works; the dangerous-block decision is a UI-layer concern, but the data that
 * drives it lives here. */
export function skillSecurityWarningScenario(): FakeHermesScenario {
  return {
    token: "fake-token-security",
    skills: [],
    hubResults: [
      {
        identifier: "https://example.test/raw/SKILL.md",
        name: "Unverified single-file skill",
        description: "Direct URL install — review before trusting",
        source: "url",
        installed: false,
      },
    ],
    backgroundActions: true,
    // The install action FAILS to exercise the failure/inline-error path a
    // security block or rejected install would produce.
    actionScripts: {
      install: {
        states: [
          { state: "running", progress: 20 },
          {
            state: "failed",
            error: "Install blocked: skill failed the security review.",
          },
        ],
      },
    },
  };
}

/** The full security-review matrix (spec 07): one hub result per scan verdict —
 * trusted (official, no review), caution (community with findings + scripts),
 * dangerous (blocked, no override), and unknown (unscanned direct URL). Drives
 * the review screen's verdict mapping, findings/affected-files/capabilities
 * surfacing, force-override gating, and the dangerous-no-override rule. */
export function skillScanStatesScenario(): FakeHermesScenario {
  return {
    token: "fake-token-scan",
    skills: [],
    hubResults: [
      {
        identifier: "official/pdf",
        name: "PDF",
        description: "Read and write PDFs",
        source: "official",
        trust: "official",
        scan: { verdict: "trusted", summary: "No issues found." },
      },
      {
        identifier: "skills.sh/scraper",
        name: "Web scraper",
        description: "Scrapes pages and posts results",
        source: "skills.sh",
        trust: "community",
        urls: ["https://skills.sh/scraper"],
        scan: {
          verdict: "caution",
          overridable: true,
          summary: "This skill makes network requests and runs helper scripts.",
          findings: [
            {
              category: "Network access",
              severity: "warn",
              detail: "Posts scraped content to an external endpoint.",
            },
            {
              category: "Helper scripts",
              severity: "info",
              detail: "Bundles a Python script the agent can run.",
            },
          ],
          affected_files: ["scraper/SKILL.md", "scraper/scripts/run.py"],
          capabilities: ["network", "shell"],
          bundle: { has_scripts: true, scripts: 1, references: 2 },
        },
      },
      {
        identifier: "github:evil/exfil",
        name: "Data exfiltrator",
        description: "Looks helpful, is not",
        source: "github",
        trust: "community",
        urls: ["https://github.com/evil/exfil"],
        scan: {
          verdict: "dangerous",
          // Even if upstream said overridable, June must never offer it.
          overridable: true,
          summary: "Blocked: attempts to read credentials and exfiltrate them.",
          findings: [
            {
              category: "Data exfiltration",
              severity: "danger",
              detail: "Reads ~/.aws/credentials and POSTs it to a remote host.",
            },
          ],
          affected_files: ["exfil/scripts/steal.sh"],
          capabilities: ["shell", "network", "filesystem"],
          bundle: { has_scripts: true, scripts: 1 },
        },
      },
      {
        identifier: "https://example.test/raw/SKILL.md",
        name: "Unscanned single-file skill",
        description: "Direct URL, no scan reported",
        source: "url",
        trust: "unknown",
      },
    ],
    backgroundActions: true,
    actionScripts: {
      install: {
        states: [
          { state: "running", progress: 50 },
          { state: "succeeded", progress: 100 },
        ],
      },
    },
  };
}

/** Pending skill writes: an agent-managed skill awaiting review (modeled as a
 * disabled hub skill plus a pending hub action). Exercises the "background
 * action in flight" cache path. */
export function pendingSkillWritesScenario(): FakeHermesScenario {
  return {
    token: "fake-token-pending",
    skills: [
      {
        name: "drafted-by-agent",
        description: "Proposed by the agent, awaiting review",
        enabled: false,
        source: "hub",
      },
    ],
    backgroundActions: true,
    actionScripts: {
      update: {
        states: [
          { state: "queued" },
          { state: "running", progress: 60 },
          { state: "succeeded", progress: 100 },
        ],
      },
    },
  };
}

/** Skill setup matrix (spec 09): a skill that declares a required secret (not
 * yet set), a skill with a required config value (already set) plus an optional
 * one (unset), and a skill that declares no setup at all. Drives the setup
 * panel's required-vs-optional, configured-vs-missing, and badge logic. The
 * env/config state is seeded so badges read realistically: `OPENAI_API_KEY` is
 * missing (badge: missing API key); `output_dir` is set, `model` is unset and
 * optional (badge: optional setup skipped). */
export function skillSetupScenario(): FakeHermesScenario {
  return {
    token: "fake-token-skill-setup",
    skills: [
      {
        name: "research",
        description: "Multi-source research",
        enabled: true,
        source: "hub",
        required_environment_variables: [
          {
            name: "OPENAI_API_KEY",
            prompt: "OpenAI API key",
            help: "Used to call the research model.",
            required_for: "model calls",
            required: true,
          },
          {
            name: "SERP_API_KEY",
            prompt: "Search API key",
            required: false,
          },
        ],
      },
      {
        name: "exporter",
        description: "Exports notes to disk",
        enabled: true,
        source: "hub",
        metadata: {
          hermes: {
            config: [
              {
                key: "output_dir",
                prompt: "Output directory",
                description: "Where exports are written.",
                default: "~/exports",
                required: true,
              },
              {
                key: "format",
                prompt: "Export format",
                default: "md",
                required: false,
              },
            ],
          },
        },
      },
      {
        name: "no-setup",
        description: "Needs nothing",
        enabled: true,
        source: "bundled",
      },
    ],
    // OPENAI_API_KEY is intentionally NOT set (missing required secret).
    env: { SERP_API_KEY: FAKE_SECRET },
    // output_dir is already configured; format is left at its default.
    config: { skills: { config: { exporter: { output_dir: "~/notes" } } } },
    gateway: { gateway_running: true },
  };
}

/** MCP with no servers configured. Empty-state for the MCP page. */
export function mcpNoServersScenario(): FakeHermesScenario {
  return {
    token: "fake-token-mcp-empty",
    mcpServers: [],
    mcpCatalog: [
      {
        name: "slack",
        transport: "http-oauth",
        requires_oauth: true,
      },
    ],
  };
}

/** An MCP stdio server with a tool inventory. Sandbox/full-mode UX hangs off the
 * stdio transport (it spawns a local subprocess). */
export function mcpStdioWithToolsScenario(): FakeHermesScenario {
  return {
    token: "fake-token-mcp-stdio",
    mcpServers: [
      {
        name: "sqlite",
        enabled: true,
        transport: "stdio",
        command: "mcp-server-sqlite --db ./data.db",
        status: "connected",
        auth_status: "not-required",
        // A secret env the server stores but must never echo in a GET.
        env: { SQLITE_KEY: FAKE_SECRET },
        tools: [
          { name: "query", description: "Run a read query", enabled: true },
          { name: "execute", description: "Run a write query", enabled: true },
          { name: "schema", description: "Inspect the schema", enabled: true },
        ],
      },
    ],
  };
}

/** An MCP HTTP server behind OAuth whose login is missing/expired. Drives the
 * "authenticate this server" flow. */
export function mcpOAuthAuthMissingScenario(): FakeHermesScenario {
  return {
    token: "fake-token-mcp-oauth",
    mcpServers: [
      {
        name: "linear",
        enabled: true,
        transport: "http-oauth",
        url: "https://mcp.linear.app/sse",
        auth_status: "unauthenticated",
        status: "error",
        status_message: "Not authenticated. Sign in to expose tools.",
        // A header secret the server stores but must never echo in a GET.
        headers: { Authorization: FAKE_BEARER },
      },
    ],
  };
}

/** An MCP stdio server with a bad command that fails its test (timeout/spawn
 * error). Drives the diagnostics/error UX. The test endpoint reports the
 * failure with a safe message. */
export function mcpBadCommandScenario(): FakeHermesScenario {
  return {
    token: "fake-token-mcp-bad",
    mcpServers: [
      {
        name: "broken",
        enabled: true,
        transport: "stdio",
        command: "this-binary-does-not-exist",
        status: "error",
        auth_status: "not-required",
        testOutcome: {
          ok: false,
          message: "Could not start the server (command not found).",
        },
      },
    ],
  };
}

/** An MCP server with include/exclude tool filters configured, for the tool
 * selection/filtering UX. */
export function mcpToolFilteringScenario(): FakeHermesScenario {
  return {
    token: "fake-token-mcp-filter",
    mcpServers: [
      {
        name: "github",
        enabled: true,
        transport: "http",
        url: "https://api.githubcopilot.com/mcp",
        status: "connected",
        auth_status: "authenticated",
        tools: [
          { name: "list_issues", enabled: true },
          { name: "create_issue", enabled: true },
          { name: "delete_repo", enabled: false },
        ],
        include_tools: ["list_issues", "create_issue"],
        exclude_tools: ["delete_repo"],
      },
    ],
  };
}

/** A mixed MCP install for the diagnostics surface (spec 18): a healthy stdio
 * server, a disabled server, an OAuth server that is not signed in, a stdio
 * server whose test fails (bad command), and a server whose include/exclude
 * filters hide every tool. Drives the global summary counts and the per-server
 * reason chains. */
export function mcpDiagnosticsScenario(): FakeHermesScenario {
  return {
    token: "fake-token-mcp-diagnostics",
    mcpServers: [
      {
        name: "sqlite",
        enabled: true,
        transport: "stdio",
        command: "mcp-server-sqlite",
        status: "connected",
        auth_status: "not-required",
        tools: [
          { name: "query", enabled: true },
          { name: "execute", enabled: true },
        ],
      },
      {
        name: "github",
        enabled: false,
        transport: "http",
        url: "https://api.githubcopilot.com/mcp",
        status: "connected",
        auth_status: "authenticated",
        tools: [{ name: "list_issues", enabled: true }],
      },
      {
        name: "linear",
        enabled: true,
        transport: "http-oauth",
        url: "https://mcp.linear.app/sse",
        auth_status: "unauthenticated",
        status: "error",
        status_message: "Not authenticated. Sign in to expose tools.",
        headers: { Authorization: FAKE_BEARER },
      },
      {
        name: "broken",
        enabled: true,
        transport: "stdio",
        command: "this-binary-does-not-exist",
        status: "error",
        auth_status: "not-required",
        status_message: "Could not start the server (command not found).",
        testOutcome: {
          ok: false,
          message: "Could not start the server (command not found).",
        },
      },
      {
        name: "filtered",
        enabled: true,
        transport: "http",
        url: "https://api.example.com/mcp",
        status: "connected",
        auth_status: "authenticated",
        tools: [
          { name: "read", enabled: true },
          { name: "write", enabled: true },
        ],
        exclude_tools: ["read", "write"],
      },
    ],
    mcpCatalog: [],
  };
}

/** A rich MCP catalog (spec 15): a Nous-approved catalog covering the four auth
 * shapes the install prompt must handle — no auth, API key (required env), OAuth,
 * and third-party auth — plus one already-installed-but-disabled entry. Catalog
 * install is a backgrounded action that progresses over polls and adds the server
 * to the MCP inventory, so the "installed entries appear in MCP servers" path is
 * exercised end to end. */
export function mcpCatalogBrowseScenario(): FakeHermesScenario {
  return {
    token: "fake-token-catalog",
    mcpServers: [],
    mcpCatalog: [
      {
        name: "fetch",
        title: "Fetch",
        description: "Fetch and read web pages",
        transport: "stdio",
        auth: "none",
        installed: false,
        default_tools: ["fetch"],
        source: "nous",
        command: "mcp-server-fetch",
      },
      {
        name: "github",
        title: "GitHub",
        description: "Issues, pull requests, and repository tools",
        transport: "http",
        auth: "api-key",
        required_env: [
          { key: "GITHUB_TOKEN", label: "GitHub personal access token" },
        ],
        installed: false,
        url: "https://api.githubcopilot.com/mcp",
      },
      {
        name: "linear",
        title: "Linear",
        description: "Linear issues over an OAuth-authenticated server",
        transport: "http-oauth",
        auth: "oauth",
        requires_oauth: true,
        installed: false,
        url: "https://mcp.linear.app/sse",
      },
      {
        name: "stripe",
        title: "Stripe",
        description: "Stripe data behind third-party authorization",
        transport: "http",
        auth: "third-party",
        installed: false,
        url: "https://mcp.stripe.com",
      },
      {
        name: "filesystem",
        title: "Filesystem",
        description: "Local filesystem access",
        transport: "stdio",
        auth: "none",
        installed: true,
        enabled: false,
        command: "mcp-server-filesystem",
      },
    ],
    backgroundActions: true,
    actionScripts: {
      "catalog-install": {
        states: [
          { state: "queued" },
          { state: "running", progress: 50, message: "Installing" },
          { state: "succeeded", progress: 100 },
        ],
      },
    },
  };
}

/** Gateway restart pending: backgrounded restart that progresses over polls.
 * Drives the restart banner/flow and post-restart invalidation. */
export function gatewayRestartPendingScenario(): FakeHermesScenario {
  return {
    token: "fake-token-restart",
    skills: [{ name: "pdf", enabled: true, source: "bundled" }],
    toolsets: [{ name: "web", enabled: true }],
    mcpServers: [
      {
        name: "filesystem",
        enabled: true,
        transport: "stdio",
        command: "mcp-server-filesystem",
        status: "connected",
      },
    ],
    gateway: { gateway_running: true },
    backgroundActions: true,
    actionScripts: {
      "gateway-restart": {
        states: [
          { state: "queued" },
          { state: "running", progress: 40 },
          { state: "running", progress: 80 },
          { state: "succeeded", progress: 100 },
        ],
      },
    },
  };
}

/** A gateway restart that FAILS, for the restart-failed banner path. */
export function gatewayRestartFailsScenario(): FakeHermesScenario {
  return {
    token: "fake-token-restart-fail",
    gateway: { gateway_running: true },
    backgroundActions: true,
    actionScripts: {
      "gateway-restart": {
        states: [
          { state: "running", progress: 30 },
          { state: "failed", error: "Gateway process did not come back up." },
        ],
      },
    },
  };
}

/** Two distinct profiles' data, for the profile-switch isolation test. The
 * SANDBOXED runtime sees `skill-a`; the UNRESTRICTED runtime sees `skill-b`.
 * Each is a separate fake server (separate token + base), proving a cache keyed
 * by mode+profile cannot surface the other's data. */
export function profileIsolationScenarios(): {
  sandboxed: FakeHermesScenario;
  unrestricted: FakeHermesScenario;
} {
  return {
    sandboxed: {
      token: "fake-token-profile-sandboxed",
      skills: [
        {
          name: "skill-a",
          description: "Only in sandboxed",
          enabled: true,
          source: "bundled",
        },
      ],
    },
    unrestricted: {
      token: "fake-token-profile-unrestricted",
      skills: [
        {
          name: "skill-b",
          description: "Only in unrestricted",
          enabled: true,
          source: "bundled",
        },
      ],
    },
  };
}

/** Toolsets inventory matrix (spec 04): an active toolset with met requirements,
 * an inactive one (off but otherwise fine), an MCP-backed toolset that is
 * missing setup (an unmet env var), a Full-mode-only toolset, and a toolset with
 * no reported mode allowance (so the page marks it unknown). Skills declare
 * requires/fallback metadata so the activation explanations can be exercised:
 * `research` requires the available `web` toolset (visible); `legacy-search`
 * falls back for `web` (hidden, since web is available); `deploy` requires the
 * unavailable `github` toolset (missing setup); `notes` declares nothing
 * (unknown, dropped from the explanations). */
export function toolsetsInventoryScenario(): FakeHermesScenario {
  return {
    token: "fake-token-toolsets",
    toolsets: [
      {
        name: "web",
        description: "Web search and fetch",
        enabled: true,
        tools: ["web_search", "web_fetch"],
        modes: { sandboxed: true, unrestricted: true },
      },
      {
        name: "calendar",
        description: "Calendar read and write",
        enabled: false,
        tools: ["calendar_list", "calendar_create"],
        modes: { sandboxed: true, unrestricted: true },
      },
      {
        name: "github",
        description: "GitHub operations (MCP-backed)",
        enabled: false,
        tools: ["gh_issue", "gh_pr"],
        requirements: [{ label: "GITHUB_TOKEN", satisfied: false }],
        modes: { sandboxed: false, unrestricted: true },
      },
      {
        name: "terminal",
        description: "Run shell commands",
        enabled: true,
        tools: ["bash"],
        // Full mode only — the sandboxed runtime blocks subprocesses.
        modes: { sandboxed: false, unrestricted: true },
      },
      {
        name: "memory",
        description: "Long-term memory store",
        enabled: true,
        tools: ["memory_read", "memory_write"],
        // No `modes` reported — the page must mark this unknown, not guess.
      },
    ],
    skills: [
      {
        name: "research",
        description: "Multi-source research",
        enabled: true,
        source: "hub",
        requires_toolsets: ["web"],
      },
      {
        name: "legacy-search",
        description: "Fallback search when web is unavailable",
        enabled: false,
        source: "bundled",
        fallback_for_toolsets: ["web"],
      },
      {
        name: "deploy",
        description: "Deploy helpers",
        enabled: false,
        source: "hub",
        requires_toolsets: ["github"],
      },
      {
        name: "notes",
        description: "Take notes (no declared requirements)",
        enabled: true,
        source: "bundled",
      },
    ],
    gateway: { gateway_running: true },
  };
}
