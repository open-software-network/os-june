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
  ToolsetsController,
  availableToolNames,
  availableToolsetNames,
  explainSkill,
  filterToolsets,
  hasUnmetRequirement,
  lastRefreshedLabel,
  parseSkill,
  parseToolset,
  skillRequirements,
  toolsetLabel,
  toolsetMode,
  toolsetStatus,
  useToolsetsController,
  type HermesSkillInfo,
  type HermesToolsetInfo,
  type ToolsetsEngine,
  type ToolsetsState,
} from "../lib/hermes-admin";
import { ToolsetsView } from "../components/settings/ToolsetsSection";
import { makeAdminHarness } from "./fixtures/hermes-admin-harness";
import {
  emptyInstallScenario,
  profileIsolationScenarios,
  toolsetsInventoryScenario,
} from "./fixtures/hermes-admin-scenarios";

/** Parses a wire-shaped toolset, so `raw`-reading helpers see what the client
 * would hand them. */
function toolsetFromWire(raw: Record<string, unknown>): HermesToolsetInfo {
  const toolset = parseToolset(raw);
  if (!toolset) throw new Error("fixture did not parse");
  return toolset;
}

function skillFromWire(raw: Record<string, unknown>): HermesSkillInfo {
  const skill = parseSkill(raw);
  if (!skill) throw new Error("fixture did not parse");
  return skill;
}

// ---------------------------------------------------------------------------
// Schema parsing: new toolset fields (modes, configured, label).
// ---------------------------------------------------------------------------

