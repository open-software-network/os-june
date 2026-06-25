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
  InstalledSkillsController,
  categoriesOf,
  filterSkills,
  parseSkill,
  platformRestrictions,
  searchHaystack,
  skillActivation,
  skillCategory,
  skillPath,
  skillTags,
  sourceMeta,
  useInstalledSkillsController,
  type HermesSkillInfo,
  type InstalledSkillsEngine,
  type InstalledSkillsState,
} from "../lib/hermes-admin";
import { InstalledSkillsView } from "../components/settings/InstalledSkillsSection";
import { makeAdminHarness } from "./fixtures/hermes-admin-harness";
import {
  emptyInstallScenario,
  profileIsolationScenarios,
  richInstallScenario,
} from "./fixtures/hermes-admin-scenarios";

/** Builds a HermesSkillInfo by parsing a wire-shaped object, so `raw`-reading
 * view helpers see exactly what the client would hand them. */
function skillFromWire(raw: Record<string, unknown>): HermesSkillInfo {
  const skill = parseSkill(raw);
  if (!skill) throw new Error("fixture did not parse");
  return skill;
}

// ---------------------------------------------------------------------------
// Pure view logic (search / category / metadata). No render, no network.
// ---------------------------------------------------------------------------

describe("installed skills — view logic", () => {
  const skills: HermesSkillInfo[] = [
    skillFromWire({
      name: "pdf",
      description: "Read and write PDFs",
      enabled: true,
      source: "bundled",
      version: "1.0.0",
      tags: ["documents", "office"],
      category: "Documents",
    }),
    skillFromWire({
      name: "research",
      description: "Multi-source research",
      enabled: false,
      source: "hub",
      category: "Knowledge",
      requires_toolsets: ["web"],
      fallback_toolsets: ["github"],
    }),
    skillFromWire({
      name: "company-style",
      description: "Internal style guide",
      enabled: true,
      source: "external",
      read_only: true,
      path: "/Users/me/.agents/skills/company-style",
      platforms: ["macos"],
    }),
  ];

  it("maps each source to a sentence-case label", () => {
    expect(sourceMeta("bundled").label).toBe("Bundled");
    expect(sourceMeta("hub").label).toBe("Hub");
    expect(sourceMeta("external").label).toBe("External");
    expect(sourceMeta("unknown").label).toBe("Skill");
    // No dashes anywhere in the copy.
    for (const source of ["bundled", "hub", "external", "unknown"] as const) {
      expect(sourceMeta(source).blurb).not.toMatch(/[–—]/);
    }
  });

  it("searches by name, description, category, tags, source, version, and path", () => {
    expect(filterSkills(skills, { query: "PDF" }).map((s) => s.name)).toEqual([
      "pdf",
    ]);
    // description
    expect(
      filterSkills(skills, { query: "multi-source" }).map((s) => s.name),
    ).toEqual(["research"]);
    // tag
    expect(
      filterSkills(skills, { query: "office" }).map((s) => s.name),
    ).toEqual(["pdf"]);
    // source label
    expect(
      filterSkills(skills, { query: "external" }).map((s) => s.name),
    ).toEqual(["company-style"]);
    // path
    expect(
      filterSkills(skills, { query: ".agents/skills" }).map((s) => s.name),
    ).toEqual(["company-style"]);
    // version
    expect(filterSkills(skills, { query: "1.0.0" }).map((s) => s.name)).toEqual(
      ["pdf"],
    );
  });

  it("filters by category and lists categories present in the data", () => {
    expect(categoriesOf(skills)).toEqual(
      ["Documents", "Knowledge", "External"].sort(),
    );
    expect(
      filterSkills(skills, { category: "Knowledge" }).map((s) => s.name),
    ).toEqual(["research"]);
    // Category + query combine (AND).
    expect(
      filterSkills(skills, { category: "Documents", query: "research" }),
    ).toEqual([]);
  });

  it("derives a category, falling back to the source label", () => {
    expect(skillCategory(skills[0])).toBe("Documents");
    // company-style has no category field -> source label "External".
    expect(skillCategory(skills[2])).toBe("External");
  });

  it("extracts platform restrictions, tags, path, and conditional activation from raw", () => {
    expect(platformRestrictions(skills[2])).toEqual(["macos"]);
    expect(platformRestrictions(skills[0])).toBeUndefined();
    expect(skillTags(skills[0])).toEqual(["documents", "office"]);
    expect(skillPath(skills[2])).toBe("/Users/me/.agents/skills/company-style");
    expect(skillActivation(skills[1])).toEqual({
      requires: ["web"],
      fallback: ["github"],
    });
    expect(skillActivation(skills[0])).toBeUndefined();
  });

  it("includes activation toolsets in the search haystack", () => {
    expect(searchHaystack(skills[1])).toContain("web");
    expect(searchHaystack(skills[1])).toContain("github");
  });
});

