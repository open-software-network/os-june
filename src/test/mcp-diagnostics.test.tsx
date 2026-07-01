import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  buildDiagnosticBundle,
  diagnoseServer,
  diagnosticBundleFilename,
  explainMissingTool,
  parseMcpServer,
  registeredToolName,
  resolveToolPolicy,
  serializeDiagnosticBundle,
  summarizeHealth,
  useMcpDiagnosticsController,
  type HermesMcpServerInfo,
  type HermesMcpTestResult,
  type McpDiagnosticsState,
  type McpServersEngine,
} from "../lib/hermes-admin";
import { McpDiagnosticsView } from "../components/settings/McpDiagnosticsSection";
import { makeAdminHarness } from "./fixtures/hermes-admin-harness";
import { mcpDiagnosticsScenario } from "./fixtures/hermes-admin-scenarios";

/** Parses a wire-shaped object into a HermesMcpServerInfo so the raw-reading
 * diagnostics helpers see exactly what the client would hand them. */
function serverFromWire(raw: Record<string, unknown>): HermesMcpServerInfo {
  const server = parseMcpServer(raw);
  if (!server) throw new Error("fixture did not parse");
  return server;
}

// ---------------------------------------------------------------------------
// Tool prefixing + include/exclude policy resolution.
// ---------------------------------------------------------------------------

describe("mcp diagnostics — tool policy", () => {
  it("derives the mcp_<server>_<tool> registered name", () => {
    expect(registeredToolName("linear", "delete_workspace")).toBe(
      "mcp_linear_delete_workspace",
    );
  });

  it("resolves an exclude filter as the reason a tool is filtered", () => {
    const server = serverFromWire({
      name: "linear",
      enabled: true,
      transport: "http",
      url: "https://mcp.linear.app",
      tools: [
        { name: "create_issue", enabled: true },
        { name: "delete_workspace", enabled: true },
      ],
      exclude_tools: ["delete_workspace"],
    });
    const policy = resolveToolPolicy(server);
    expect(policy.allowed).toEqual(["create_issue"]);
    expect(policy.filtered).toEqual(["delete_workspace"]);
    expect(
      policy.tools.find((t) => t.name === "delete_workspace")?.reason,
    ).toBe("excluded");
  });

  it("treats an include list as an allowlist", () => {
    const server = serverFromWire({
      name: "github",
      enabled: true,
      transport: "http",
      url: "https://api.githubcopilot.com/mcp",
      tools: [
        { name: "list_issues", enabled: true },
        { name: "delete_repo", enabled: true },
      ],
      include_tools: ["list_issues"],
    });
    const policy = resolveToolPolicy(server);
    expect(policy.hasInclude).toBe(true);
    expect(policy.allowed).toEqual(["list_issues"]);
    expect(policy.tools.find((t) => t.name === "delete_repo")?.reason).toBe(
      "not-in-include",
    );
  });

  it("includes extra discovered tool names not in the stored list", () => {
    const server = serverFromWire({
      name: "sqlite",
      enabled: true,
      transport: "stdio",
      command: "mcp-server-sqlite",
      tools: [{ name: "query", enabled: true }],
    });
    const policy = resolveToolPolicy(server, ["query", "schema"]);
    expect(policy.allowed).toContain("schema");
  });
});

// ---------------------------------------------------------------------------
// Per-server diagnosis: failure modes.
// ---------------------------------------------------------------------------

