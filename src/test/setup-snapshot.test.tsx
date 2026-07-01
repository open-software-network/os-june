import {
  render,
  renderHook,
  screen,
  waitFor,
  act,
} from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  applySnapshot,
  buildSetupSnapshot,
  diffSnapshot,
  parseMcpServer,
  parseSetupSnapshot,
  requiredSecretId,
  serializeSetupSnapshot,
  setupSnapshotFilename,
  SECRET_PLACEHOLDER,
  useSetupSnapshotController,
  type HermesMcpCatalogEntry,
  type HermesMcpServerInfo,
  type HermesProfileSummary,
  type HermesSkillInfo,
  type HermesToolsetInfo,
  type SetupSnapshot,
  type SetupSnapshotState,
} from "../lib/hermes-admin";
import { SetupSnapshotView } from "../components/settings/SetupSnapshotSection";
import {
  makeAdminHarness,
  instantSleep,
} from "./fixtures/hermes-admin-harness";
import {
  FAKE_BEARER,
  FAKE_SECRET,
  richInstallScenario,
} from "./fixtures/hermes-admin-scenarios";

/** Parses a wire-shaped object into a HermesMcpServerInfo so the snapshot's
 * raw-reading redaction sees exactly what the client would hand it, including
 * env / header values that must NEVER leave. */
function serverFromWire(raw: Record<string, unknown>): HermesMcpServerInfo {
  const server = parseMcpServer(raw);
  if (!server) throw new Error("fixture did not parse");
  return server;
}

const emptyInput = {
  profile: "default",
  mode: "sandboxed",
  profiles: [] as HermesProfileSummary[],
  skills: [] as HermesSkillInfo[],
  mcpServers: [] as HermesMcpServerInfo[],
  catalog: [] as HermesMcpCatalogEntry[],
  toolsets: [] as HermesToolsetInfo[],
};

// ---------------------------------------------------------------------------
// Redaction — the core of this surface. No secret value may leak.
// ---------------------------------------------------------------------------

