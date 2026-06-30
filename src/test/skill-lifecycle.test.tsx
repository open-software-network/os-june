import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  SkillLifecycleController,
  availableActions,
  hubIdentifierOf,
  isLocallyModified,
  isSafeSkillName,
  parseSkill,
  skillLifecycleClass,
  skillLifecyclePolicy,
  type HermesSkillInfo,
  type SkillLifecycleAction,
  type SkillLifecycleEngine,
  type SkillLifecycleState,
} from "../lib/hermes-admin";
import { SkillLifecycleActions } from "../components/settings/SkillLifecycleActions";
import {
  makeAdminHarness,
  instantSleep,
} from "./fixtures/hermes-admin-harness";
import type { FakeHermesScenario } from "./fixtures/fake-hermes-server";

/** Parses a wire-shaped skill into a HermesSkillInfo, asserting it parsed. */
function skill(raw: Record<string, unknown>): HermesSkillInfo {
  const parsed = parseSkill(raw);
  if (!parsed) throw new Error("fixture did not parse");
  return parsed;
}

/** The set of action verbs a policy marks available. */
function availableVerbs(s: HermesSkillInfo): SkillLifecycleAction[] {
  return availableActions(skillLifecyclePolicy(s)).map((a) => a.action);
}

// ---------------------------------------------------------------------------
// Source-class classification + the action matrix (the spec's core requirement).
// ---------------------------------------------------------------------------

describe("skill lifecycle — source classification", () => {
  it("classifies a bundled built-in skill", () => {
    const s = skill({ name: "pdf", enabled: true, source: "bundled" });
    expect(skillLifecycleClass(s)).toBe("bundled");
  });

  it("classifies an official optional skill installed from the hub", () => {
    const s = skill({
      name: "deploy",
      enabled: true,
      source: "hub",
      provenance: "official",
      identifier: "official/deploy",
    });
    expect(skillLifecycleClass(s)).toBe("official-optional");
  });

  it("classifies a hub community skill", () => {
    const s = skill({
      name: "scrape",
      enabled: true,
      source: "hub",
      identifier: "github:acme/scrape",
    });
    expect(skillLifecycleClass(s)).toBe("community");
  });

  it("classifies a local custom skill", () => {
    const s = skill({ name: "mine", enabled: true, custom: true });
    expect(skillLifecycleClass(s)).toBe("local");
  });

  it("classifies an external directory skill as read-only", () => {
    const s = skill({ name: "shared", enabled: true, source: "external" });
    expect(skillLifecycleClass(s)).toBe("external");
  });
});

describe("skill lifecycle — action matrix", () => {
  it("bundled: reset and restore only, never uninstall", () => {
    const s = skill({ name: "pdf", enabled: true, source: "bundled" });
    const verbs = availableVerbs(s);
    expect(verbs).toContain("reset");
    expect(verbs).toContain("restore");
    expect(verbs).not.toContain("uninstall");
    expect(verbs).not.toContain("update");
    // The disabled uninstall explains itself.
    const policy = skillLifecyclePolicy(s);
    expect(policy.actions.uninstall.available).toBe(false);
    expect(policy.actions.uninstall.reason).toMatch(/ships with Hermes/i);
  });

  it("hub community: update, audit, uninstall, check", () => {
    const s = skill({
      name: "scrape",
      enabled: true,
      source: "hub",
      identifier: "github:acme/scrape",
    });
    const verbs = availableVerbs(s);
    expect(verbs).toEqual(
      expect.arrayContaining(["check", "update", "audit", "uninstall"]),
    );
    expect(verbs).not.toContain("reset");
    expect(verbs).not.toContain("delete");
  });

  it("official optional: behaves like a hub skill (update / audit / uninstall)", () => {
    const s = skill({
      name: "deploy",
      enabled: true,
      source: "hub",
      provenance: "official",
      identifier: "official/deploy",
    });
    expect(availableVerbs(s)).toEqual(
      expect.arrayContaining(["update", "audit", "uninstall"]),
    );
  });

  it("local custom: delete only, with a strong-confirmation flag", () => {
    const s = skill({ name: "mine", enabled: true, custom: true });
    const policy = skillLifecyclePolicy(s);
    expect(policy.actions.delete.available).toBe(true);
    expect(policy.actions.delete.destructive).toBe(true);
    expect(policy.actions.uninstall.available).toBe(false);
    expect(availableVerbs(s)).not.toContain("update");
  });

  it("external directory: read-only, delete disabled with a reason", () => {
    const s = skill({ name: "shared", enabled: true, source: "external" });
    const policy = skillLifecyclePolicy(s);
    expect(availableActions(policy)).toHaveLength(0);
    expect(policy.actions.delete.available).toBe(false);
    expect(policy.actions.delete.reason).toMatch(/external directory/i);
    expect(policy.actions.update.reason).toMatch(/read-only/i);
  });

  it("flags an update that would overwrite local edits with a divergence warning", () => {
    const s = skill({
      name: "scrape",
      enabled: true,
      source: "hub",
      identifier: "github:acme/scrape",
      locally_modified: true,
    });
    const policy = skillLifecyclePolicy(s);
    expect(isLocallyModified(s)).toBe(true);
    expect(policy.locallyModified).toBe(true);
    expect(policy.actions.update.divergenceWarning).toMatch(/local edits/i);
  });

  it("reads the hub identifier off the raw payload", () => {
    expect(
      hubIdentifierOf(
        skill({ name: "x", enabled: true, source: "hub", identifier: "a/b" }),
      ),
    ).toBe("a/b");
  });
});