// ---------------------------------------------------------------------------
// Toggle mutation: success, failure rollback, optimistic, read-only guard.
// Driven against the real client + fake server through the controller.
// ---------------------------------------------------------------------------

describe("installed skills — toggle mutation", () => {
  it("toggles a skill, refreshes, and records a next-session notification", async () => {
    const harness = makeAdminHarness(richInstallScenario());
    const controller = new InstalledSkillsController(
      harness as InstalledSkillsEngine,
    );
    await controller.load();

    expect(
      controller.getSnapshot().skills.find((s) => s.name === "research")
        ?.enabled,
    ).toBe(false);

    await controller.toggle("research", true);

    const snapshot = controller.getSnapshot();
    expect(snapshot.skills.find((s) => s.name === "research")?.enabled).toBe(
      true,
    );
    expect(snapshot.pending.size).toBe(0);
    // The shared lifecycle banner advanced to next-session, never "applied now".
    expect(snapshot.lifecycle.state).toBe("changes-apply-next-session");
    // A durable notification with the next-session copy was raised.
    expect(snapshot.notifications.at(-1)?.message).toContain("New sessions");
    expect(snapshot.notifications.at(-1)?.timing).toBe("next-session");
    // The fake server actually flipped state (so the refresh saw it too).
    const fresh = await harness.client.skills.list();
    expect(fresh.find((s) => s.name === "research")?.enabled).toBe(true);

    controller.dispose();
  });

  it("rolls back the optimistic flip and surfaces a safe error on failure", async () => {
    const harness = makeAdminHarness(richInstallScenario());
    const controller = new InstalledSkillsController(
      harness as InstalledSkillsEngine,
    );
    await controller.load();

    // Force the toggle to fail at the transport.
    const failure = new Error("boom");
    vi.spyOn(harness.client.skills, "toggle").mockRejectedValueOnce(failure);

    await controller.toggle("research", true);

    const snapshot = controller.getSnapshot();
    // Rolled back to the real (still disabled) state — the switch never lies.
    expect(snapshot.skills.find((s) => s.name === "research")?.enabled).toBe(
      false,
    );
    expect(snapshot.pending.size).toBe(0);
    expect(snapshot.error).toBeTruthy();
    // The fake server was never mutated.
    const fresh = await harness.client.skills.list();
    expect(fresh.find((s) => s.name === "research")?.enabled).toBe(false);

    controller.dispose();
  });

  it("shows a pending state on the row while the toggle is in flight", async () => {
    const harness = makeAdminHarness(richInstallScenario());
    const controller = new InstalledSkillsController(
      harness as InstalledSkillsEngine,
    );
    await controller.load();

    let resolveToggle: (() => void) | undefined;
    vi.spyOn(harness.client.skills, "toggle").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveToggle = () =>
            resolve({
              ok: true,
              result: { ok: true, name: "research", enabled: true },
              mutation: "skill.toggle",
              appliesAt: "next-session",
              requiresRestart: false,
            });
        }),
    );

    const toggling = controller.toggle("research", true);
    // While in flight: optimistic enabled + pending marker.
    expect(controller.getSnapshot().pending.has("research")).toBe(true);
    expect(
      controller.getSnapshot().skills.find((s) => s.name === "research")
        ?.enabled,
    ).toBe(true);

    resolveToggle?.();
    await toggling;
    expect(controller.getSnapshot().pending.has("research")).toBe(false);

    controller.dispose();
  });

  it("refuses to toggle a read-only external skill and explains why", async () => {
    const harness = makeAdminHarness(richInstallScenario());
    const toggleSpy = vi.spyOn(harness.client.skills, "toggle");
    const controller = new InstalledSkillsController(
      harness as InstalledSkillsEngine,
    );
    await controller.load();

    await controller.toggle("company-style", false);

    expect(toggleSpy).not.toHaveBeenCalled();
    expect(controller.getSnapshot().error).toContain("read-only");
    // Still enabled — unchanged.
    expect(
      controller.getSnapshot().skills.find((s) => s.name === "company-style")
        ?.enabled,
    ).toBe(true);

    controller.dispose();
  });

  it("keeps showing rows and surfaces the error inline when a refresh fails", async () => {
    const harness = makeAdminHarness(richInstallScenario());
    const controller = new InstalledSkillsController(
      harness as InstalledSkillsEngine,
    );
    await controller.load();
    expect(controller.getSnapshot().status).toBe("ready");

    vi.spyOn(harness.client.skills, "list").mockRejectedValueOnce(
      new Error("network down"),
    );
    await controller.load();

    const snapshot = controller.getSnapshot();
    // Rows remain (last good data) and status stays ready, with an inline error.
    expect(snapshot.status).toBe("ready");
    expect(snapshot.skills.length).toBeGreaterThan(0);
    expect(snapshot.error).toBeTruthy();

    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// Regression: profile isolation. A skill enabled in profile A is not shown
// enabled under profile B unless that profile reports it.
// ---------------------------------------------------------------------------

describe("installed skills — profile isolation", () => {
  it("does not leak one profile's skills/enabled-state into another", async () => {
    const { sandboxed, unrestricted } = profileIsolationScenarios();
    const sandboxedHarness = makeAdminHarness(sandboxed, { mode: "sandboxed" });
    const unrestrictedHarness = makeAdminHarness(unrestricted, {
      mode: "unrestricted",
    });

    const sandboxedController = new InstalledSkillsController(
      sandboxedHarness as InstalledSkillsEngine,
    );
    const unrestrictedController = new InstalledSkillsController(
      unrestrictedHarness as InstalledSkillsEngine,
    );
    await sandboxedController.load();
    await unrestrictedController.load();

    expect(sandboxedController.getSnapshot().skills.map((s) => s.name)).toEqual(
      ["skill-a"],
    );
    expect(
      unrestrictedController.getSnapshot().skills.map((s) => s.name),
    ).toEqual(["skill-b"]);
    // skill-a is unknown to the unrestricted runtime — it is simply not present.
    expect(
      unrestrictedController
        .getSnapshot()
        .skills.find((s) => s.name === "skill-a"),
    ).toBeUndefined();
    // The two caches key differently, so no cross-read is possible.
    expect(sandboxedHarness.cache.keyFor("skills")).not.toBe(
      unrestrictedHarness.cache.keyFor("skills"),
    );

    sandboxedController.dispose();
    unrestrictedController.dispose();
  });
});

// ---------------------------------------------------------------------------
// Hook binding: loads on mount, reflects a toggle end to end.
// ---------------------------------------------------------------------------

describe("installed skills — useInstalledSkillsController", () => {
  it("loads on mount and reflects a toggle through the snapshot", async () => {
    const harness = makeAdminHarness(richInstallScenario());
    const { result } = renderHook(() =>
      useInstalledSkillsController(harness as InstalledSkillsEngine),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.skills.length).toBe(3);

    await act(async () => {
      await result.current.toggle("research", true);
    });
    expect(
      result.current.skills.find((s) => s.name === "research")?.enabled,
    ).toBe(true);
  });

  it("returns the unavailable state for a null engine", () => {
    const { result } = renderHook(() => useInstalledSkillsController(null));
    expect(result.current.status).toBe("unavailable");
    expect(result.current.skills).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Component view: search box, category filter, toggle wiring, and the three
// distinct empty/unavailable/error surfaces. Driven with a stubbed state.
// ---------------------------------------------------------------------------

const BASE_LIFECYCLE: InstalledSkillsState["lifecycle"] = {
  state: "clean",
  label: "Up to date",
  detail: "No pending changes.",
  canRestart: false,
};

function stubState(
  overrides: Partial<InstalledSkillsState> = {},
): InstalledSkillsState {
  return {
    status: "ready",
    skills: [],
    mode: "sandboxed",
    profile: "default",
    pending: new Set<string>(),
    retryable: false,
    lifecycle: BASE_LIFECYCLE,
    notifications: [],
    refresh: vi.fn(),
    toggle: vi.fn(),
    dismissNotification: vi.fn(),
    ...overrides,
  };
}

const VIEW_SKILLS: HermesSkillInfo[] = [
  skillFromWire({
    name: "pdf",
    description: "Read and write PDFs",
    enabled: true,
    source: "bundled",
    category: "Documents",
  }),
  skillFromWire({
    name: "research",
    description: "Multi-source research",
    enabled: false,
    source: "hub",
    category: "Knowledge",
  }),
  skillFromWire({
    name: "company-style",
    description: "Internal style guide",
    enabled: true,
    source: "external",
    read_only: true,
  }),
];

describe("InstalledSkillsView — component", () => {
  it("lists installed skills with source labels and enabled state", () => {
    render(<InstalledSkillsView state={stubState({ skills: VIEW_SKILLS })} />);
    expect(screen.getByText("pdf")).toBeInTheDocument();
    expect(screen.getByText("research")).toBeInTheDocument();
    // Source pills render their sentence-case labels, scoped to each row (the
    // "External" label also appears as a fallback category chip).
    const pdfRow = within(screen.getByText("pdf").closest("li") as HTMLElement);
    expect(pdfRow.getByText("Bundled")).toBeInTheDocument();
    const researchRow = within(
      screen.getByText("research").closest("li") as HTMLElement,
    );
    expect(researchRow.getByText("Hub")).toBeInTheDocument();
    const externalRow = within(
      screen.getByText("company-style").closest("li") as HTMLElement,
    );
    expect(externalRow.getByText("External")).toBeInTheDocument();
    // The toggles reflect enabled state.
    const switches = screen.getAllByRole("switch");
    expect(switches[0]).toHaveAttribute("aria-checked", "true"); // pdf
    expect(switches[1]).toHaveAttribute("aria-checked", "false"); // research
  });

  it("filters by search query", async () => {
    render(<InstalledSkillsView state={stubState({ skills: VIEW_SKILLS })} />);
    const search = screen.getByRole("searchbox", {
      name: /filter installed skills/i,
    });
    fireEvent.change(search, { target: { value: "research" } });

    expect(screen.getByText("research")).toBeInTheDocument();
    expect(screen.queryByText("pdf")).not.toBeInTheDocument();
  });

  it("filters by category chip", () => {
    render(<InstalledSkillsView state={stubState({ skills: VIEW_SKILLS })} />);
    // Click the "Documents" category chip.
    fireEvent.click(screen.getByRole("button", { name: /Documents/ }));
    expect(screen.getByText("pdf")).toBeInTheDocument();
    expect(screen.queryByText("research")).not.toBeInTheDocument();
  });

  it("shows a no-matching-skills empty state when the filter excludes all", () => {
    render(<InstalledSkillsView state={stubState({ skills: VIEW_SKILLS })} />);
    const search = screen.getByRole("searchbox", {
      name: /filter installed skills/i,
    });
    fireEvent.change(search, { target: { value: "zzz-nothing" } });
    expect(screen.getByText("No matching skills")).toBeInTheDocument();
  });

  it("calls toggle with the new state when a switch is flipped", () => {
    const toggle = vi.fn();
    render(
      <InstalledSkillsView
        state={stubState({ skills: VIEW_SKILLS, toggle })}
      />,
    );
    const switches = screen.getAllByRole("switch");
    fireEvent.click(switches[1]); // research is disabled -> enable
    expect(toggle).toHaveBeenCalledWith("research", true);
  });

  it("disables the toggle and labels a read-only external skill", () => {
    render(<InstalledSkillsView state={stubState({ skills: VIEW_SKILLS })} />);
    const row = screen.getByText("company-style").closest("li");
    expect(row).not.toBeNull();
    const utils = within(row as HTMLElement);
    expect(utils.getByText("Read only")).toBeInTheDocument();
    expect(utils.getByRole("switch")).toBeDisabled();
  });

  it("renders the open-skill action only when a handler is provided", () => {
    const onOpenSkill = vi.fn();
    const { rerender } = render(
      <InstalledSkillsView state={stubState({ skills: VIEW_SKILLS })} />,
    );
    expect(
      screen.queryByRole("button", { name: /open pdf/i }),
    ).not.toBeInTheDocument();

    rerender(
      <InstalledSkillsView
        state={stubState({ skills: VIEW_SKILLS })}
        onOpenSkill={onOpenSkill}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /open pdf/i }));
    expect(onOpenSkill).toHaveBeenCalledWith("pdf");
  });

  it("shows the Hermes-not-running surface when unavailable", () => {
    render(
      <InstalledSkillsView state={stubState({ status: "unavailable" })} />,
    );
    expect(screen.getByText("Hermes is not running")).toBeInTheDocument();
    // The search box is disabled — there is nothing to filter.
    expect(
      screen.getByRole("searchbox", { name: /filter installed skills/i }),
    ).toBeDisabled();
  });

  it("shows the no-skills-installed empty state for an empty ready list", () => {
    render(<InstalledSkillsView state={stubState({ skills: [] })} />);
    expect(screen.getByText("No skills installed")).toBeInTheDocument();
  });

  it("shows an inline error with retry when the load failed", () => {
    const refresh = vi.fn();
    render(
      <InstalledSkillsView
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

  it("renders the lifecycle banner only when there is something to say", () => {
    const { rerender } = render(
      <InstalledSkillsView state={stubState({ skills: VIEW_SKILLS })} />,
    );
    // Clean: no banner.
    expect(screen.queryByText("Applies next session")).not.toBeInTheDocument();

    rerender(
      <InstalledSkillsView
        state={stubState({
          skills: VIEW_SKILLS,
          lifecycle: {
            state: "changes-apply-next-session",
            label: "Applies next session",
            detail:
              "Your changes take effect in new sessions. Current sessions are unaffected.",
            canRestart: false,
          },
        })}
      />,
    );
    expect(screen.getByText("Applies next session")).toBeInTheDocument();
  });

  it("renders dismissible durable notifications", () => {
    const dismissNotification = vi.fn();
    render(
      <InstalledSkillsView
        state={stubState({
          skills: VIEW_SKILLS,
          dismissNotification,
          notifications: [
            {
              id: "n1",
              message: "Skill updated. New sessions can use it.",
              timing: "next-session",
              mutation: "skill.toggle",
              at: Date.now(),
            },
          ],
        })}
      />,
    );
    expect(
      screen.getByText("Skill updated. New sessions can use it."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(dismissNotification).toHaveBeenCalledWith("n1");
  });

  it("renders an empty install scenario end to end through the controller hook", async () => {
    const harness = makeAdminHarness(emptyInstallScenario());
    function Mounted() {
      const state = useInstalledSkillsController(
        harness as InstalledSkillsEngine,
      );
      return <InstalledSkillsView state={state} />;
    }
    render(<Mounted />);
    await waitFor(() =>
      expect(screen.getByText("No skills installed")).toBeInTheDocument(),
    );
  });
});
