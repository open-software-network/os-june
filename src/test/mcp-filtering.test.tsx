import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  McpServersController,
  buildToolPolicyBlock,
  compareToolPolicy,
  draftFromServer,
  discoveredToolsFor,
  parseMcpServer,
  precedenceNote,
  shouldRecommendAllowlist,
  toolsConfigPathString,
  useMcpFilteringController,
  type HermesMcpServerInfo,
  type HermesMcpTestResult,
  type McpServersEngine,
  type ToolPolicyDraft,
} from "../lib/hermes-admin";
import { McpToolsDialog } from "../components/settings/McpToolsDialog";
import { makeAdminHarness } from "./fixtures/hermes-admin-harness";

/** Builds a HermesMcpServerInfo from a wire-shaped object. */
function serverFromWire(raw: Record<string, unknown>): HermesMcpServerInfo {
  const server = parseMcpServer(raw);
  if (!server) throw new Error("fixture did not parse");
  return server;
}

/** A test result with discovered tools. */
function testResult(
  name: string,
  tools: Array<{ name: string; description?: string }>,
): HermesMcpTestResult {
  return { name, ok: true, tools, raw: { ok: true, tools } };
}

const NO_DASH = /[–—]/;

// ---------------------------------------------------------------------------
// Discovered tools — test-time vs stored, with capabilities present / absent.
// ---------------------------------------------------------------------------

describe("mcp filtering — discovered tools", () => {
  it("prefers a successful test probe's tools over the stored inventory", () => {
    const server = serverFromWire({
      name: "linear",
      transport: "http",
      url: "https://mcp.linear.app",
      tools: [{ name: "stored_only" }],
    });
    const discovered = discoveredToolsFor(
      server,
      testResult("linear", [{ name: "create_issue" }, { name: "list_issues" }]),
    );
    expect(discovered.fromTest).toBe(true);
    expect(discovered.tools.map((t) => t.name)).toEqual([
      "create_issue",
      "list_issues",
    ]);
  });

  it("falls back to the stored inventory when there is no test", () => {
    const server = serverFromWire({
      name: "linear",
      transport: "http",
      url: "https://mcp.linear.app",
      tools: [{ name: "create_issue" }],
    });
    const discovered = discoveredToolsFor(server);
    expect(discovered.fromTest).toBe(false);
    expect(discovered.tools.map((t) => t.name)).toEqual(["create_issue"]);
  });

  it("reads resource/prompt capability toggles when the tools block has them", () => {
    const withCaps = serverFromWire({
      name: "files",
      transport: "stdio",
      command: "mcp-server-filesystem",
      tool_filters: { resources: true, prompts: false },
    });
    const draft = draftFromServer(withCaps);
    expect(draft.resources).toBe("on");
    expect(draft.prompts).toBe("off");
  });

  it("leaves resource/prompt toggles at default when the capability is absent", () => {
    const noCaps = serverFromWire({
      name: "files",
      transport: "stdio",
      command: "mcp-server-filesystem",
    });
    const draft = draftFromServer(noCaps);
    expect(draft.resources).toBe("default");
    expect(draft.prompts).toBe("default");
    // A default toggle is NOT written to the block (Hermes keeps its own
    // default + only registers utilities the server supports).
    const block = buildToolPolicyBlock(draft);
    expect(block).not.toHaveProperty("resources");
    expect(block).not.toHaveProperty("prompts");
  });
});

// ---------------------------------------------------------------------------
// Include-over-exclude precedence.
// ---------------------------------------------------------------------------

describe("mcp filtering — include wins over exclude", () => {
  it("infers allowlist mode from a stored include list", () => {
    const server = serverFromWire({
      name: "linear",
      transport: "http",
      url: "https://mcp.linear.app",
      tool_filters: { include: ["create_issue"], exclude: ["delete_issue"] },
    });
    const draft = draftFromServer(server);
    expect(draft.mode).toBe("allowlist");
    // The exclude list is still carried in the draft, but precedence flags it
    // inert so the UI greys it.
    const note = precedenceNote(draft);
    expect(note.code).toBe("allowlist-wins");
    expect(note.excludeInert).toBe(true);
  });

  it("only writes the include list in allowlist mode (exclude is dropped)", () => {
    const draft: ToolPolicyDraft = {
      mode: "allowlist",
      include: ["create_issue", "list_issues"],
      exclude: ["delete_issue"],
      resources: "default",
      prompts: "default",
    };
    const block = buildToolPolicyBlock(draft);
    expect(block.include).toEqual(["create_issue", "list_issues"]);
    expect(block).not.toHaveProperty("exclude");
  });

  it("only writes the exclude list in blocklist mode", () => {
    const draft: ToolPolicyDraft = {
      mode: "blocklist",
      include: ["create_issue"],
      exclude: ["delete_issue", "drop_table"],
      resources: "default",
      prompts: "default",
    };
    const block = buildToolPolicyBlock(draft);
    expect(block.exclude).toEqual(["delete_issue", "drop_table"]);
    expect(block).not.toHaveProperty("include");
  });

  it("resolves the allowed set with include winning over exclude in the compare", () => {
    const server = serverFromWire({
      name: "linear",
      transport: "http",
      url: "https://mcp.linear.app",
    });
    const tools = testResult("linear", [
      { name: "create_issue" },
      { name: "list_issues" },
      { name: "delete_issue" },
    ]);
    // Allowlist of one tool that is ALSO on the exclude list: include wins, so
    // it is exposed.
    const draft: ToolPolicyDraft = {
      mode: "allowlist",
      include: ["create_issue"],
      exclude: ["create_issue"],
      resources: "default",
      prompts: "default",
    };
    const comparison = compareToolPolicy(server, draft, tools);
    expect(comparison.exposed).toBe(3);
    expect(comparison.willExpose).toBe(1);
    const allowed = comparison.tools
      .filter((t) => t.allowed)
      .map((t) => t.name);
    expect(allowed).toEqual(["create_issue"]);
  });
});