describe("mcp diagnostics — diagnoseServer", () => {
  it("flags a disabled server as the root cause and suppresses downstream noise", () => {
    const server = serverFromWire({
      name: "github",
      enabled: false,
      transport: "http",
      url: "https://api.githubcopilot.com/mcp",
      status: "connected",
      tools: [{ name: "list_issues", enabled: true }],
    });
    const diagnostics = diagnoseServer(server);
    expect(diagnostics.issues).toHaveLength(1);
    expect(diagnostics.issues[0].code).toBe("disabled");
    // A disabled server registers nothing.
    expect(diagnostics.derivedRegisteredTools).toHaveLength(0);
  });

  it("flags a missing OAuth sign-in", () => {
    const server = serverFromWire({
      name: "linear",
      enabled: true,
      transport: "http-oauth",
      url: "https://mcp.linear.app/sse",
      auth_status: "unauthenticated",
      status: "error",
    });
    const diagnostics = diagnoseServer(server);
    expect(diagnostics.issues.map((i) => i.code)).toContain("auth-missing");
  });

  it("flags a failed connection from a bad command", () => {
    const server = serverFromWire({
      name: "broken",
      enabled: true,
      transport: "stdio",
      command: "this-binary-does-not-exist",
      auth_status: "not-required",
      status: "error",
      status_message: "Could not start the server (command not found).",
    });
    const diagnostics = diagnoseServer(server);
    const issue = diagnostics.issues.find((i) => i.code === "connection-error");
    expect(issue?.message).toMatch(/command not found/i);
  });

  it("flags a filter that excludes every tool", () => {
    const server = serverFromWire({
      name: "filtered",
      enabled: true,
      transport: "http",
      url: "https://api.example.com/mcp",
      status: "connected",
      tools: [
        { name: "read", enabled: true },
        { name: "write", enabled: true },
      ],
      exclude_tools: ["read", "write"],
    });
    const diagnostics = diagnoseServer(server);
    expect(diagnostics.issues.map((i) => i.code)).toContain(
      "filter-excludes-all",
    );
    expect(diagnostics.derivedRegisteredTools).toHaveLength(0);
  });

  it("marks the inventory stale when a restart is pending", () => {
    const server = serverFromWire({
      name: "sqlite",
      enabled: true,
      transport: "stdio",
      command: "mcp-server-sqlite",
      status: "connected",
    });
    const diagnostics = diagnoseServer(server, { restartPending: true });
    expect(diagnostics.freshness).toBe("restart-pending");
  });

  it("distinguishes test-time discovery from stored config", () => {
    const server = serverFromWire({
      name: "sqlite",
      enabled: true,
      transport: "stdio",
      command: "mcp-server-sqlite",
      status: "connected",
      tools: [{ name: "stored_tool", enabled: true }],
    });
    const testResult: HermesMcpTestResult = {
      name: "sqlite",
      ok: true,
      tools: [{ name: "query" }, { name: "schema" }],
      raw: {},
    };
    const diagnostics = diagnoseServer(server, { testResult });
    expect(diagnostics.discoveredFromTest).toBe(true);
    expect(diagnostics.discoveredTools.map((t) => t.name)).toEqual([
      "query",
      "schema",
    ]);
  });

  it("reads timeouts and resource/prompt utility availability from raw", () => {
    const server = serverFromWire({
      name: "sqlite",
      enabled: true,
      transport: "stdio",
      command: "mcp-server-sqlite",
      status: "connected",
      timeout_seconds: 30,
      connect_timeout: 5,
      capabilities: { resources: true, prompts: false },
    });
    const diagnostics = diagnoseServer(server);
    expect(diagnostics.timeoutSeconds).toBe(30);
    expect(diagnostics.connectTimeoutSeconds).toBe(5);
    expect(diagnostics.resourcesAvailable).toBe(true);
    expect(diagnostics.promptsAvailable).toBe(false);
  });

  it("reads missing env/header KEY names without leaking values", () => {
    const server = serverFromWire({
      name: "github",
      enabled: true,
      transport: "http",
      url: "https://api.githubcopilot.com/mcp",
      status: "error",
      missing_env: ["GITHUB_TOKEN"],
      missing_headers: ["Authorization"],
    });
    const diagnostics = diagnoseServer(server);
    expect(diagnostics.missingEnv).toEqual(["GITHUB_TOKEN"]);
    expect(diagnostics.missingHeaders).toEqual(["Authorization"]);
  });
});

// ---------------------------------------------------------------------------
// Missing-tool reason chain.
// ---------------------------------------------------------------------------