describe("toolsets — schema parsing", () => {
  it("parses mode allowance from a nested object", () => {
    const toolset = toolsetFromWire({
      name: "terminal",
      enabled: true,
      modes: { sandboxed: false, unrestricted: true },
    });
    expect(toolset.modes).toEqual({ sandboxed: false, unrestricted: true });
  });

  it("parses mode allowance from an array of mode names", () => {
    const toolset = toolsetFromWire({
      name: "web",
      enabled: true,
      modes: ["sandboxed", "unrestricted"],
    });
    expect(toolset.modes).toEqual({ sandboxed: true, unrestricted: true });
  });

  it("leaves modes undefined when the wire reports nothing", () => {
    const toolset = toolsetFromWire({ name: "memory", enabled: true });
    expect(toolset.modes).toBeUndefined();
  });

  it("reads requirements with satisfied flags", () => {
    const toolset = toolsetFromWire({
      name: "github",
      enabled: false,
      requirements: [{ label: "GITHUB_TOKEN", satisfied: false }],
    });
    expect(toolset.requirements).toEqual([
      { label: "GITHUB_TOKEN", satisfied: false },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Pure view logic: status, mode display, search, last refreshed.
// ---------------------------------------------------------------------------

describe("toolsets — status derivation", () => {
  it("marks an enabled toolset with met requirements active", () => {
    const view = toolsetStatus(toolsetFromWire({ name: "web", enabled: true }));
    expect(view.status).toBe("active");
    expect(view.tone).toBe("positive");
  });

  it("marks a disabled toolset inactive", () => {
    const view = toolsetStatus(
      toolsetFromWire({ name: "calendar", enabled: false }),
    );
    expect(view.status).toBe("inactive");
  });

  it("marks a toolset with an unmet requirement as missing setup, even if enabled", () => {
    const view = toolsetStatus(
      toolsetFromWire({
        name: "github",
        enabled: true,
        requirements: [{ label: "GITHUB_TOKEN", satisfied: false }],
      }),
    );
    expect(view.status).toBe("missing-setup");
    expect(view.label).toBe("Missing setup");
  });

  it("honors an explicit configured:false as missing setup", () => {
    const view = toolsetStatus(
      toolsetFromWire({ name: "x", enabled: true, configured: false }),
    );
    expect(view.status).toBe("missing-setup");
  });

  it("does not treat a requirement without a satisfied flag as unmet", () => {
    const toolset = toolsetFromWire({
      name: "x",
      enabled: true,
      requirements: [{ label: "SOME_VAR" }],
    });
    expect(hasUnmetRequirement(toolset)).toBe(false);
    expect(toolsetStatus(toolset).status).toBe("active");
  });
});

describe("toolsets — mode display (no invented state)", () => {
  it("shows both modes", () => {
    expect(toolsetMode({ sandboxed: true, unrestricted: true }).label).toBe(
      "Sandboxed and Full mode",
    );
  });

  it("shows Full mode only", () => {
    const view = toolsetMode({ sandboxed: false, unrestricted: true });
    expect(view.label).toBe("Full mode only");
    expect(view.unknown).toBe(false);
  });

  it("marks an unreported allowance as unknown rather than guessing", () => {
    const view = toolsetMode(undefined);
    expect(view.unknown).toBe(true);
    expect(view.label).toBe("Mode unknown");
  });

  it("never uses an em or en dash in mode copy", () => {
    for (const modes of [
      { sandboxed: true, unrestricted: true },
      { sandboxed: false, unrestricted: true },
      { sandboxed: true, unrestricted: false },
      { sandboxed: false, unrestricted: false },
      undefined,
    ]) {
      const view = toolsetMode(modes);
      expect(view.label).not.toMatch(/[–—]/);
      expect(view.detail).not.toMatch(/[–—]/);
    }
  });
});

describe("toolsets — search and labels", () => {
  const toolsets = [
    toolsetFromWire({
      name: "web",
      description: "Web search and fetch",
      enabled: true,
      tools: ["web_search", "web_fetch"],
    }),
    toolsetFromWire({
      name: "github",
      label: "GitHub",
      enabled: false,
      tools: ["gh_pr"],
      requirements: [{ label: "GITHUB_TOKEN", satisfied: false }],
    }),
  ];

  it("filters by name, tool name, and requirement label", () => {
    expect(filterToolsets(toolsets, "web").map((t) => t.name)).toEqual(["web"]);
    expect(filterToolsets(toolsets, "gh_pr").map((t) => t.name)).toEqual([
      "github",
    ]);
    expect(filterToolsets(toolsets, "github_token").map((t) => t.name)).toEqual(
      ["github"],
    );
  });

  it("returns all when the query is blank", () => {
    expect(filterToolsets(toolsets, "  ").length).toBe(2);
  });

  it("prefers the reported label over the name", () => {
    expect(toolsetLabel(toolsets[1])).toBe("GitHub");
    expect(toolsetLabel(toolsets[0])).toBe("web");
  });
});

describe("toolsets — last refreshed label", () => {
  it("formats relative times and the not-yet case", () => {
    const now = 1_000_000;
    expect(lastRefreshedLabel(undefined, now)).toBe("Not refreshed yet");
    expect(lastRefreshedLabel(now, now)).toBe("Refreshed just now");
    expect(lastRefreshedLabel(now - 30_000, now)).toBe(
      "Refreshed 30 seconds ago",
    );
    expect(lastRefreshedLabel(now - 60_000, now)).toBe(
      "Refreshed 1 minute ago",
    );
    expect(lastRefreshedLabel(now - 3_600_000, now)).toBe(
      "Refreshed 1 hour ago",
    );
  });
});

// ---------------------------------------------------------------------------
// Skill activation explanations against the toolset inventory.
// ---------------------------------------------------------------------------

describe("toolsets — skill requirement explanations", () => {
  const toolsets = [
    toolsetFromWire({
      name: "web",
      enabled: true,
      tools: ["web_search"],
    }),
    toolsetFromWire({
      name: "github",
      enabled: false,
      tools: ["gh_pr"],
      requirements: [{ label: "GITHUB_TOKEN", satisfied: false }],
    }),
  ];

  it("computes which toolsets and tools are available", () => {
    expect(availableToolsetNames(toolsets)).toEqual(new Set(["web"]));
    // github is disabled + unmet requirement, so its tools are NOT available.
    expect(availableToolNames(toolsets)).toEqual(new Set(["web_search"]));
  });

  it("explains a visible skill whose required toolset is available", () => {
    const skill = skillFromWire({
      name: "research",
      enabled: true,
      requires_toolsets: ["web"],
    });
    const explanation = explainSkill(skill, toolsets);
    expect(explanation.status).toBe("visible");
    expect(explanation.message).toContain("web");
    expect(explanation.message).toContain("Visible because");
  });

  it("explains a hidden fallback skill superseded by an available toolset", () => {
    const skill = skillFromWire({
      name: "legacy-search",
      enabled: false,
      fallback_for_toolsets: ["web"],
    });
    const explanation = explainSkill(skill, toolsets);
    expect(explanation.status).toBe("hidden");
    expect(explanation.message).toContain("Hidden because web is available");
  });

  it("explains a skill blocked by an unavailable required toolset", () => {
    const skill = skillFromWire({
      name: "deploy",
      enabled: false,
      requires_toolsets: ["github"],
    });
    const explanation = explainSkill(skill, toolsets);
    expect(explanation.status).toBe("missing-setup");
    expect(explanation.message).toContain("github");
  });

  it("returns unknown for a skill with no declared requirements", () => {
    const skill = skillFromWire({ name: "notes", enabled: true });
    expect(skillRequirements(skill)).toBeUndefined();
    expect(explainSkill(skill, toolsets).status).toBe("unknown");
  });

  it("resolves requires_tools against available tools", () => {
    const skill = skillFromWire({
      name: "searcher",
      enabled: true,
      requires_tools: ["web_search"],
    });
    expect(explainSkill(skill, toolsets).status).toBe("visible");
    const blocked = skillFromWire({
      name: "pr-bot",
      enabled: false,
      requires_tools: ["gh_pr"],
    });
    expect(explainSkill(blocked, toolsets).status).toBe("missing-setup");
  });

  it("never uses an em or en dash in explanation copy", () => {
    const skill = skillFromWire({
      name: "research",
      enabled: true,
      requires_toolsets: ["web"],
    });
    expect(explainSkill(skill, toolsets).message).not.toMatch(/[–—]/);
  });
});

// ---------------------------------------------------------------------------
// Controller: loads toolsets + skills through the real client + fake server.
// ---------------------------------------------------------------------------

describe("toolsets — controller load", () => {
  it("loads toolsets and records a last-refreshed timestamp", async () => {
    const harness = makeAdminHarness(toolsetsInventoryScenario());
    const controller = new ToolsetsController(harness as ToolsetsEngine);
    await controller.load();

    const snapshot = controller.getSnapshot();
    expect(snapshot.status).toBe("ready");
    expect(snapshot.toolsets.map((t) => t.name)).toEqual([
      "web",
      "calendar",
      "github",
      "terminal",
      "memory",
    ]);
    expect(snapshot.lastRefreshedAt).toBeTypeOf("number");
    // Skills loaded too, for the explanations.
    expect(snapshot.skills.length).toBe(4);

    controller.dispose();
  });

  it("keeps rendering toolsets when the skills load fails", async () => {
    const harness = makeAdminHarness(toolsetsInventoryScenario());
    vi.spyOn(harness.client.skills, "list").mockRejectedValue(
      new Error("skills down"),
    );
    const controller = new ToolsetsController(harness as ToolsetsEngine);
    await controller.load();

    const snapshot = controller.getSnapshot();
    expect(snapshot.status).toBe("ready");
    expect(snapshot.toolsets.length).toBe(5);
    // Skills could not load; explanations simply degrade.
    expect(snapshot.skills).toEqual([]);

    controller.dispose();
  });

  it("keeps showing rows and surfaces the error inline when a refresh fails", async () => {
    const harness = makeAdminHarness(toolsetsInventoryScenario());
    const controller = new ToolsetsController(harness as ToolsetsEngine);
    await controller.load();
    expect(controller.getSnapshot().status).toBe("ready");

    vi.spyOn(harness.client.toolsets, "list").mockRejectedValueOnce(
      new Error("network down"),
    );
    await controller.load();

    const snapshot = controller.getSnapshot();
    expect(snapshot.status).toBe("ready");
    expect(snapshot.toolsets.length).toBeGreaterThan(0);
    expect(snapshot.error).toBeTruthy();

    controller.dispose();
  });

  it("refreshes toolsets when an MCP-style invalidation marks them stale (post-restart)", async () => {
    const harness = makeAdminHarness(toolsetsInventoryScenario());
    const controller = new ToolsetsController(harness as ToolsetsEngine);
    await controller.load();
    expect(controller.getSnapshot().toolsets.length).toBe(5);

    // Simulate a new MCP-backed toolset appearing after a gateway restart: the
    // next list() returns an extra toolset, and the cache is invalidated as a
    // restart's post-refresh would. The page picks it up off the stale signal
    // without knowing the rule itself.
    const augmented = await harness.client.toolsets.list();
    vi.spyOn(harness.client.toolsets, "list").mockResolvedValue([
      ...augmented,
      {
        name: "slack",
        enabled: true,
        tools: ["slack_post"],
        raw: { name: "slack", enabled: true },
      },
    ]);
    await act(async () => {
      harness.cache.invalidate(["toolsets"]);
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(
        controller.getSnapshot().toolsets.find((t) => t.name === "slack"),
      ).toBeTruthy(),
    );

    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// Profile isolation: two targets never cross-read toolsets.
// ---------------------------------------------------------------------------

describe("toolsets — profile isolation", () => {
  it("keys the toolsets cache per target", () => {
    const { sandboxed, unrestricted } = profileIsolationScenarios();
    const sandboxedHarness = makeAdminHarness(sandboxed, { mode: "sandboxed" });
    const unrestrictedHarness = makeAdminHarness(unrestricted, {
      mode: "unrestricted",
    });
    expect(sandboxedHarness.cache.keyFor("toolsets")).not.toBe(
      unrestrictedHarness.cache.keyFor("toolsets"),
    );
  });
});

// ---------------------------------------------------------------------------
// Hook binding.
// ---------------------------------------------------------------------------

describe("toolsets — useToolsetsController", () => {
  it("loads on mount", async () => {
    const harness = makeAdminHarness(toolsetsInventoryScenario());
    const { result } = renderHook(() =>
      useToolsetsController(harness as ToolsetsEngine),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.toolsets.length).toBe(5);
  });

  it("returns the unavailable state for a null engine", () => {
    const { result } = renderHook(() => useToolsetsController(null));
    expect(result.current.status).toBe("unavailable");
    expect(result.current.toolsets).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Component view: stubbed state.
// ---------------------------------------------------------------------------

const BASE_LIFECYCLE: ToolsetsState["lifecycle"] = {
  state: "clean",
  label: "Up to date",
  detail: "No pending changes.",
  canRestart: false,
};

function stubState(overrides: Partial<ToolsetsState> = {}): ToolsetsState {
  return {
    status: "ready",
    toolsets: [],
    skills: [],
    mode: "sandboxed",
    profile: "default",
    retryable: false,
    lastRefreshedAt: Date.now(),
    lifecycle: BASE_LIFECYCLE,
    notifications: [],
    refresh: vi.fn(),
    dismissNotification: vi.fn(),
    ...overrides,
  };
}

const VIEW_TOOLSETS: HermesToolsetInfo[] = [
  toolsetFromWire({
    name: "web",
    description: "Web search and fetch",
    enabled: true,
    tools: ["web_search", "web_fetch"],
    modes: { sandboxed: true, unrestricted: true },
  }),
  toolsetFromWire({
    name: "github",
    description: "GitHub operations",
    enabled: false,
    tools: ["gh_pr"],
    requirements: [{ label: "GITHUB_TOKEN", satisfied: false }],
    modes: { sandboxed: false, unrestricted: true },
  }),
  toolsetFromWire({
    name: "memory",
    description: "Long-term memory",
    enabled: true,
    tools: ["memory_read"],
  }),
];

const VIEW_SKILLS: HermesSkillInfo[] = [
  skillFromWire({
    name: "research",
    enabled: true,
    source: "hub",
    requires_toolsets: ["web"],
  }),
  skillFromWire({
    name: "deploy",
    enabled: false,
    source: "hub",
    requires_toolsets: ["github"],
  }),
  skillFromWire({ name: "notes", enabled: true, source: "bundled" }),
];

describe("ToolsetsView — component", () => {
  it("lists toolsets with status, tools, and mode", () => {
    render(<ToolsetsView state={stubState({ toolsets: VIEW_TOOLSETS })} />);
    expect(screen.getByText("web")).toBeInTheDocument();

    const webRow = within(screen.getByText("web").closest("li") as HTMLElement);
    expect(webRow.getByText("Active")).toBeInTheDocument();
    expect(webRow.getByText("web_search")).toBeInTheDocument();
    expect(webRow.getByText("Sandboxed and Full mode")).toBeInTheDocument();

    const githubRow = within(
      screen.getByText("github").closest("li") as HTMLElement,
    );
    expect(githubRow.getByText("Missing setup")).toBeInTheDocument();
    expect(githubRow.getByText("GITHUB_TOKEN")).toBeInTheDocument();
    expect(githubRow.getByText("Full mode only")).toBeInTheDocument();

    const memoryRow = within(
      screen.getByText("memory").closest("li") as HTMLElement,
    );
    expect(memoryRow.getByText("Mode unknown")).toBeInTheDocument();
  });

  it("filters by search query", () => {
    render(<ToolsetsView state={stubState({ toolsets: VIEW_TOOLSETS })} />);
    const search = screen.getByRole("searchbox", { name: /filter toolsets/i });
    fireEvent.change(search, { target: { value: "github" } });
    expect(screen.getByText("github")).toBeInTheDocument();
    expect(screen.queryByText("web")).not.toBeInTheDocument();
  });

  it("explains why skills are visible, hidden, or waiting on setup", () => {
    render(
      <ToolsetsView
        state={stubState({ toolsets: VIEW_TOOLSETS, skills: VIEW_SKILLS })}
      />,
    );
    expect(screen.getByText("Skill availability")).toBeInTheDocument();
    // research: visible (web available).
    const researchRow = within(
      screen.getByText("research").closest("li") as HTMLElement,
    );
    expect(researchRow.getByText(/Visible because/)).toBeInTheDocument();
    // deploy: missing setup (github unavailable).
    const deployRow = within(
      screen.getByText("deploy").closest("li") as HTMLElement,
    );
    expect(deployRow.getByText(/Not useful until/)).toBeInTheDocument();
    // notes: no metadata -> dropped from the section entirely.
    expect(screen.queryByText("notes")).not.toBeInTheDocument();
  });

  it("hides the skill-availability section when no skill declares metadata", () => {
    render(
      <ToolsetsView
        state={stubState({
          toolsets: VIEW_TOOLSETS,
          skills: [skillFromWire({ name: "notes", enabled: true })],
        })}
      />,
    );
    expect(screen.queryByText("Skill availability")).not.toBeInTheDocument();
  });

  it("shows the last-refreshed line", () => {
    render(
      <ToolsetsView
        state={stubState({
          toolsets: VIEW_TOOLSETS,
          lastRefreshedAt: undefined,
        })}
      />,
    );
    expect(screen.getByText("Not refreshed yet")).toBeInTheDocument();
  });

  it("calls refresh when the refresh button is clicked", () => {
    const refresh = vi.fn();
    render(
      <ToolsetsView state={stubState({ toolsets: VIEW_TOOLSETS, refresh })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(refresh).toHaveBeenCalled();
  });

  it("shows the Hermes-not-running surface when unavailable", () => {
    render(<ToolsetsView state={stubState({ status: "unavailable" })} />);
    expect(screen.getByText("Hermes is not running")).toBeInTheDocument();
    expect(
      screen.getByRole("searchbox", { name: /filter toolsets/i }),
    ).toBeDisabled();
  });

  it("shows the no-toolsets empty state for an empty ready list", () => {
    render(<ToolsetsView state={stubState({ toolsets: [] })} />);
    expect(screen.getByText("No toolsets reported")).toBeInTheDocument();
  });

  it("shows an inline error with retry when the load failed", () => {
    const refresh = vi.fn();
    render(
      <ToolsetsView
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

  it("renders dismissible durable notifications", () => {
    const dismissNotification = vi.fn();
    render(
      <ToolsetsView
        state={stubState({
          toolsets: VIEW_TOOLSETS,
          dismissNotification,
          notifications: [
            {
              id: "n1",
              message: "Gateway restarted. Tool inventory refreshed.",
              timing: "immediate",
              mutation: "gateway.restart",
              at: Date.now(),
            },
          ],
        })}
      />,
    );
    expect(
      screen.getByText("Gateway restarted. Tool inventory refreshed."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(dismissNotification).toHaveBeenCalledWith("n1");
  });

  it("renders an empty inventory end to end through the controller hook", async () => {
    const harness = makeAdminHarness(emptyInstallScenario());
    function Mounted() {
      const state = useToolsetsController(harness as ToolsetsEngine);
      return <ToolsetsView state={state} />;
    }
    render(<Mounted />);
    await waitFor(() =>
      expect(screen.getByText("No toolsets reported")).toBeInTheDocument(),
    );
  });
});
