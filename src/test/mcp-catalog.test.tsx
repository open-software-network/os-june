import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  McpCatalogController,
  catalogAuthMeta,
  catalogStatusOf,
  catalogTransportMeta,
  emptyInstallDraft,
  envRequirementsFor,
  filterCatalog,
  isLocalSubprocessEntry,
  needsAuthHandoff,
  needsCredentials,
  parseMcpCatalog,
  parseMcpCatalogEntry,
  validateInstallDraft,
  type HermesMcpCatalogEntry,
  type McpCatalogEngine,
  type McpCatalogState,
} from "../lib/hermes-admin";
import { McpCatalogView } from "../components/settings/McpCatalogSection";
import {
  makeAdminHarness,
  instantSleep,
} from "./fixtures/hermes-admin-harness";
import { mcpCatalogBrowseScenario } from "./fixtures/hermes-admin-scenarios";

/** Parses a wire-shaped object into a HermesMcpCatalogEntry. */
function entryFromWire(raw: Record<string, unknown>): HermesMcpCatalogEntry {
  const entry = parseMcpCatalogEntry(raw);
  if (!entry) throw new Error("fixture did not parse");
  return entry;
}

// ---------------------------------------------------------------------------
// Schema parsing: install name, auth classification, required env, status.
// ---------------------------------------------------------------------------