// ---------------------------------------------------------------------------
// Safe-name validation for the reset CLI fallback.
// ---------------------------------------------------------------------------

describe("skill lifecycle — safe skill name", () => {
  it("accepts slug-shaped names", () => {
    expect(isSafeSkillName("pdf")).toBe(true);
    expect(isSafeSkillName("my-skill_1.2")).toBe(true);
  });

  it("rejects unsafe identifiers that could escape into a flag or traversal", () => {
    expect(isSafeSkillName("")).toBe(false);
    expect(isSafeSkillName("--force")).toBe(false);
    expect(isSafeSkillName("a b")).toBe(false);
    expect(isSafeSkillName("../etc/passwd")).toBe(false);
    expect(isSafeSkillName("rm -rf / ; curl evil")).toBe(false);
    expect(isSafeSkillName("name;other")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Controller: background update / uninstall, audit, reset, divergence guard.
// ---------------------------------------------------------------------------

const COMMUNITY = {
  name: "scrape",
  enabled: true,
  source: "hub" as const,
  identifier: "github:acme/scrape",
};

function controllerFor(
  scenario: FakeHermesScenario = { backgroundActions: true },
  options: Partial<
    ConstructorParameters<typeof SkillLifecycleController>[1]
  > = {},
) {
  const harness = makeAdminHarness(scenario);
  const controller = new SkillLifecycleController(
    harness as unknown as SkillLifecycleEngine,
    { sleep: instantSleep, ...options },
  );
  return { harness, controller };
}

describe("skill lifecycle — controller actions", () => {
  it("drives a background update to done, with progress, and invalidates skills", async () => {
    const onMutated = vi.fn();
    const { harness, controller } = controllerFor(
      { backgroundActions: true },
      { onMutated },
    );
    const s = skill(COMMUNITY);

    const progresses: Array<number | undefined> = [];
    const unsub = controller.subscribe(() => {
      const st = controller.getSnapshot().actions.get("scrape::update");
      if (st?.phase === "running") progresses.push(st.progress);
    });

    await controller.run(s, "update");
    unsub();

    const st = controller.getSnapshot().actions.get("scrape::update");
    expect(st?.phase).toBe("done");
    expect(progresses.some((p) => p !== undefined)).toBe(true);
    expect(harness.cache.isStale("skills")).toBe(true);
    expect(onMutated).toHaveBeenCalled();
    // The update request reached the hub update endpoint.
    expect(
      harness.server.requestLog.some((r) =>
        r.path.includes("/api/skills/hub/update"),
      ),
    ).toBe(true);
    controller.dispose();
  });

  it("checkForUpdates asks the host to refresh the inventory", async () => {
    // The lifecycle controller's AdminStateCache is a separate instance from the
    // installed-skills controller's, so invalidating it never reaches the
    // inventory subscriber. A check must call onMutated (the host's inventory
    // refresh) to actually re-read GET /api/skills (Codex P2).
    const onMutated = vi.fn();
    const { controller } = controllerFor({}, { onMutated });
    await controller.checkForUpdates();
    expect(onMutated).toHaveBeenCalled();
    controller.dispose();
  });

  it("uninstalls a hub skill by its identifier", async () => {
    const { harness, controller } = controllerFor();
    const s = skill(COMMUNITY);
    await controller.run(s, "uninstall");
    expect(
      controller.getSnapshot().actions.get("scrape::uninstall")?.phase,
    ).toBe("done");
    const req = harness.server.requestLog.find((r) =>
      r.path.includes("/api/skills/hub/uninstall"),
    );
    expect((req?.body as { name?: string })?.name).toBe("github:acme/scrape");
    controller.dispose();
  });

  it("audits a skill through the read-only scan endpoint", async () => {
    const { harness, controller } = controllerFor({
      backgroundActions: false,
      hubScans: {
        "github:acme/scrape": {
          verdict: "caution",
          summary: "Ships a helper script.",
        },
      },
    });
    const s = skill(COMMUNITY);
    await controller.run(s, "audit");
    const st = controller.getSnapshot().actions.get("scrape::audit");
    expect(st?.phase).toBe("done");
    expect(st?.scan?.verdict).toBe("caution");
    expect(st?.message).toBe("Ships a helper script.");
    const scan = harness.server.requestLog.find((r) =>
      r.path.includes("/api/skills/hub/scan"),
    );
    expect(scan?.query.identifier).toBe("github:acme/scrape");
    controller.dispose();
  });

  it("refuses an update that diverges until the divergence is accepted", async () => {
    const { harness, controller } = controllerFor();
    const s = skill({ ...COMMUNITY, locally_modified: true });

    // First attempt without accepting: refused, no request sent.
    await controller.run(s, "update");
    expect(controller.getSnapshot().actions.get("scrape::update")?.phase).toBe(
      "failed",
    );
    expect(
      harness.server.requestLog.some((r) =>
        r.path.includes("/api/skills/hub/update"),
      ),
    ).toBe(false);

    // Second attempt accepting the divergence: proceeds.
    controller.clearAction("scrape", "update");
    await controller.run(s, "update", { acceptDivergence: true });
    expect(controller.getSnapshot().actions.get("scrape::update")?.phase).toBe(
      "done",
    );
    controller.dispose();
  });

  it("does not run an action that is invalid for the skill's source", async () => {
    const { harness, controller } = controllerFor();
    const bundled = skill({ name: "pdf", enabled: true, source: "bundled" });
    // Bundled cannot be uninstalled: the controller is a no-op, no request.
    await controller.run(bundled, "uninstall");
    expect(
      controller.getSnapshot().actions.get("pdf::uninstall"),
    ).toBeUndefined();
    expect(
      harness.server.requestLog.some((r) => r.path.includes("/uninstall")),
    ).toBe(false);
    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// Reset CLI fallback: invoked for bundled skills, rejects unsafe names.
// ---------------------------------------------------------------------------

describe("skill lifecycle — reset CLI fallback", () => {
  it("resets a bundled skill through the injected CLI bridge and refreshes", async () => {
    const resetBundled = vi.fn().mockResolvedValue({
      ok: true,
      message: "Reset pdf.",
      timedOut: false,
    });
    const onMutated = vi.fn();
    const { harness, controller } = controllerFor(
      { backgroundActions: false },
      { resetBundled, onMutated },
    );
    const bundled = skill({ name: "pdf", enabled: true, source: "bundled" });

    await controller.run(bundled, "reset");

    expect(resetBundled).toHaveBeenCalledWith({
      mode: "sandboxed",
      name: "pdf",
      profile: "default",
      restore: false,
    });
    expect(controller.getSnapshot().actions.get("pdf::reset")?.phase).toBe(
      "done",
    );
    expect(harness.cache.isStale("skills")).toBe(true);
    expect(onMutated).toHaveBeenCalled();
    controller.dispose();
  });

  it("passes restore: true for a restore-from-upstream", async () => {
    const resetBundled = vi
      .fn()
      .mockResolvedValue({ ok: true, message: null, timedOut: false });
    const { controller } = controllerFor(
      { backgroundActions: false },
      { resetBundled },
    );
    const bundled = skill({ name: "pdf", enabled: true, source: "bundled" });
    await controller.run(bundled, "restore");
    expect(resetBundled.mock.calls[0][0].restore).toBe(true);
    controller.dispose();
  });

  it("never invokes the CLI for an unsafe skill name", async () => {
    const resetBundled = vi.fn();
    const { controller } = controllerFor(
      { backgroundActions: false },
      { resetBundled },
    );
    // A bundled skill whose name is not slug-safe: reset is refused before the
    // bridge call so the unsafe name never reaches the CLI.
    const bundled = skill({
      name: "../evil",
      enabled: true,
      source: "bundled",
    });
    await controller.run(bundled, "reset");
    expect(resetBundled).not.toHaveBeenCalled();
    expect(controller.getSnapshot().actions.get("../evil::reset")?.phase).toBe(
      "failed",
    );
    controller.dispose();
  });

  it("surfaces a CLI failure inline without refreshing", async () => {
    const resetBundled = vi.fn().mockResolvedValue({
      ok: false,
      message: "hermes skills reset failed.",
      timedOut: false,
    });
    const onMutated = vi.fn();
    const { controller } = controllerFor(
      { backgroundActions: false },
      { resetBundled, onMutated },
    );
    const bundled = skill({ name: "pdf", enabled: true, source: "bundled" });
    await controller.run(bundled, "reset");
    const st = controller.getSnapshot().actions.get("pdf::reset");
    expect(st?.phase).toBe("failed");
    expect(st?.error).toBe("hermes skills reset failed.");
    expect(onMutated).not.toHaveBeenCalled();
    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// View: only valid actions render; disabled actions explain themselves.
// ---------------------------------------------------------------------------

function lifecycleState(
  overrides: Partial<SkillLifecycleState> = {},
): SkillLifecycleState {
  return {
    mode: "sandboxed",
    profile: "default",
    actions: new Map(),
    sweeping: false,
    policyFor: (s) => skillLifecyclePolicy(s),
    run: vi.fn(),
    checkForUpdates: vi.fn(),
    updateAll: vi.fn(),
    clearAction: vi.fn(),
    ...overrides,
  };
}

describe("skill lifecycle — view", () => {
  it("renders only the valid actions for a hub skill", () => {
    const s = skill(COMMUNITY);
    render(
      <SkillLifecycleActions
        skill={s}
        policy={skillLifecyclePolicy(s)}
        state={lifecycleState()}
        variant="row"
      />,
    );
    expect(screen.getByRole("button", { name: "Update" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Audit" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Uninstall" }),
    ).toBeInTheDocument();
    // No reset for a hub skill.
    expect(
      screen.queryByRole("button", { name: /reset/i }),
    ).not.toBeInTheDocument();
  });

  it("offers reset/restore for a bundled skill, never uninstall", () => {
    const s = skill({ name: "pdf", enabled: true, source: "bundled" });
    render(
      <SkillLifecycleActions
        skill={s}
        policy={skillLifecyclePolicy(s)}
        state={lifecycleState()}
        variant="detail"
      />,
    );
    expect(
      screen.getByRole("button", { name: /reset to shipped version/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Uninstall" }),
    ).not.toBeInTheDocument();
    // The detail variant explains why uninstall is unavailable.
    expect(screen.getByText(/ships with Hermes/i)).toBeInTheDocument();
  });

  it("requires confirmation before an uninstall and runs on confirm", () => {
    const run = vi.fn();
    const s = skill(COMMUNITY);
    render(
      <SkillLifecycleActions
        skill={s}
        policy={skillLifecyclePolicy(s)}
        state={lifecycleState({ run })}
        variant="row"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));
    // A confirm dialog appears; the action has not run yet.
    expect(run).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    // Confirm inside the dialog.
    fireEvent.click(within(dialog).getByRole("button", { name: "Uninstall" }));
    expect(run).toHaveBeenCalled();
  });

  it("runs an audit immediately (no confirmation)", () => {
    const run = vi.fn();
    const s = skill(COMMUNITY);
    render(
      <SkillLifecycleActions
        skill={s}
        policy={skillLifecyclePolicy(s)}
        state={lifecycleState({ run })}
        variant="row"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Audit" }));
    expect(run).toHaveBeenCalledWith(s, "audit", { acceptDivergence: false });
  });
});
