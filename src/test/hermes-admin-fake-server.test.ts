import { describe, expect, it } from "vitest";
import {
  AdminStateCache,
  adminTargetFromConnection,
  createHermesAdminClient,
} from "../lib/hermes-admin";
import {
  FakeHermesServer,
  type FakeHermesScenario,
} from "./fixtures/fake-hermes-server";
import {
  connectionForFake,
  makeAdminHarness,
} from "./fixtures/hermes-admin-harness";
import {
  emptyInstallScenario,
  gatewayRestartPendingScenario,
  mcpBadCommandScenario,
  mcpNoServersScenario,
  mcpOAuthAuthMissingScenario,
  mcpStdioWithToolsScenario,
  mcpToolFilteringScenario,
  pendingSkillWritesScenario,
  profileIsolationScenarios,
  richInstallScenario,
  skillSecurityWarningScenario,
} from "./fixtures/hermes-admin-scenarios";

/** Raw request against a fake server (bypassing the client) for route coverage. */
async function call(
  server: FakeHermesServer,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const response = await server.fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      "X-Hermes-Session-Token": server.token,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

describe("FakeHermesServer — every route responds", () => {
  it("requires the auth token (401 without it)", async () => {
    const server = new FakeHermesServer(richInstallScenario());
    const response = await server.fetch(`${server.baseUrl}/api/skills`, {
      method: "GET",
    });
    expect(response.status).toBe(401);
  });

  it("serves skills, toolsets, mcp servers, catalog, and status", async () => {
    const server = new FakeHermesServer(richInstallScenario());
    expect((await call(server, "GET", "/api/skills")).status).toBe(200);
    expect((await call(server, "GET", "/api/tools/toolsets")).status).toBe(200);
    expect((await call(server, "GET", "/api/mcp/servers")).status).toBe(200);
    expect((await call(server, "GET", "/api/mcp/catalog")).status).toBe(200);
    expect((await call(server, "GET", "/api/status")).status).toBe(200);
  });

  it("mutates skill toggle state and rejects unknown skills with 404", async () => {
    const server = new FakeHermesServer(richInstallScenario());
    const ok = await call(server, "PUT", "/api/skills/toggle", {
      name: "research",
      enabled: true,
    });
    expect(ok.status).toBe(200);
    const missing = await call(server, "PUT", "/api/skills/toggle", {
      name: "nope",
      enabled: true,
    });
    expect(missing.status).toBe(404);
  });

  it("adds an MCP server, rejects a duplicate with 409, and removes it", async () => {
    const server = new FakeHermesServer(mcpNoServersScenario());
    const added = await call(server, "POST", "/api/mcp/servers", {
      name: "fs",
      transport: "stdio",
      command: "x",
    });
    expect(added.status).toBe(200);
    const dup = await call(server, "POST", "/api/mcp/servers", { name: "fs" });
    expect(dup.status).toBe(409);
    const removed = await call(server, "DELETE", "/api/mcp/servers/fs");
    expect(removed.status).toBe(200);
    const removeMissing = await call(server, "DELETE", "/api/mcp/servers/fs");
    expect(removeMissing.status).toBe(404);
  });

  it("reports a failing MCP test with a safe message", async () => {
    const server = new FakeHermesServer(mcpBadCommandScenario());
    const result = await call(server, "POST", "/api/mcp/servers/broken/test");
    expect(result.status).toBe(200);
    expect((result.json as { ok: boolean }).ok).toBe(false);
    expect((result.json as { message: string }).message).toContain(
      "command not found",
    );
  });

  it("backgrounds actions and advances them over polls", async () => {
    const server = new FakeHermesServer(gatewayRestartPendingScenario());
    const started = await call(server, "POST", "/api/gateway/restart");
    expect(started.status).toBe(202);
    const action = (started.json as { action: string }).action;

    const states: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const status = await call(server, "GET", `/api/actions/${action}/status`);
      states.push((status.json as { state: string }).state);
    }
    expect(states).toEqual(["queued", "running", "running", "succeeded"]);
  });

  it("404s an unknown action", async () => {
    const server = new FakeHermesServer(gatewayRestartPendingScenario());
    const status = await call(server, "GET", "/api/actions/ghost/status");
    expect(status.status).toBe(404);
  });

  it("env: PUT sets, GET masks the value, reveal returns it, DELETE takes the key in the body", async () => {
    const server = new FakeHermesServer(emptyInstallScenario());
    // PUT /api/env (NOT POST) with { key, value }.
    const set = await call(server, "PUT", "/api/env", {
      key: "OPENAI_API_KEY",
      value: "sk-FAKE-xyz1234567890",
    });
    expect(set.status).toBe(200);
    expect(JSON.stringify(set.json)).not.toContain("sk-FAKE-xyz");

    // GET /api/env lists presence + a masked preview, never the value.
    const list = await call(server, "GET", "/api/env");
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.json)).not.toContain("sk-FAKE-xyz1234567890");
    const vars = (list.json as { vars: Array<{ key: string }> }).vars;
    expect(vars.some((v) => v.key === "OPENAI_API_KEY")).toBe(true);

    // POST /api/env/reveal DOES return the plaintext value.
    const revealed = await call(server, "POST", "/api/env/reveal", {
      key: "OPENAI_API_KEY",
    });
    expect(revealed.status).toBe(200);
    expect((revealed.json as { value: string }).value).toBe(
      "sk-FAKE-xyz1234567890",
    );

    // DELETE /api/env with the key in the BODY (not the path).
    const del = await call(server, "DELETE", "/api/env", {
      key: "OPENAI_API_KEY",
    });
    expect(del.status).toBe(200);

    // The old path-style delete no longer exists -> 404.
    const oldStyle = await call(server, "DELETE", "/api/env/OPENAI_API_KEY");
    expect(oldStyle.status).toBe(404);
  });

  it("logs the profile query the client sends", async () => {
    const server = new FakeHermesServer(richInstallScenario());
    await call(server, "GET", "/api/skills?profile=default");
    expect(server.requestLog.at(-1)?.query.profile).toBe("default");
  });
});

