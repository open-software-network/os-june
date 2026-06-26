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