describe("mcp diagnostics — reason chain", () => {
  const servers = [
    serverFromWire({
      name: "linear",
      enabled: true,
      transport: "http",
      url: "https://mcp.linear.app",
      status: "connected",
      tools: [
        { name: "create_issue", enabled: true },
        { name: "delete_workspace", enabled: true },
      ],
      exclude_tools: ["delete_workspace"],
    }),
    serverFromWire({
      name: "github",
      enabled: false,
      transport: "http",
      url: "https://api.githubcopilot.com/mcp",
      status: "connected",
      tools: [{ name: "list_issues", enabled: true }],
    }),
  ];

  it("explains an excluded tool concretely", () => {
    const reason = explainMissingTool(servers, "mcp_linear_delete_workspace");
    expect(reason.available).toBe(false);
    expect(reason.reason).toContain("tool filtering excludes delete_workspace");
  });

  it("explains a disabled server's tools", () => {
    const reason = explainMissingTool(servers, "mcp_github_list_issues");
    expect(reason.available).toBe(false);
    expect(reason.reason).toMatch(/server is disabled/i);
    expect(reason.reason).toMatch(/restart the gateway/i);
  });

  it("confirms an available tool", () => {
    const reason = explainMissingTool(servers, "mcp_linear_create_issue");
    expect(reason.available).toBe(true);
  });

  it("explains an unknown server", () => {
    const reason = explainMissingTool(servers, "mcp_unknown_do_thing");
    expect(reason.available).toBe(false);
    expect(reason.reason).toMatch(/no mcp server/i);
  });

  it("explains a tool the server does not expose", () => {
    const reason = explainMissingTool(servers, "mcp_linear_nonexistent");
    expect(reason.available).toBe(false);
    expect(reason.reason).toMatch(/does not expose a tool named nonexistent/i);
  });
});

// ---------------------------------------------------------------------------
// Global health summary.
// ---------------------------------------------------------------------------