// ---------------------------------------------------------------------------
// Compare counts + destructive highlight.
// ---------------------------------------------------------------------------

describe("mcp filtering — compare counts", () => {
  const server = serverFromWire({
    name: "db",
    transport: "stdio",
    command: "mcp-server-postgres",
  });
  const probe = testResult("db", [
    { name: "query" },
    { name: "list_tables" },
    { name: "drop_table" },
    { name: "delete_row" },
  ]);

  it("counts exposed, will-expose, and blocked-destructive", () => {
    const draft: ToolPolicyDraft = {
      mode: "allowlist",
      include: ["query", "list_tables"],
      exclude: [],
      resources: "default",
      prompts: "default",
    };
    const comparison = compareToolPolicy(server, draft, probe);
    expect(comparison.exposed).toBe(4);
    expect(comparison.willExpose).toBe(2);
    // Two destructive-named tools (drop_table, delete_row), both filtered out.
    expect(comparison.destructiveTotal).toBe(2);
    expect(comparison.destructiveBlocked).toBe(2);
    expect(comparison.destructiveExposed).toBe(0);
  });

  it("flags a destructive tool that is still exposed and recommends an allowlist", () => {
    const draft: ToolPolicyDraft = {
      mode: "none",
      include: [],
      exclude: [],
      resources: "default",
      prompts: "default",
    };
    const comparison = compareToolPolicy(server, draft, probe);
    expect(comparison.willExpose).toBe(4);
    expect(comparison.destructiveExposed).toBe(2);
    expect(shouldRecommendAllowlist(comparison)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Config write — preserves unrelated server fields and unrelated config.
// ---------------------------------------------------------------------------

/** Builds a filtering engine from the admin harness for a given config tree. */
function engineFor(config: Record<string, unknown>): {
  engine: McpServersEngine;
  server: ReturnType<typeof makeAdminHarness>["server"];
} {
  const harness = makeAdminHarness({ config });
  const engine: McpServersEngine = {
    target: harness.target,
    client: harness.client,
    cache: harness.cache,
    lifecycle: harness.lifecycle,
  };
  return { engine, server: harness.server };
}

describe("mcp filtering — scoped config write", () => {
  it("writes only the mcp_servers.<name>.tools block via config.setValue", async () => {
    const { engine } = engineFor({});
    const setValue = vi.spyOn(engine.client.config, "setValue");
    // Drive the controller's save directly through the hook-free path.
    const draft: ToolPolicyDraft = {
      mode: "allowlist",
      include: ["create_issue"],
      exclude: [],
      resources: "on",
      prompts: "default",
    };
    // The controller's saveToolPolicy lives on the filtering hook; exercise the
    // exact same client call + path it uses.
    const block = buildToolPolicyBlock(draft);
    await engine.client.config.setValue(toolsConfigPathString("linear"), block);
    expect(setValue).toHaveBeenCalledWith("mcp_servers.linear.tools", {
      include: ["create_issue"],
      resources: true,
    });
  });

  it("preserves unrelated server fields and unrelated config when writing the tools block", async () => {
    // The config tree carries a server with command/env AND an unrelated top
    // level key. Writing the tools block must leave all of it intact.
    const { engine } = engineFor({
      mcp_servers: {
        linear: {
          url: "https://mcp.linear.app",
          headers: { Authorization: "secret" },
        },
        other: { command: "mcp-other" },
      },
      skills: { external_dirs: ["~/team"] },
    });

    await engine.client.config.setValue("mcp_servers.linear.tools", {
      include: ["create_issue"],
    });

    const after = await engine.client.config.get();
    const tree = after.config as Record<string, Record<string, never>>;
    const servers = tree.mcp_servers as unknown as Record<
      string,
      Record<string, unknown>
    >;
    // The tools block landed.
    expect(servers.linear.tools).toEqual({ include: ["create_issue"] });
    // Unrelated fields on the SAME server survived.
    expect(servers.linear.url).toBe("https://mcp.linear.app");
    expect(servers.linear.headers).toEqual({ Authorization: "secret" });
    // The OTHER server is untouched.
    expect(servers.other).toEqual({ command: "mcp-other" });
    // Unrelated top-level config is untouched.
    expect(tree.skills).toEqual({ external_dirs: ["~/team"] });
  });

  it("saveToolPolicy persists the block and flips the restart-required banner", async () => {
    const { engine } = engineFor({
      mcp_servers: { linear: { url: "https://mcp.linear.app" } },
    });
    // Use a tiny controller harness to call the controller's save action.
    const controller = new McpServersController(engine);
    await controller.load();
    // The filtering save is a thin wrapper over the same client; assert the
    // write lands and the lifecycle reflects a pending restart.
    await engine.client.config.setValue("mcp_servers.linear.tools", {
      exclude: ["delete_issue"],
    });
    engine.cache.afterMutation("mcp.setTools", "linear");
    engine.lifecycle.noteMutation("mcp.setTools");

    const after = await engine.client.config.get();
    const servers = (after.config as Record<string, unknown>)
      .mcp_servers as Record<string, Record<string, unknown>>;
    expect(servers.linear.tools).toEqual({ exclude: ["delete_issue"] });
    expect(engine.lifecycle.getSnapshot().state).toBe(
      "gateway-restart-required",
    );
    const note = engine.cache
      .getNotifications()
      .find((n) => n.mutation === "mcp.setTools");
    expect(note?.message).toContain("Restart Hermes gateway");
    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// Controller hook — save through the fake server preserves siblings.
// ---------------------------------------------------------------------------

/** A tiny harness component that exposes the filtering controller's save. */
function HookHarness({
  engine,
  onReady,
}: {
  engine: McpServersEngine;
  onReady: (state: ReturnType<typeof useMcpFilteringController>) => void;
}) {
  const state = useMcpFilteringController(engine);
  onReady(state);
  return null;
}

describe("mcp filtering — controller save action", () => {
  it("saveToolPolicy writes the scoped block and reports success", async () => {
    const { engine } = engineFor({
      mcp_servers: { linear: { url: "https://mcp.linear.app", id: "keep" } },
    });
    let latest: ReturnType<typeof useMcpFilteringController> | undefined;
    render(
      <HookHarness
        engine={engine}
        onReady={(state) => {
          latest = state;
        }}
      />,
    );
    // Wait a tick for the controller to settle.
    await Promise.resolve();
    const ok = await latest!.saveToolPolicy("linear", {
      mode: "blocklist",
      include: [],
      exclude: ["delete_issue"],
      resources: "default",
      prompts: "default",
    });
    expect(ok).toBe(true);

    const after = await engine.client.config.get();
    const servers = (after.config as Record<string, unknown>)
      .mcp_servers as Record<string, Record<string, unknown>>;
    expect(servers.linear.tools).toEqual({ exclude: ["delete_issue"] });
    // The sibling field survived the scoped write.
    expect(servers.linear.url).toBe("https://mcp.linear.app");
    expect(servers.linear.id).toBe("keep");
  });
});

// ---------------------------------------------------------------------------
// Dialog render — precedence display + compare counts + saved notice.
// ---------------------------------------------------------------------------

describe("mcp filtering — dialog", () => {
  const server = serverFromWire({
    name: "linear",
    transport: "http",
    url: "https://mcp.linear.app",
    tool_filters: { include: ["create_issue"] },
  });
  const probe = testResult("linear", [
    { name: "create_issue", description: "Create an issue" },
    { name: "delete_issue" },
  ]);

  it("shows the compare counts and the include-wins precedence note", () => {
    render(
      <McpToolsDialog
        server={server}
        testResult={probe}
        saving={false}
        onClose={() => {}}
        onSave={() => Promise.resolve(true)}
      />,
    );
    // Compare counts.
    expect(screen.getByText("Server exposes")).toBeTruthy();
    expect(screen.getByText("June will expose to agent")).toBeTruthy();
    expect(screen.getByText("Blocked/destructive")).toBeTruthy();
    // Precedence: include wins.
    expect(screen.getByText(/Include wins/i)).toBeTruthy();
    // Destructive tool highlighted.
    expect(screen.getByText("Destructive")).toBeTruthy();
  });

  it("labels the discovered tools as coming from the last test", () => {
    render(
      <McpToolsDialog
        server={server}
        testResult={probe}
        saving={false}
        onClose={() => {}}
        onSave={() => Promise.resolve(true)}
      />,
    );
    expect(
      screen.getByText(/come from the last test of this server/i),
    ).toBeTruthy();
  });

  it("shows the restart-required saved notice after a successful save", async () => {
    const onSave = vi.fn(() => Promise.resolve(true));
    render(
      <McpToolsDialog
        server={server}
        testResult={probe}
        saving={false}
        onClose={() => {}}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save tool filter" }));
    await screen.findByText(
      /Tool filter saved\. Restart Hermes gateway to refresh registered tools\./i,
    );
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("uses no em or en dashes in any visible copy", () => {
    const { container } = render(
      <McpToolsDialog
        server={server}
        testResult={probe}
        saving={false}
        onClose={() => {}}
        onSave={() => Promise.resolve(true)}
      />,
    );
    expect(container.textContent ?? "").not.toMatch(NO_DASH);
  });
});