describe("client schemas parse every fixture (contract tests)", () => {
  const scenarios: Array<[string, FakeHermesScenario]> = [
    ["empty install", emptyInstallScenario()],
    ["rich install", richInstallScenario()],
    ["skill security warning", skillSecurityWarningScenario()],
    ["pending skill writes", pendingSkillWritesScenario()],
    ["mcp no servers", mcpNoServersScenario()],
    ["mcp stdio with tools", mcpStdioWithToolsScenario()],
    ["mcp oauth auth missing", mcpOAuthAuthMissingScenario()],
    ["mcp bad command", mcpBadCommandScenario()],
    ["mcp tool filtering", mcpToolFilteringScenario()],
    ["gateway restart pending", gatewayRestartPendingScenario()],
  ];

  for (const [name, scenario] of scenarios) {
    it(`parses ${name} without throwing`, async () => {
      const { client } = makeAdminHarness(scenario);
      // Every list endpoint returns a typed array (possibly empty).
      const [skills, toolsets, servers, catalog, status] = await Promise.all([
        client.skills.list(),
        client.toolsets.list(),
        client.mcp.listServers(),
        client.mcp.catalog(),
        client.gateway.status(),
      ]);
      expect(Array.isArray(skills)).toBe(true);
      expect(Array.isArray(toolsets)).toBe(true);
      expect(Array.isArray(servers)).toBe(true);
      expect(Array.isArray(catalog)).toBe(true);
      expect(status.raw).toBeDefined();
    });
  }

  it("normalizes MCP transports and auth status from the fixtures", async () => {
    const { client } = makeAdminHarness(mcpOAuthAuthMissingScenario());
    const [server] = await client.mcp.listServers();
    expect(server.transport).toBe("http-oauth");
    expect(server.auth).toBe("unauthenticated");
    expect(server.status).toBe("error");
    expect(server.statusMessage).toContain("Not authenticated");
  });

  it("normalizes tool include/exclude filters from the fixture", async () => {
    const { client } = makeAdminHarness(mcpToolFilteringScenario());
    const [server] = await client.mcp.listServers();
    expect(server.includeTools).toEqual(["list_issues", "create_issue"]);
    expect(server.excludeTools).toEqual(["delete_repo"]);
  });

  it("marks an external skill read-only and keeps the raw payload", async () => {
    const { client } = makeAdminHarness(richInstallScenario());
    const skills = await client.skills.list();
    const external = skills.find((s) => s.name === "company-style");
    expect(external?.source).toBe("external");
    expect(external?.readOnly).toBe(true);
    expect(external?.raw).toBeDefined();
  });
});

describe("profile switch data isolation (end to end)", () => {
  it("data from one profile/mode is never shown under another", async () => {
    const { sandboxed, unrestricted } = profileIsolationScenarios();
    const sandboxedServer = new FakeHermesServer(sandboxed);
    const unrestrictedServer = new FakeHermesServer(unrestricted);

    const sandboxedTarget = adminTargetFromConnection(
      connectionForFake(sandboxedServer, { mode: "sandboxed" }),
    );
    const unrestrictedTarget = adminTargetFromConnection(
      connectionForFake(unrestrictedServer, { mode: "unrestricted" }),
    );

    const sandboxedClient = createHermesAdminClient(sandboxedTarget, {
      fetch: sandboxedServer.fetch,
    });
    const unrestrictedClient = createHermesAdminClient(unrestrictedTarget, {
      fetch: unrestrictedServer.fetch,
    });

    const sandboxedCache = new AdminStateCache(sandboxedTarget);
    const unrestrictedCache = new AdminStateCache(unrestrictedTarget);

    sandboxedCache.set("skills", await sandboxedClient.skills.list());
    unrestrictedCache.set("skills", await unrestrictedClient.skills.list());

    // Each cache holds only its own profile's data.
    expect(
      sandboxedCache.get<Array<{ name: string }>>("skills")?.map((s) => s.name),
    ).toEqual(["skill-a"]);
    expect(
      unrestrictedCache
        .get<Array<{ name: string }>>("skills")
        ?.map((s) => s.name),
    ).toEqual(["skill-b"]);

    // The cache keys differ, so no cross-profile read is even possible.
    expect(sandboxedCache.keyFor("skills")).not.toBe(
      unrestrictedCache.keyFor("skills"),
    );
  });
});