describe("mcp catalog — schema", () => {
  it("requires an install name and falls back name -> id -> name", () => {
    expect(parseMcpCatalogEntry({})).toBeUndefined();
    const e = entryFromWire({ name: "github" });
    expect(e.installName).toBe("github");
    expect(e.name).toBe("github");
  });

  it("prefers a title for the display name but keeps install name", () => {
    const e = entryFromWire({ name: "gh", title: "GitHub" });
    expect(e.installName).toBe("gh");
    expect(e.name).toBe("GitHub");
  });

  it("classifies auth: explicit api-key/oauth/third-party/none", () => {
    expect(entryFromWire({ name: "a", auth: "api-key" }).auth).toBe("api-key");
    expect(entryFromWire({ name: "b", auth: "oauth" }).auth).toBe("oauth");
    expect(entryFromWire({ name: "c", auth: "third-party" }).auth).toBe(
      "third-party",
    );
    expect(entryFromWire({ name: "d", auth: "none" }).auth).toBe("none");
  });

  it("infers oauth from transport/flag and api-key from required env", () => {
    expect(entryFromWire({ name: "e", transport: "http-oauth" }).auth).toBe(
      "oauth",
    );
    expect(entryFromWire({ name: "f", requires_oauth: true }).auth).toBe(
      "oauth",
    );
    expect(
      entryFromWire({ name: "g", required_env: [{ key: "TOKEN" }] }).auth,
    ).toBe("api-key");
    expect(entryFromWire({ name: "h" }).auth).toBe("unknown");
  });

  it("reads required env from an array and a map, keys only", () => {
    const fromArray = entryFromWire({
      name: "x",
      required_env: [{ key: "GITHUB_TOKEN", label: "Token", required: true }],
    });
    expect(fromArray.requiredEnv).toEqual([
      {
        key: "GITHUB_TOKEN",
        label: "Token",
        required: true,
        secret: undefined,
      },
    ]);
    const fromMap = entryFromWire({
      name: "y",
      required_env: { API_KEY: { label: "Key" } },
    });
    expect(fromMap.requiredEnv?.[0].key).toBe("API_KEY");
  });

  it("reads installed/enabled and default tools", () => {
    const e = entryFromWire({
      name: "z",
      installed: true,
      enabled: false,
      default_tools: ["one", "two"],
    });
    expect(e.installed).toBe(true);
    expect(e.enabled).toBe(false);
    expect(e.defaultTools).toEqual(["one", "two"]);
  });

  it("parses a catalog list from catalog/entries wrappers and a bare array", () => {
    expect(parseMcpCatalog({ catalog: [{ name: "a" }] })).toHaveLength(1);
    expect(parseMcpCatalog([{ name: "b" }])).toHaveLength(1);
    expect(parseMcpCatalog({ junk: true })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pure view logic: transport/risk, auth meta, status, requirements, filter.
// ---------------------------------------------------------------------------

describe("mcp catalog — view logic", () => {
  const fetchEntry = entryFromWire({
    name: "fetch",
    transport: "stdio",
    auth: "none",
  });
  const githubEntry = entryFromWire({
    name: "github",
    title: "GitHub",
    transport: "http",
    auth: "api-key",
    required_env: [{ key: "GITHUB_TOKEN" }],
  });
  const linearEntry = entryFromWire({
    name: "linear",
    transport: "http-oauth",
    auth: "oauth",
  });
  const installedEntry = entryFromWire({
    name: "filesystem",
    transport: "stdio",
    installed: true,
    enabled: false,
  });

  it("labels transport risk: local subprocess vs remote http", () => {
    expect(catalogTransportMeta(fetchEntry).risk).toBe("local-subprocess");
    expect(isLocalSubprocessEntry(fetchEntry)).toBe(true);
    expect(catalogTransportMeta(githubEntry).risk).toBe("remote-http");
    expect(isLocalSubprocessEntry(githubEntry)).toBe(false);
  });

  it("labels each auth kind with copy and tone", () => {
    expect(catalogAuthMeta("api-key").label).toBe("API key");
    expect(catalogAuthMeta("api-key").tone).toBe("attention");
    expect(catalogAuthMeta("oauth").label).toBe("OAuth");
    expect(catalogAuthMeta("none").tone).toBe("neutral");
  });

  it("derives the catalog status: available / installed-disabled / enabled", () => {
    expect(catalogStatusOf(fetchEntry)).toBe("available");
    expect(catalogStatusOf(installedEntry)).toBe("installed-disabled");
    expect(
      catalogStatusOf(
        entryFromWire({ name: "on", installed: true, enabled: true }),
      ),
    ).toBe("enabled");
  });

  it("collects env requirements only for api-key entries (not oauth)", () => {
    expect(envRequirementsFor(githubEntry).map((r) => r.key)).toEqual([
      "GITHUB_TOKEN",
    ]);
    expect(envRequirementsFor(linearEntry)).toEqual([]);
    expect(needsCredentials(githubEntry)).toBe(true);
    expect(needsCredentials(fetchEntry)).toBe(false);
  });

  it("flags oauth/third-party as needing an auth handoff", () => {
    expect(needsAuthHandoff(linearEntry)).toBe(true);
    expect(
      needsAuthHandoff(entryFromWire({ name: "stripe", auth: "third-party" })),
    ).toBe(true);
    expect(needsAuthHandoff(fetchEntry)).toBe(false);
  });

  it("validates an install draft: required env must be present", () => {
    const blank = validateInstallDraft(
      githubEntry,
      emptyInstallDraft(githubEntry),
    );
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.errors.GITHUB_TOKEN).toBeTruthy();

    const filled = validateInstallDraft(githubEntry, {
      enable: true,
      env: { GITHUB_TOKEN: "ghp_FAKE" },
    });
    expect(filled.ok).toBe(true);
    if (filled.ok) {
      expect(filled.payload.name).toBe("github");
      expect(filled.payload.env).toEqual({ GITHUB_TOKEN: "ghp_FAKE" });
      // enable defaults on, so it is omitted from the body.
      expect(filled.payload.enable).toBeUndefined();
    }
  });

  it("sends enable:false only when the user opts out", () => {
    const result = validateInstallDraft(fetchEntry, { enable: false, env: {} });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.enable).toBe(false);
  });

  it("filters by name, transport label, auth label, and tools", () => {
    const entries = [fetchEntry, githubEntry, linearEntry];
    expect(filterCatalog(entries, "github")).toHaveLength(1);
    expect(filterCatalog(entries, "api key")).toHaveLength(1);
    expect(filterCatalog(entries, "local")).toHaveLength(1); // transport label
    expect(filterCatalog(entries, "nomatch")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Controller: browse, install (background + redaction), failure, handoff.
// ---------------------------------------------------------------------------

function controllerFor(scenario = mcpCatalogBrowseScenario()) {
  const harness = makeAdminHarness(scenario);
  const controller = new McpCatalogController(harness as McpCatalogEngine, {
    sleep: instantSleep,
  });
  return { harness, controller };
}

describe("mcp catalog — controller", () => {
  it("loads the catalog and reports ready", async () => {
    const { controller } = controllerFor();
    await controller.load();
    const snapshot = controller.getSnapshot();
    expect(snapshot.status).toBe("ready");
    expect(snapshot.entries.length).toBe(5);
    controller.dispose();
  });

  it("surfaces a retryable error on load failure", async () => {
    const { harness, controller } = controllerFor();
    vi.spyOn(harness.client.mcp, "catalog").mockRejectedValueOnce(
      new Error("boom"),
    );
    await controller.load();
    expect(controller.getSnapshot().status).toBe("error");
    expect(controller.getSnapshot().retryable).toBe(true);
    controller.dispose();
  });

  it("installs a no-auth entry (background), invalidates mcpServers, restart-required", async () => {
    const { harness, controller } = controllerFor();
    await controller.load();
    const fetchEntry = controller
      .getSnapshot()
      .entries.find((e) => e.installName === "fetch")!;
    const payload = { name: "fetch" };

    const progresses: Array<number | undefined> = [];
    const unsub = controller.subscribe(() => {
      const s = controller.getSnapshot().installs.get("fetch");
      if (s?.phase === "installing") progresses.push(s.progress);
    });

    await controller.install(fetchEntry, payload);
    unsub();

    const state = controller.getSnapshot().installs.get("fetch");
    expect(state?.phase).toBe("done");
    expect(progresses.some((p) => p !== undefined)).toBe(true);
    // The MCP servers inventory + catalog were invalidated so both refresh.
    expect(harness.cache.isStale("mcpServers")).toBe(true);
    expect(harness.cache.isStale("mcpCatalog")).toBe(true);
    // A durable restart-required notification was raised.
    const note = controller.getSnapshot().notifications.at(-1);
    expect(note?.timing).toBe("gateway-restart");
    expect(note?.message).toContain("Restart Hermes gateway");
    expect(controller.getSnapshot().lifecycle.state).toBe(
      "gateway-restart-required",
    );
    // The entry reflects installed locally without a reload.
    expect(
      controller.getSnapshot().entries.find((e) => e.installName === "fetch")
        ?.installed,
    ).toBe(true);
    controller.dispose();
  });

  it("installed entries appear in the MCP servers list", async () => {
    const { harness, controller } = controllerFor();
    await controller.load();
    const fetchEntry = controller
      .getSnapshot()
      .entries.find((e) => e.installName === "fetch")!;
    await controller.install(fetchEntry, { name: "fetch" });
    const servers = await harness.client.mcp.listServers();
    expect(servers.some((s) => s.name === "fetch")).toBe(true);
    controller.dispose();
  });

  it("sends required env in the install body and never logs the secret", async () => {
    const { harness, controller } = controllerFor();
    await controller.load();
    const githubEntry = controller
      .getSnapshot()
      .entries.find((e) => e.installName === "github")!;
    const secret = "ghp_FAKE_secret_value_123";
    await controller.install(githubEntry, {
      name: "github",
      env: { GITHUB_TOKEN: secret },
    });
    expect(controller.getSnapshot().installs.get("github")?.phase).toBe("done");
    // The secret reached the install endpoint body...
    const installReq = harness.server.requestLog.find(
      (r) => r.path === "/api/mcp/catalog/install",
    );
    expect((installReq?.body as { env?: Record<string, string> })?.env).toEqual(
      { GITHUB_TOKEN: secret },
    );
    // ...but was never written to the transport log.
    expect(JSON.stringify(harness.logs)).not.toContain(secret);
    controller.dispose();
  });

  it("marks an oauth install as needing an auth handoff", async () => {
    const { controller } = controllerFor();
    await controller.load();
    const linearEntry = controller
      .getSnapshot()
      .entries.find((e) => e.installName === "linear")!;
    await controller.install(linearEntry, { name: "linear" });
    const state = controller.getSnapshot().installs.get("linear");
    expect(state?.phase).toBe("done");
    expect(state?.needsAuthHandoff).toBe(true);
    controller.dispose();
  });

  it("surfaces an install failure inline and raises an error note", async () => {
    const scenario = mcpCatalogBrowseScenario();
    scenario.actionScripts = {
      "catalog-install": {
        states: [
          { state: "running", progress: 30 },
          { state: "failed", error: "Install rejected by Hermes." },
        ],
      },
    };
    const { controller } = controllerFor(scenario);
    await controller.load();
    const fetchEntry = controller
      .getSnapshot()
      .entries.find((e) => e.installName === "fetch")!;
    await controller.install(fetchEntry, { name: "fetch" });
    const state = controller.getSnapshot().installs.get("fetch");
    expect(state?.phase).toBe("failed");
    expect(state?.error).toContain("rejected");
    expect(controller.getSnapshot().notifications.at(-1)?.isError).toBe(true);
    controller.dispose();
  });

  it("clears a terminal install state", async () => {
    const { controller } = controllerFor();
    await controller.load();
    const fetchEntry = controller
      .getSnapshot()
      .entries.find((e) => e.installName === "fetch")!;
    await controller.install(fetchEntry, { name: "fetch" });
    expect(controller.getSnapshot().installs.get("fetch")?.phase).toBe("done");
    controller.clearInstall("fetch");
    expect(controller.getSnapshot().installs.get("fetch")).toBeUndefined();
    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// View rendering: states + wiring with a stubbed state (no Tauri, no network).
// ---------------------------------------------------------------------------

function baseState(overrides: Partial<McpCatalogState> = {}): McpCatalogState {
  return {
    status: "ready",
    entries: [
      entryFromWire({
        name: "fetch",
        title: "Fetch",
        description: "Fetch web pages",
        transport: "stdio",
        auth: "none",
      }),
      entryFromWire({
        name: "github",
        title: "GitHub",
        description: "GitHub tools",
        transport: "http",
        auth: "api-key",
        required_env: [{ key: "GITHUB_TOKEN", label: "Token" }],
      }),
      entryFromWire({
        name: "linear",
        title: "Linear",
        transport: "http-oauth",
        auth: "oauth",
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
    refresh: vi.fn(),
    install: vi.fn(),
    clearInstall: vi.fn(),
    dismissNotification: vi.fn(),
    ...overrides,
  };
}

describe("mcp catalog — view", () => {
  it("renders entry rows with name, transport, risk, and auth", () => {
    render(<McpCatalogView state={baseState()} />);
    expect(screen.getByRole("button", { name: "Fetch" })).toBeInTheDocument();
    expect(screen.getAllByText("Local (stdio)").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Local subprocess").length).toBeGreaterThan(0);
    expect(screen.getByText("API key")).toBeInTheDocument();
  });

  it("installs a no-auth entry directly, with no env payload", () => {
    const install = vi.fn();
    render(<McpCatalogView state={baseState({ install })} />);
    const fetchCard = screen
      .getByRole("button", { name: "Fetch" })
      .closest("li") as HTMLElement;
    fireEvent.click(within(fetchCard).getByRole("button", { name: "Install" }));
    expect(install).toHaveBeenCalledTimes(1);
    expect(install.mock.calls[0][1]).toMatchObject({ name: "fetch" });
    expect(install.mock.calls[0][1].env).toBeUndefined();
  });

  it("opens the install dialog for an entry that needs credentials", () => {
    render(<McpCatalogView state={baseState()} />);
    const githubCard = screen
      .getByRole("button", { name: "GitHub" })
      .closest("li") as HTMLElement;
    fireEvent.click(
      within(githubCard).getByRole("button", { name: "Install" }),
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Install GitHub/)).toBeInTheDocument();
    // A masked input for the required env value is shown.
    const input = within(dialog).getByLabelText("Token") as HTMLInputElement;
    expect(input.type).toBe("password");
  });

  it("requires the credential and then sends it in the install payload", () => {
    const install = vi.fn();
    render(<McpCatalogView state={baseState({ install })} />);
    const githubCard = screen
      .getByRole("button", { name: "GitHub" })
      .closest("li") as HTMLElement;
    fireEvent.click(
      within(githubCard).getByRole("button", { name: "Install" }),
    );
    const dialog = screen.getByRole("dialog");
    // Submitting blank surfaces a validation error, no install.
    fireEvent.click(within(dialog).getByRole("button", { name: "Install" }));
    expect(install).not.toHaveBeenCalled();
    // Fill the secret and install.
    fireEvent.change(within(dialog).getByLabelText("Token"), {
      target: { value: "ghp_FAKE" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Install" }));
    expect(install).toHaveBeenCalledTimes(1);
    expect(install.mock.calls[0][1].env).toEqual({ GITHUB_TOKEN: "ghp_FAKE" });
  });

  it("inspects an entry and shows the auth handoff note for oauth", () => {
    render(<McpCatalogView state={baseState()} />);
    fireEvent.click(screen.getByRole("button", { name: "Linear" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/sign in to finish/i)).toBeInTheDocument();
    expect(within(dialog).getByText("linear")).toBeInTheDocument();
  });

  it("shows the installed-disabled status and a reinstall action", () => {
    const state = baseState({
      entries: [
        entryFromWire({
          name: "filesystem",
          title: "Filesystem",
          transport: "stdio",
          installed: true,
          enabled: false,
        }),
      ],
    });
    render(<McpCatalogView state={state} />);
    expect(screen.getByText("Installed, disabled")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reinstall" }),
    ).toBeInTheDocument();
  });

  it("shows install progress and a restart-to-apply done state", () => {
    const progressing = baseState({
      installs: new Map([
        ["fetch", { installName: "fetch", phase: "installing", progress: 50 }],
      ]),
    });
    const { rerender } = render(<McpCatalogView state={progressing} />);
    expect(screen.getByText(/installing 50%/i)).toBeInTheDocument();

    const done = baseState({
      installs: new Map([
        ["fetch", { installName: "fetch", phase: "done", progress: 100 }],
      ]),
    });
    rerender(<McpCatalogView state={done} />);
    expect(screen.getByText("Restart to apply")).toBeInTheDocument();
  });

  it("shows a done state that points to the sign-in handoff", () => {
    const state = baseState({
      installs: new Map([
        [
          "linear",
          { installName: "linear", phase: "done", needsAuthHandoff: true },
        ],
      ]),
    });
    render(<McpCatalogView state={state} />);
    expect(screen.getByText(/sign in to finish/i)).toBeInTheDocument();
  });

  it("shows an install failure with a retry", () => {
    const install = vi.fn();
    const state = baseState({
      install,
      installs: new Map([
        [
          "fetch",
          { installName: "fetch", phase: "failed", error: "Install blocked." },
        ],
      ]),
    });
    render(<McpCatalogView state={state} />);
    expect(screen.getByText("Install blocked.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(install).toHaveBeenCalled();
  });

  it("renders the unavailable empty state", () => {
    render(<McpCatalogView state={baseState({ status: "unavailable" })} />);
    expect(screen.getByText("Hermes is not running")).toBeInTheDocument();
  });

  it("renders a retryable error state", () => {
    const refresh = vi.fn();
    render(
      <McpCatalogView
        state={baseState({
          status: "error",
          error: "Network down.",
          retryable: true,
          refresh,
          entries: [],
        })}
      />,
    );
    expect(screen.getByText("Network down.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refresh).toHaveBeenCalled();
  });

  it("filters entries by the search box", () => {
    render(<McpCatalogView state={baseState()} />);
    const input = screen.getByRole("searchbox", {
      name: /filter mcp catalog/i,
    });
    fireEvent.change(input, { target: { value: "github" } });
    expect(screen.queryByRole("button", { name: "Fetch" })).toBeNull();
    expect(screen.getByRole("button", { name: "GitHub" })).toBeInTheDocument();
  });
});