describe("setup snapshot — redaction", () => {
  it("records MCP env keys but never their values", () => {
    const server = serverFromWire({
      name: "github",
      enabled: true,
      transport: "http",
      url: "https://mcp.github.com",
      env: { GITHUB_TOKEN: FAKE_SECRET, NODE_ENV: "production" },
    });
    const snapshot = buildSetupSnapshot({
      ...emptyInput,
      mcpServers: [server],
    });
    const text = serializeSetupSnapshot(snapshot);

    expect(snapshot.mcpServers[0].envKeys).toEqual([
      "GITHUB_TOKEN",
      "NODE_ENV",
    ]);
    expect(text).not.toContain(FAKE_SECRET);
    expect(text).toContain("GITHUB_TOKEN");
  });

  it("records MCP header keys but never their values", () => {
    const server = serverFromWire({
      name: "linear",
      enabled: true,
      transport: "http",
      url: "https://mcp.linear.app",
      headers: { Authorization: FAKE_BEARER, "X-Trace": "ok" },
    });
    const snapshot = buildSetupSnapshot({
      ...emptyInput,
      mcpServers: [server],
    });
    const text = serializeSetupSnapshot(snapshot);

    expect(snapshot.mcpServers[0].headerKeys).toEqual([
      "Authorization",
      "X-Trace",
    ]);
    expect(text).not.toContain(FAKE_BEARER);
    expect(text).not.toContain("FAKE-aaaa");
  });

  it("represents required secrets as placeholders, never values", () => {
    const server = serverFromWire({
      name: "github",
      enabled: true,
      transport: "http",
      url: "https://mcp.github.com",
      env: { GITHUB_TOKEN: FAKE_SECRET },
      headers: { Authorization: FAKE_BEARER },
    });
    const snapshot = buildSetupSnapshot({
      ...emptyInput,
      mcpServers: [server],
    });

    const ids = snapshot.requiredInputs.map((secret) => ({
      key: secret.key,
      scope: secret.scope,
      owner: secret.owner,
      placeholder: secret.placeholder,
    }));
    expect(ids).toContainEqual({
      key: "GITHUB_TOKEN",
      scope: "mcp-env",
      owner: "github",
      placeholder: SECRET_PLACEHOLDER,
    });
    expect(ids).toContainEqual({
      key: "Authorization",
      scope: "mcp-header",
      owner: "github",
      placeholder: SECRET_PLACEHOLDER,
    });
    for (const secret of snapshot.requiredInputs) {
      expect(secret.placeholder).toBe(SECRET_PLACEHOLDER);
    }
  });

  it("records catalog required env keys as secrets, not values", () => {
    const catalog: HermesMcpCatalogEntry[] = [
      {
        id: "github",
        installName: "github",
        name: "GitHub",
        transport: "http-oauth",
        auth: "oauth",
        installed: true,
        enabled: true,
        requiredEnv: [{ key: "GITHUB_TOKEN", required: true, secret: true }],
        raw: {},
      },
    ];
    const snapshot = buildSetupSnapshot({ ...emptyInput, catalog });
    expect(snapshot.catalogInstalls[0].requiredEnvKeys).toEqual([
      "GITHUB_TOKEN",
    ]);
    expect(
      snapshot.requiredInputs.some(
        (secret) =>
          secret.scope === "catalog-env" && secret.key === "GITHUB_TOKEN",
      ),
    ).toBe(true);
  });

  it("drops a secret-shaped skill config value even when config is opted in", () => {
    const snapshot = buildSetupSnapshot({
      ...emptyInput,
      includeSkillConfig: true,
      skillConfig: {
        deploy: {
          region: "us-east-1",
          api_key: FAKE_SECRET.replace("sk-", "AKIA0000000000000000"),
        },
      },
    });
    const text = serializeSetupSnapshot(snapshot);
    expect(snapshot.skillConfig).toEqual([
      { skill: "deploy", key: "region", value: "us-east-1" },
    ]);
    expect(text).not.toContain("AKIA0000000000000000");
  });

  it("excludes private memory and session data from profile metadata", () => {
    const profiles: HermesProfileSummary[] = [
      {
        name: "work",
        description: "Work profile",
        provider: "venice",
        model: "llama-3.3",
        active: true,
        raw: { memory: "SECRET MEMORY", sessions: ["s1"] },
      },
    ];
    const snapshot = buildSetupSnapshot({ ...emptyInput, profiles });
    const text = serializeSetupSnapshot(snapshot);
    expect(snapshot.profiles[0]).toEqual({
      name: "work",
      description: "Work profile",
      provider: "venice",
      model: "llama-3.3",
    });
    expect(text).not.toContain("SECRET MEMORY");
  });
});

// ---------------------------------------------------------------------------
// Serialization round-trip + parsing (permissive, never throws).
// ---------------------------------------------------------------------------

