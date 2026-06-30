import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  SkillsHubController,
  filterHubResults,
  hubSearchHaystack,
  isDirectUrlInstall,
  parseHubSearch,
  parseHubSkillResult,
  sourceKindFor,
  sourceKindMeta,
  sourceKindsOf,
  trustMeta,
  type HermesHubSkillResult,
  type SkillsHubEngine,
  type SkillsHubState,
} from "../lib/hermes-admin";
import { SkillsHubView } from "../components/settings/SkillsHubSection";
import {
  makeAdminHarness,
  instantSleep,
} from "./fixtures/hermes-admin-harness";
import {
  hubBrowseScenario,
  skillSecurityWarningScenario,
} from "./fixtures/hermes-admin-scenarios";

/** Parses a wire-shaped object into a HermesHubSkillResult. */
function hubFromWire(raw: Record<string, unknown>): HermesHubSkillResult {
  const result = parseHubSkillResult(raw);
  if (!result) throw new Error("fixture did not parse");
  return result;
}

// ---------------------------------------------------------------------------
// Schema parsing: identifier, friendly + raw source, trust, tags, urls.
// ---------------------------------------------------------------------------

describe("skills hub — schema", () => {
  it("requires an identifier and falls back name -> identifier", () => {
    expect(parseHubSkillResult({})).toBeUndefined();
    expect(parseHubSkillResult({ name: "no id" })?.identifier).toBe("no id");
    const r = hubFromWire({ identifier: "skills.sh/x" });
    expect(r.name).toBe("skills.sh/x");
  });

  it("reads trust, tags, version, author, and url shapes defensively", () => {
    const r = hubFromWire({
      identifier: "github:acme/deploy",
      name: "Deploy",
      trust: "community",
      tags: ["ops", "ci"],
      version: "2.0.0",
      author: "acme",
      repo: "https://github.com/acme/deploy",
      installed: true,
      update_available: true,
    });
    expect(r.trust).toBe("community");
    expect(r.tags).toEqual(["ops", "ci"]);
    expect(r.version).toBe("2.0.0");
    expect(r.author).toBe("acme");
    expect(r.upstreamUrls).toEqual(["https://github.com/acme/deploy"]);
    expect(r.installed).toBe(true);
    expect(r.updateAvailable).toBe(true);
  });

  it("defaults trust to unknown and collapses url source to community", () => {
    expect(hubFromWire({ identifier: "x" }).trust).toBe("unknown");
    expect(hubFromWire({ identifier: "x", trust: "url" }).trust).toBe(
      "community",
    );
  });

  it("parses a hub search list from results/skills/items wrappers and bare array", () => {
    expect(parseHubSearch({ results: [{ identifier: "a" }] })).toHaveLength(1);
    expect(parseHubSearch([{ identifier: "b" }])).toHaveLength(1);
    expect(parseHubSearch({ junk: true })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pure view logic: source mapping, trust, direct-URL, filter, haystack.
// No render, no network.
// ---------------------------------------------------------------------------

describe("skills hub — view logic", () => {
  const results: HermesHubSkillResult[] = [
    hubFromWire({
      identifier: "official/pdf",
      name: "PDF",
      source: "official",
    }),
    hubFromWire({
      identifier: "skills.sh/data",
      name: "Data",
      source: "skills.sh",
      tags: ["python"],
    }),
    hubFromWire({
      identifier: "github:acme/deploy",
      name: "Deploy",
      source: "github",
    }),
    hubFromWire({
      identifier: "https://example.test/raw/SKILL.md",
      name: "URL skill",
      source: "url",
    }),
  ];

  it("maps explicit sources to friendly kinds + labels", () => {
    expect(sourceKindFor(results[0])).toBe("official");
    expect(sourceKindMeta(sourceKindFor(results[0])).label).toBe("Official");
    expect(sourceKindFor(results[1])).toBe("skills-sh");
    expect(sourceKindMeta(sourceKindFor(results[1])).label).toBe("skills.sh");
    expect(sourceKindFor(results[2])).toBe("github");
    expect(sourceKindFor(results[3])).toBe("url");
  });

  it("infers the source kind from the identifier when source is absent", () => {
    expect(sourceKindFor(hubFromWire({ identifier: "github:foo/bar" }))).toBe(
      "github",
    );
    expect(
      sourceKindFor(hubFromWire({ identifier: "https://x.test/SKILL.md" })),
    ).toBe("url");
    expect(sourceKindFor(hubFromWire({ identifier: "skills.sh/thing" }))).toBe(
      "skills-sh",
    );
  });

  it("flags direct-URL single-file installs", () => {
    expect(isDirectUrlInstall(results[3])).toBe(true);
    expect(isDirectUrlInstall(results[0])).toBe(false);
    expect(
      isDirectUrlInstall(hubFromWire({ identifier: "http://x.test/SKILL.md" })),
    ).toBe(true);
  });

  it("maps trust levels to a label, tone, and advisory", () => {
    expect(trustMeta("official").tone).toBe("trusted");
    expect(trustMeta("verified").tone).toBe("trusted");
    expect(trustMeta("community").tone).toBe("caution");
    expect(trustMeta("community").advisory).toContain("Review");
    expect(trustMeta("unknown").label).toBe("Unverified");
  });

  it("filters by source kind and free text against the haystack", () => {
    expect(filterHubResults(results, { sourceKind: "github" })).toHaveLength(1);
    expect(filterHubResults(results, { query: "python" })).toHaveLength(1);
    expect(filterHubResults(results, { query: "nomatch" })).toHaveLength(0);
    expect(hubSearchHaystack(results[1])).toContain("python");
    expect(hubSearchHaystack(results[1])).toContain("skills.sh");
  });

  it("lists present source kinds in a stable display order", () => {
    expect(sourceKindsOf(results)).toEqual([
      "official",
      "skills-sh",
      "github",
      "url",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Controller: search, install (sync + background), failure, confirm.
// Driven against the real client + fake server through the controller.
// ---------------------------------------------------------------------------

function controllerFor(scenario = hubBrowseScenario()) {
  const harness = makeAdminHarness(scenario);
  const controller = new SkillsHubController(harness as SkillsHubEngine, {
    sleep: instantSleep,
  });
  return { harness, controller };
}

describe("skills hub — search", () => {
  it("lists results and reports ready", async () => {
    const { controller } = controllerFor();
    // The hub is search-only (Hermes returns nothing for an empty query), so a
    // real term drives the results.
    await controller.search("data");
    const snapshot = controller.getSnapshot();
    expect(snapshot.status).toBe("ready");
    expect(
      snapshot.results.some((r) => r.identifier === "skills.sh/data-science"),
    ).toBe(true);
    controller.dispose();
  });

  it("passes the query through to the hub search endpoint", async () => {
    const { harness, controller } = controllerFor();
    await controller.search("data");
    const search = harness.server.requestLog.find((r) =>
      r.path.includes("/api/skills/hub/search"),
    );
    expect(search?.query.q).toBe("data");
    controller.dispose();
  });

  it("surfaces a retryable error on search failure", async () => {
    const { harness, controller } = controllerFor();
    vi.spyOn(harness.client.skills, "hubSearch").mockRejectedValueOnce(
      new Error("boom"),
    );
    await controller.search("");
    const snapshot = controller.getSnapshot();
    expect(snapshot.status).toBe("error");
    expect(snapshot.error).toBeTruthy();
    controller.dispose();
  });
});

describe("skills hub — install", () => {
  it("drives a background install to done, with progress, and invalidates skills", async () => {
    const { harness, controller } = controllerFor();
    await controller.search("pdf");
    const result = controller
      .getSnapshot()
      .results.find((r) => r.identifier === "official/pdf")!;

    const progresses: Array<number | undefined> = [];
    const unsub = controller.subscribe(() => {
      const state = controller.getSnapshot().installs.get("official/pdf");
      if (state?.phase === "installing") progresses.push(state.progress);
    });

    await controller.install(result);
    unsub();

    const state = controller.getSnapshot().installs.get("official/pdf");
    expect(state?.phase).toBe("done");
    // Saw at least one mid-flight progress value from the scripted action.
    expect(progresses.some((p) => p !== undefined)).toBe(true);
    // Installed inventory was invalidated so the Installed Skills page refreshes.
    expect(harness.cache.isStale("skills")).toBe(true);
    // A durable next-session notification was raised.
    const note = controller.getSnapshot().notifications.at(-1);
    expect(note?.timing).toBe("next-session");
    expect(note?.message).toContain("New sessions");
    // Lifecycle banner advanced to next-session, never "applied now".
    expect(controller.getSnapshot().lifecycle.state).toBe(
      "changes-apply-next-session",
    );
    // The card reflects installed locally without a re-search.
    expect(
      controller
        .getSnapshot()
        .results.find((r) => r.identifier === "official/pdf")?.installed,
    ).toBe(true);

    controller.dispose();
  });

  it("completes a synchronous install (no action handle) as done", async () => {
    // richInstall has no backgroundActions, so install completes synchronously.
    const { harness, controller } = controllerFor({
      token: "fake-sync",
      hubResults: [{ identifier: "skills.sh/sync", name: "Sync" }],
    });
    await controller.search("sync");
    const result = controller.getSnapshot().results[0];
    await controller.install(result);
    expect(controller.getSnapshot().installs.get("skills.sh/sync")?.phase).toBe(
      "done",
    );
    expect(harness.cache.isStale("skills")).toBe(true);
    controller.dispose();
  });

  it("surfaces a background install failure inline and raises an error note", async () => {
    const { controller } = controllerFor(skillSecurityWarningScenario());
    await controller.search("skill");
    const result = controller.getSnapshot().results[0];
    // Direct-URL result: confirm true so the install proceeds to the failure.
    await controller.install(result, { confirm: () => true });
    const state = controller.getSnapshot().installs.get(result.identifier);
    expect(state?.phase).toBe("failed");
    expect(state?.error).toContain("security review");
    expect(controller.getSnapshot().notifications.at(-1)?.isError).toBe(true);
    controller.dispose();
  });

  it("requires confirmation for a direct-URL install and is a no-op when declined", async () => {
    const { harness, controller } = controllerFor();
    await controller.search("example");
    const urlResult = controller
      .getSnapshot()
      .results.find((r) => isDirectUrlInstall(r))!;
    const confirm = vi.fn().mockResolvedValue(false);
    await controller.install(urlResult, { confirm });
    expect(confirm).toHaveBeenCalledOnce();
    expect(
      controller.getSnapshot().installs.get(urlResult.identifier)?.phase,
    ).toBe("idle");
    // No install request reached the server.
    expect(
      harness.server.requestLog.some((r) =>
        r.path.includes("/api/skills/hub/install"),
      ),
    ).toBe(false);
    controller.dispose();
  });

  it("clears a terminal install state", async () => {
    const { controller } = controllerFor();
    await controller.search("pdf");
    const result = controller.getSnapshot().results[0];
    await controller.install(result);
    expect(
      controller.getSnapshot().installs.get(result.identifier)?.phase,
    ).toBe("done");
    controller.clearInstall(result.identifier);
    expect(
      controller.getSnapshot().installs.get(result.identifier),
    ).toBeUndefined();
    controller.dispose();
  });

  it("fails an install that never finishes with an actionable timeout message", async () => {
    // A background action that stays "running" forever + a zero poll budget so
    // the first non-terminal poll trips the deadline, mimicking a stuck
    // (e.g. GitHub-rate-limited) install.
    const harness = makeAdminHarness({
      token: "fake-timeout",
      hubResults: [{ identifier: "skills.sh/slow", name: "Slow" }],
      backgroundActions: true,
      actionScripts: { install: { states: [{ state: "running" }] } },
    });
    const controller = new SkillsHubController(harness as SkillsHubEngine, {
      sleep: instantSleep,
      pollTimeoutMs: 0,
    });
    await controller.search("slow");
    const result = controller.getSnapshot().results[0];
    await controller.install(result);
    const state = controller.getSnapshot().installs.get(result.identifier);
    expect(state?.phase).toBe("failed");
    // Actionable: names the timeout AND the GitHub-auth fix, not the generic
    // "waiting for Hermes" copy.
    expect(state?.error).toMatch(/timed out/i);
    expect(state?.error).toMatch(/GITHUB_TOKEN/);
    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// View rendering: states + wiring with a stubbed state (no Tauri, no network).
// ---------------------------------------------------------------------------

function baseState(overrides: Partial<SkillsHubState> = {}): SkillsHubState {
  return {
    status: "ready",
    query: "",
    results: [
      hubFromWire({
        identifier: "official/pdf",
        name: "PDF",
        description: "Read and write PDFs",
        source: "official",
        trust: "official",
      }),
      hubFromWire({
        identifier: "https://example.test/raw/SKILL.md",
        name: "URL skill",
        source: "url",
        trust: "unknown",
      }),
    ],
    mode: "sandboxed",
    profile: "default",
    retryable: false,
    installs: new Map(),
    lifecycle: {
      state: "clean",
      label: "Up to date",
      detail: "No pending changes.",
      canRestart: false,
    },
    notifications: [],
    search: vi.fn(),
    refresh: vi.fn(),
    install: vi.fn(),
    clearInstall: vi.fn(),
    dismissNotification: vi.fn(),
    ...overrides,
  };
}

describe("skills hub — view", () => {
  it("renders result cards with name, source, and trust", () => {
    render(<SkillsHubView state={baseState()} />);
    expect(screen.getByRole("button", { name: "PDF" })).toBeInTheDocument();
    expect(screen.getAllByText("Official").length).toBeGreaterThan(0);
  });

  it("runs a search on submit", () => {
    const search = vi.fn();
    render(<SkillsHubView state={baseState({ search })} />);
    const input = screen.getByRole("searchbox", {
      name: /search the skills hub/i,
    });
    fireEvent.change(input, { target: { value: "pdf" } });
    fireEvent.submit(input);
    expect(search).toHaveBeenCalledWith("pdf");
  });

  it("installs a non-URL skill directly, no confirm", () => {
    const install = vi.fn();
    render(<SkillsHubView state={baseState({ install })} />);
    const pdfCard = screen
      .getByRole("button", { name: "PDF" })
      .closest("li") as HTMLElement;
    fireEvent.click(within(pdfCard).getByRole("button", { name: "Install" }));
    expect(install).toHaveBeenCalledTimes(1);
    expect(install.mock.calls[0][1]).toBeUndefined();
  });

  it("routes a non-trusted install through the security review", () => {
    const install = vi.fn();
    render(<SkillsHubView state={baseState({ install })} />);
    const urlCard = screen
      .getByRole("button", { name: "URL skill" })
      .closest("li") as HTMLElement;
    fireEvent.click(within(urlCard).getByRole("button", { name: "Install" }));
    // Install was invoked with a confirm hook (the security-review slot). The
    // hook opens the review dialog rather than a window.confirm.
    expect(install).toHaveBeenCalledTimes(1);
    expect(typeof install.mock.calls[0][1].confirm).toBe("function");
    // Exercising the hook (as the controller would) opens the native review
    // dialog, not a window.confirm.
    act(() => {
      void install.mock.calls[0][1].confirm({
        identifier: "https://example.test/raw/SKILL.md",
        name: "URL skill",
        trust: "unknown",
      });
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByText(/skills are instructions and helper files/i),
    ).toBeInTheDocument();
  });

  it("installs a trusted skill without opening the review", () => {
    const install = vi.fn();
    render(<SkillsHubView state={baseState({ install })} />);
    const pdfCard = screen
      .getByRole("button", { name: "PDF" })
      .closest("li") as HTMLElement;
    fireEvent.click(within(pdfCard).getByRole("button", { name: "Install" }));
    // Trusted (official) install: no confirm hook, no dialog.
    expect(install.mock.calls[0][1]).toBeUndefined();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens the inspect drawer with the install identifier in advanced", () => {
    render(<SkillsHubView state={baseState()} />);
    fireEvent.click(screen.getByRole("button", { name: "PDF" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Advanced")).toBeInTheDocument();
    expect(within(dialog).getByText("official/pdf")).toBeInTheDocument();
  });

  it("shows install progress while installing", () => {
    const state = baseState({
      installs: new Map([
        [
          "official/pdf",
          { identifier: "official/pdf", phase: "installing", progress: 60 },
        ],
      ]),
    });
    render(<SkillsHubView state={state} />);
    expect(screen.getByText(/installing 60%/i)).toBeInTheDocument();
  });

  it("shows an install failure with a retry", () => {
    const install = vi.fn();
    const state = baseState({
      install,
      installs: new Map([
        [
          "official/pdf",
          {
            identifier: "official/pdf",
            phase: "failed",
            error: "Install blocked.",
          },
        ],
      ]),
    });
    render(<SkillsHubView state={state} />);
    expect(screen.getByText("Install blocked.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(install).toHaveBeenCalled();
  });

  it("renders the unavailable empty state", () => {
    render(<SkillsHubView state={baseState({ status: "unavailable" })} />);
    expect(screen.getByText("Hermes is not running")).toBeInTheDocument();
  });

  it("renders a retryable error state", () => {
    const refresh = vi.fn();
    render(
      <SkillsHubView
        state={baseState({
          status: "error",
          error: "Network down.",
          retryable: true,
          refresh,
          results: [],
        })}
      />,
    );
    expect(screen.getByText("Network down.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refresh).toHaveBeenCalled();
  });
});