describe("mcp diagnostics — health summary", () => {
  it("counts enabled, disabled, failing, and auth-needed", () => {
    const servers = [
      serverFromWire({
        name: "ok",
        enabled: true,
        transport: "stdio",
        command: "x",
        status: "connected",
      }),
      serverFromWire({
        name: "off",
        enabled: false,
        transport: "stdio",
        command: "x",
      }),
      serverFromWire({
        name: "fail",
        enabled: true,
        transport: "stdio",
        command: "x",
        status: "error",
      }),
      serverFromWire({
        name: "auth",
        enabled: true,
        transport: "http-oauth",
        url: "https://x",
        auth_status: "unauthenticated",
      }),
    ];
    const summary = summarizeHealth(servers, true);
    expect(summary).toMatchObject({
      total: 4,
      enabled: 3,
      disabled: 1,
      failing: 1,
      authNeeded: 1,
      restartPending: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Sanitized diagnostic bundle export.
// ---------------------------------------------------------------------------

describe("mcp diagnostics — sanitized export", () => {
  it("exports key names, never secret values, and redacts a secret-shaped status message", () => {
    const servers = [
      serverFromWire({
        name: "github",
        enabled: true,
        transport: "http",
        url: "https://api.githubcopilot.com/mcp",
        status: "connected",
        // A status message that leaked a secret-shaped token must be redacted.
        status_message:
          "Last auth used token sk0123456789abcdef0123456789abcdef",
        headers: { Authorization: "Bearer sk-super-secret-value-do-not-leak" },
        env: { GITHUB_TOKEN: "ghp_secret_value_should_never_export" },
        include_tools: ["list_issues"],
        tools: [{ name: "list_issues", enabled: true }],
      }),
    ];
    const bundle = buildDiagnosticBundle(servers, {
      profile: "default",
      mode: "sandboxed",
      restartPending: false,
      now: new Date("2026-06-26T00:00:00Z"),
    });
    const text = serializeDiagnosticBundle(bundle);

    // KEY names are present (not secret), values are not.
    expect(text).toContain("GITHUB_TOKEN");
    expect(text).toContain("Authorization");
    expect(text).not.toContain("ghp_secret_value_should_never_export");
    expect(text).not.toContain("sk-super-secret-value-do-not-leak");
    // The secret-shaped token in the status message is masked.
    expect(text).not.toContain("sk0123456789abcdef0123456789abcdef");
    // Derived diagnostics survive.
    expect(text).toContain("mcp_github_list_issues");
    expect(bundle.summary.total).toBe(1);
  });

  it("builds a filesystem-safe filename", () => {
    const name = diagnosticBundleFilename(
      "default",
      new Date("2026-06-26T12:30:45.000Z"),
    );
    expect(name).toMatch(/^mcp-diagnostics-default-.*\.json$/);
    expect(name).not.toContain(":");
  });
});

// ---------------------------------------------------------------------------
// Controller: reuses the servers engine, run-all-tests, reason query.
// ---------------------------------------------------------------------------

describe("mcp diagnostics — controller", () => {
  it("derives diagnostics and summary from the loaded server list", async () => {
    const harness = makeAdminHarness(mcpDiagnosticsScenario());
    const { result } = renderHook(() =>
      useMcpDiagnosticsController(harness as McpServersEngine),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.summary.total).toBe(5);
    expect(result.current.summary.disabled).toBe(1);
    expect(result.current.summary.failing).toBeGreaterThanOrEqual(1);
    expect(result.current.summary.authNeeded).toBe(1);

    const filtered = result.current.servers.find(
      (d) => d.server.name === "filtered",
    );
    expect(filtered?.issues.map((i) => i.code)).toContain(
      "filter-excludes-all",
    );
  });

  it("runs all MCP tests and surfaces the per-server outcomes", async () => {
    const harness = makeAdminHarness(mcpDiagnosticsScenario());
    const { result } = renderHook(() =>
      useMcpDiagnosticsController(harness as McpServersEngine),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.runAllTests();
    });

    // The bad-command server's probe reported ok: false with a safe message.
    const broken = result.current.servers.find(
      (d) => d.server.name === "broken",
    );
    expect(broken?.server.status).toBe("error");
    expect(result.current.runningAll).toBe(false);
  });

  it("answers a missing-tool query through the controller", async () => {
    const harness = makeAdminHarness(mcpDiagnosticsScenario());
    const { result } = renderHook(() =>
      useMcpDiagnosticsController(harness as McpServersEngine),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.setToolQuery("mcp_filtered_read");
    });

    await waitFor(() => {
      expect(result.current.toolReason?.available).toBe(false);
      expect(result.current.toolReason?.reason).toMatch(/tool filtering/i);
    });
  });
});

// ---------------------------------------------------------------------------
// View rendering with a stubbed state (no Tauri, no network).
// ---------------------------------------------------------------------------

function stubState(
  overrides: Partial<McpDiagnosticsState> = {},
): McpDiagnosticsState {
  const server = serverFromWire({
    name: "linear",
    enabled: true,
    transport: "http-oauth",
    url: "https://mcp.linear.app/sse",
    auth_status: "unauthenticated",
    status: "error",
  });
  return {
    status: "ready",
    mode: "sandboxed",
    profile: "default",
    retryable: false,
    lifecycle: {
      state: "gateway-restart-required",
      label: "Restart required",
      detail: "Restart the Hermes gateway to apply your changes.",
      canRestart: true,
    },
    notifications: [],
    restartPending: true,
    servers: [diagnoseServer(server, { restartPending: true })],
    summary: summarizeHealth([server], true),
    testing: new Set<string>(),
    runningAll: false,
    toolQuery: "",
    toolReason: undefined,
    refresh: () => {},
    test: () => {},
    runAllTests: () => Promise.resolve(),
    setToolQuery: () => {},
    buildBundle: () =>
      buildDiagnosticBundle([server], {
        profile: "default",
        mode: "sandboxed",
        restartPending: true,
      }),
    dismissNotification: () => {},
    ...overrides,
  };
}

describe("mcp diagnostics — view", () => {
  it("renders the summary, the restart-pending warning, and a per-server reason", () => {
    render(<McpDiagnosticsView state={stubState()} />);
    expect(
      screen.getByRole("heading", { name: "MCP diagnostics" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Restart required/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /run all mcp tests/i }),
    ).toBeInTheDocument();
    // The server's auth issue reason is shown.
    expect(screen.getByText(/is not signed in/i)).toBeInTheDocument();
  });

  it("shows the empty state when Hermes is not running", () => {
    render(
      <McpDiagnosticsView
        state={stubState({ status: "unavailable", servers: [] })}
      />,
    );
    expect(screen.getByText("Hermes is not running")).toBeInTheDocument();
  });

  it("renders the missing-tool reason from the query result", () => {
    render(
      <McpDiagnosticsView
        state={stubState({
          toolQuery: "mcp_linear_x",
          toolReason: {
            query: "mcp_linear_x",
            server: "linear",
            tool: "x",
            available: false,
            reason:
              "mcp_linear_x is not available because linear is not signed in. Sign in and restart the gateway.",
          },
        })}
      />,
    );
    expect(
      screen.getByText(/is not available because linear is not signed in/i),
    ).toBeInTheDocument();
  });

  it("has no em or en dashes in any rendered copy", () => {
    const { container } = render(<McpDiagnosticsView state={stubState()} />);
    expect(container.textContent ?? "").not.toMatch(/[–—]/);
  });
});