describe("setup snapshot — parse", () => {
  it("round-trips a built snapshot back to an equivalent shape", () => {
    const server = serverFromWire({
      name: "filesystem",
      enabled: true,
      transport: "stdio",
      command: "mcp-server-filesystem",
      include_tools: ["read_file"],
    });
    const snapshot = buildSetupSnapshot({
      ...emptyInput,
      skills: [
        {
          name: "pdf",
          enabled: true,
          source: "hub",
          version: "1.0.0",
          raw: {},
        },
      ],
      mcpServers: [server],
    });
    const parsed = parseSetupSnapshot(serializeSetupSnapshot(snapshot));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.snapshot.skills[0].name).toBe("pdf");
    expect(parsed.snapshot.mcpServers[0].includeTools).toEqual(["read_file"]);
  });

  it("rejects non-JSON and non-object input without throwing", () => {
    expect(parseSetupSnapshot("not json {").ok).toBe(false);
    expect(parseSetupSnapshot(42).ok).toBe(false);
  });

  it("refuses a newer major schema version", () => {
    const result = parseSetupSnapshot({ schemaVersion: 999, profiles: [] });
    expect(result.ok).toBe(false);
  });

  it("degrades a malformed section to empty rather than crashing", () => {
    const result = parseSetupSnapshot({
      schemaVersion: 1,
      skills: "broken",
      mcpServers: [{ no_name: true }, { name: "ok", enabled: true }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.skills).toEqual([]);
    expect(result.snapshot.mcpServers.map((s) => s.name)).toEqual(["ok"]);
  });
});

// ---------------------------------------------------------------------------
// Diff preview — added / changed / removed.
// ---------------------------------------------------------------------------

describe("setup snapshot — diff", () => {
  function snapshotOf(partial: Partial<SetupSnapshot>): SetupSnapshot {
    return {
      schemaVersion: 1,
      generatedAt: new Date(0).toISOString(),
      profile: "default",
      mode: "sandboxed",
      notes: [],
      profiles: [],
      skills: [],
      mcpServers: [],
      catalogInstalls: [],
      toolFilters: [],
      requiredInputs: [],
      readiness: { toolsets: [] },
      ...partial,
    };
  }

  it("marks a skill not in the live setup as added", () => {
    const snapshot = snapshotOf({
      skills: [
        {
          name: "research",
          enabled: true,
          source: "hub",
          hubInstalled: true,
        },
      ],
    });
    const diff = diffSnapshot(snapshot, {
      skills: [],
      mcpServers: [],
      catalog: [],
    });
    const entry = diff.entries.find((e) => e.name === "research");
    expect(entry?.status).toBe("added");
    expect(diff.changeCount).toBe(1);
  });

  it("marks an enabled-state difference as changed", () => {
    const snapshot = snapshotOf({
      skills: [
        { name: "pdf", enabled: false, source: "bundled", hubInstalled: false },
      ],
    });
    const live: HermesSkillInfo[] = [
      { name: "pdf", enabled: true, source: "bundled", raw: {} },
    ];
    const diff = diffSnapshot(snapshot, {
      skills: live,
      mcpServers: [],
      catalog: [],
    });
    const entry = diff.entries.find((e) => e.name === "pdf");
    expect(entry?.status).toBe("changed");
    expect(entry?.detail).toContain("disabled");
  });

  it("marks a live skill missing from the snapshot as removed (advisory)", () => {
    const snapshot = snapshotOf({});
    const live: HermesSkillInfo[] = [
      { name: "legacy", enabled: true, source: "bundled", raw: {} },
    ];
    const diff = diffSnapshot(snapshot, {
      skills: live,
      mcpServers: [],
      catalog: [],
    });
    const entry = diff.entries.find((e) => e.name === "legacy");
    expect(entry?.status).toBe("removed");
    // Removals are advisory: they never count as a change to apply.
    expect(diff.changeCount).toBe(0);
  });

  it("surfaces required secrets in the diff for the secret prompt", () => {
    const snapshot = snapshotOf({
      mcpServers: [
        {
          name: "github",
          enabled: true,
          transport: "http",
          url: "https://mcp.github.com",
          envKeys: ["GITHUB_TOKEN"],
          headerKeys: [],
          includeTools: [],
          excludeTools: [],
        },
      ],
      requiredInputs: [
        {
          key: "GITHUB_TOKEN",
          scope: "mcp-env",
          owner: "github",
          placeholder: SECRET_PLACEHOLDER,
        },
      ],
    });
    const diff = diffSnapshot(snapshot, {
      skills: [],
      mcpServers: [],
      catalog: [],
    });
    expect(diff.requiredSecrets).toHaveLength(1);
    expect(requiredSecretId(diff.requiredSecrets[0])).toBe(
      "mcp-env:github:GITHUB_TOKEN",
    );
  });
});

// ---------------------------------------------------------------------------
// Filename helper.
// ---------------------------------------------------------------------------

describe("setup snapshot — filename", () => {
  it("builds a stable, filesystem-safe filename", () => {
    const name = setupSnapshotFilename(
      "my profile",
      new Date("2026-06-26T10:00:00Z"),
    );
    expect(name).toBe("june-setup-my-profile-2026-06-26T10-00-00-000Z.json");
  });
});

// ---------------------------------------------------------------------------
// Import driver — safe order, partial failure, health check.
// ---------------------------------------------------------------------------

describe("setup snapshot — import driver", () => {
  function importableSnapshot(): SetupSnapshot {
    return {
      schemaVersion: 1,
      generatedAt: new Date(0).toISOString(),
      profile: "default",
      mode: "sandboxed",
      notes: [],
      profiles: [],
      skills: [
        {
          name: "research",
          enabled: true,
          source: "hub",
          hubInstalled: true,
        },
      ],
      mcpServers: [
        {
          name: "memory",
          enabled: true,
          transport: "stdio",
          command: "mcp-server-memory",
          envKeys: ["MEMORY_KEY"],
          headerKeys: [],
          includeTools: ["recall"],
          excludeTools: [],
        },
      ],
      catalogInstalls: [],
      toolFilters: [],
      requiredInputs: [
        {
          key: "MEMORY_KEY",
          scope: "mcp-env",
          owner: "memory",
          placeholder: SECRET_PLACEHOLDER,
        },
      ],
      readiness: { toolsets: [] },
    };
  }

  it("applies in safe order and runs a post-import health check", async () => {
    const harness = makeAdminHarness(richInstallScenario());
    const report = await applySnapshot(harness.client, importableSnapshot(), {
      restartGateway: true,
      sleep: instantSleep,
    });

    // Hub install happened before the toggle.
    const categories = report.steps.map((s) => s.category);
    expect(categories.indexOf("skill-install")).toBeLessThan(
      categories.indexOf("skill-toggle"),
    );
    expect(categories.indexOf("mcp-add")).toBeLessThan(
      categories.indexOf("mcp-toggle"),
    );
    // Health check ran last.
    expect(report.steps.at(-1)?.category).toBe("health-check");
    expect(report.health).toBeDefined();
  });

  it("re-attaches only a supplied secret and warns about a missing one", async () => {
    const harness = makeAdminHarness(richInstallScenario());
    const report = await applySnapshot(harness.client, importableSnapshot(), {
      secrets: { "mcp-env:memory:MEMORY_KEY": "value-typed-by-user" },
      sleep: instantSleep,
    });
    const add = report.steps.find((s) => s.category === "mcp-add");
    expect(add?.status).toBe("applied");
    // Tool filters cannot be set over this Hermes version's API.
    const filter = report.steps.find((s) => s.category === "tool-filter");
    expect(filter?.status).toBe("unsupported");
  });

  it("never sends a secret value the user did not supply", async () => {
    const harness = makeAdminHarness(richInstallScenario());
    await applySnapshot(harness.client, importableSnapshot(), {
      sleep: instantSleep,
    });
    // The fake server logged every request body; no placeholder or empty env
    // value should have been sent for the unsupplied MEMORY_KEY.
    const addRequest = harness.server.requestLog.find(
      (entry) => entry.method === "POST" && entry.path === "/api/mcp/servers",
    );
    const body = addRequest?.body as Record<string, unknown> | undefined;
    expect(body?.env ?? {}).not.toHaveProperty("MEMORY_KEY");
    expect(JSON.stringify(harness.server.requestLog)).not.toContain(
      SECRET_PLACEHOLDER,
    );
  });

  it("reports a partial failure without aborting the run", async () => {
    const harness = makeAdminHarness(richInstallScenario());
    // Force the hub install to fail by stubbing the client method.
    const failing = {
      ...harness.client,
      skills: {
        ...harness.client.skills,
        hubInstall: () => Promise.reject(new Error("hub unreachable")),
      },
    } as typeof harness.client;
    const report = await applySnapshot(failing, importableSnapshot(), {
      sleep: instantSleep,
    });
    const install = report.steps.find((s) => s.category === "skill-install");
    expect(install?.status).toBe("failed");
    expect(report.hadFailures).toBe(true);
    // The run continued: the MCP add still happened after the failure.
    expect(report.steps.some((s) => s.category === "mcp-add")).toBe(true);
    expect(report.steps.at(-1)?.category).toBe("health-check");
  });
});

// ---------------------------------------------------------------------------
// Controller — export build + import preview through the shared engine.
// ---------------------------------------------------------------------------

describe("setup snapshot — controller", () => {
  it("loads live data and builds a sanitized export", async () => {
    const harness = makeAdminHarness(richInstallScenario());
    const { result } = renderHook(() =>
      useSetupSnapshotController(
        {
          target: harness.target,
          client: harness.client,
          cache: harness.cache,
          lifecycle: harness.lifecycle,
        },
        { sleep: instantSleep },
      ),
    );

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.canExport).toBe(true);

    const bundle = result.current.buildExport(new Date("2026-06-26T00:00:00Z"));
    expect(bundle.snapshot.skills.length).toBeGreaterThan(0);
    expect(bundle.filename).toContain("june-setup-");
    // Sanity: the export carries no secret values.
    expect(bundle.text).not.toContain(FAKE_SECRET);
  });

  it("previews a pasted snapshot and diffs it against the live setup", async () => {
    const harness = makeAdminHarness(richInstallScenario());
    const { result } = renderHook(() =>
      useSetupSnapshotController({
        target: harness.target,
        client: harness.client,
        cache: harness.cache,
        lifecycle: harness.lifecycle,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const pasted: SetupSnapshot = {
      schemaVersion: 1,
      generatedAt: new Date(0).toISOString(),
      profile: "default",
      mode: "sandboxed",
      notes: [],
      profiles: [],
      skills: [
        { name: "pdf", enabled: false, source: "bundled", hubInstalled: false },
      ],
      mcpServers: [],
      catalogInstalls: [],
      toolFilters: [],
      requiredInputs: [],
      readiness: { toolsets: [] },
    };

    act(() => {
      result.current.preview(serializeSetupSnapshot(pasted));
    });

    await waitFor(() => expect(result.current.importPhase).toBe("previewed"));
    // pdf is enabled live but disabled in the snapshot => a change.
    const entry = result.current.previewDiff?.entries.find(
      (e) => e.name === "pdf",
    );
    expect(entry?.status).toBe("changed");
  });
});

// ---------------------------------------------------------------------------
// View — render the diff preview, secret prompts, and failure report.
// ---------------------------------------------------------------------------

function stubState(overrides: Partial<SetupSnapshotState>): SetupSnapshotState {
  return {
    status: "ready",
    mode: "sandboxed",
    profile: "default",
    retryable: false,
    lifecycle: {
      state: "clean",
      label: "Up to date",
      detail: "No pending changes.",
      canRestart: false,
    },
    canExport: true,
    includeSkillConfig: false,
    setIncludeSkillConfig: () => {},
    refresh: () => {},
    buildExport: () => ({
      snapshot: {} as SetupSnapshot,
      text: "{}",
      filename: "june-setup.json",
    }),
    importPhase: "idle",
    preview: () => {},
    apply: () => Promise.resolve(),
    resetImport: () => {},
    ...overrides,
  };
}

describe("setup snapshot — view", () => {
  it("renders the diff and a password prompt for each required secret", () => {
    render(
      <SetupSnapshotView
        state={stubState({
          importPhase: "previewed",
          previewSnapshot: {} as SetupSnapshot,
          previewDiff: {
            entries: [
              {
                category: "mcp-server",
                name: "github",
                status: "added",
                detail: "Will be added and enabled.",
              },
            ],
            requiredSecrets: [
              {
                key: "GITHUB_TOKEN",
                scope: "mcp-env",
                owner: "github",
                placeholder: SECRET_PLACEHOLDER,
              },
            ],
            changeCount: 1,
          },
        })}
      />,
    );
    expect(screen.getByText("github")).toBeTruthy();
    // The secret prompt is a password input so a value is never shown.
    const secretInput = screen.getByLabelText(
      "github · GITHUB_TOKEN",
    ) as HTMLInputElement;
    expect(secretInput.type).toBe("password");
  });

  it("reports partial failures with a retry hint", () => {
    render(
      <SetupSnapshotView
        state={stubState({
          importPhase: "applied",
          report: {
            steps: [
              {
                category: "skill-install",
                name: "research",
                status: "failed",
                detail: "hub unreachable",
              },
              {
                category: "mcp-add",
                name: "memory",
                status: "applied",
                detail: "Added.",
              },
            ],
            hadFailures: true,
            restarted: false,
          },
        })}
      />,
    );
    expect(screen.getByText(/finished with some failures/i)).toBeTruthy();
    expect(screen.getByText("hub unreachable")).toBeTruthy();
  });
});
