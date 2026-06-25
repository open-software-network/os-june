import { describe, expect, it, vi } from "vitest";
import { HermesAdminError, createHermesAdminClient } from "../lib/hermes-admin";
import {
  makeAdminHarness,
  targetForFake,
} from "./fixtures/hermes-admin-harness";
import { FakeHermesServer } from "./fixtures/fake-hermes-server";
import {
  emptyInstallScenario,
  mcpStdioWithToolsScenario,
  richInstallScenario,
} from "./fixtures/hermes-admin-scenarios";

describe("HermesAdminClient — requests, auth, profile targeting", () => {
  it("lists skills, sending the auth token in the header (never the URL)", async () => {
    const { client, server } = makeAdminHarness(richInstallScenario());
    const skills = await client.skills.list();
    expect(skills.map((s) => s.name)).toEqual([
      "pdf",
      "research",
      "company-style",
    ]);

    const entry = server.requestLog.at(-1);
    expect(entry?.method).toBe("GET");
    expect(entry?.path).toBe("/api/skills");
    // The token rides on the header, so a logged URL cannot leak it.
    expect(entry?.token).toBe(server.token);
  });

  it("scopes profile-sensitive requests with ?profile= by default", async () => {
    const { client, server } = makeAdminHarness(richInstallScenario(), {
      profile: "default",
    });
    await client.skills.list();
    expect(server.requestLog.at(-1)?.query.profile).toBe("default");
  });

  it("carries a non-default profile through to the query string", async () => {
    const server = new FakeHermesServer(richInstallScenario());
    const target = targetForFake(server, { profile: "work" });
    const client = createHermesAdminClient(target, { fetch: server.fetch });
    await client.skills.list();
    expect(server.requestLog.at(-1)?.query.profile).toBe("work");
  });

  it("does NOT add a profile query to gateway lifecycle endpoints", async () => {
    const { client, server } = makeAdminHarness(richInstallScenario());
    await client.gateway.status();
    const entry = server.requestLog.at(-1);
    expect(entry?.path).toBe("/api/status");
    expect(entry?.query.profile).toBeUndefined();
  });

  it("toggles a skill and round-trips the new state via the fake's state", async () => {
    const { client } = makeAdminHarness(richInstallScenario());
    const outcome = await client.skills.toggle("research", true);
    expect(outcome.result).toEqual({
      ok: true,
      name: "research",
      enabled: true,
    });
    // The mutation reports its application timing.
    expect(outcome.appliesAt).toBe("next-session");
    expect(outcome.requiresRestart).toBe(false);

    const after = await client.skills.list();
    expect(after.find((s) => s.name === "research")?.enabled).toBe(true);
  });

  it("encodes path params so a slashed toolset name cannot break the route", async () => {
    const scenario = richInstallScenario();
    scenario.toolsets = [{ name: "a/b", enabled: false }];
    const { client, server } = makeAdminHarness(scenario);
    await client.toolsets.toggle("a/b", true);
    const entry = server.requestLog.at(-1);
    expect(entry?.path).toBe("/api/tools/toolsets/a%2Fb");
    expect(entry?.method).toBe("PUT");
  });

  it("adds an MCP server and tags the mutation as restart-required", async () => {
    const { client } = makeAdminHarness(mcpStdioWithToolsScenario());
    const outcome = await client.mcp.addServer({
      name: "postgres",
      transport: "stdio",
      command: "mcp-server-postgres",
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.appliesAt).toBe("gateway-restart");
    expect(outcome.requiresRestart).toBe(true);
    expect(outcome.result?.name).toBe("postgres");
  });

  it("signals ok:true on a 2xx even when the server omits the object from its response", async () => {
    // A 204-style success with an empty body: the parser yields `undefined`,
    // but `ok` lets a UI tell "succeeded, body omitted" from a thrown error.
    const fetchEmpty = vi.fn(
      async () =>
        new Response("", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const server = new FakeHermesServer();
    const client = createHermesAdminClient(targetForFake(server), {
      fetch: fetchEmpty,
    });
    const outcome = await client.mcp.addServer({ name: "x" });
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toBeUndefined();
  });

  it("returns MCP test results as a MutationOutcome with the discovered tools", async () => {
    const { client } = makeAdminHarness(mcpStdioWithToolsScenario());
    const outcome = await client.mcp.testServer("sqlite");
    // testServer is a MutationOutcome like its siblings: the request landed
    // (outcome.ok) and the probe connected (result.ok); a test applies now.
    expect(outcome.ok).toBe(true);
    expect(outcome.mutation).toBe("mcp.test");
    expect(outcome.appliesAt).toBe("immediate");
    expect(outcome.requiresRestart).toBe(false);
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.tools?.map((t) => t.name)).toEqual([
      "query",
      "execute",
      "schema",
    ]);
  });

  it("lists an empty install as empty arrays, not errors", async () => {
    const { client } = makeAdminHarness(emptyInstallScenario());
    expect(await client.skills.list()).toEqual([]);
    expect(await client.toolsets.list()).toEqual([]);
    expect(await client.mcp.listServers()).toEqual([]);
    expect(await client.mcp.catalog()).toEqual([]);
  });
});

describe("HermesAdminClient — real-contract paths and shapes (v2026.6.19)", () => {
  it("env.set uses PUT /api/env with { key, value }, not POST", async () => {
    const { client, server } = makeAdminHarness(emptyInstallScenario());
    const outcome = await client.env.set("OPENAI_API_KEY", "sk-FAKE-abc123");
    expect(outcome.ok).toBe(true);
    const entry = server.requestLog.at(-1);
    expect(entry?.method).toBe("PUT");
    expect(entry?.path).toBe("/api/env");
    expect(entry?.body).toMatchObject({
      key: "OPENAI_API_KEY",
      value: "sk-FAKE-abc123",
    });
  });

  it("env.delete uses DELETE /api/env with the key in the BODY (not the path)", async () => {
    const { client, server } = makeAdminHarness(emptyInstallScenario());
    await client.env.set("TMP_KEY", "v");
    await client.env.delete("TMP_KEY");
    const entry = server.requestLog.at(-1);
    expect(entry?.method).toBe("DELETE");
    expect(entry?.path).toBe("/api/env"); // no /{key} segment
    expect(entry?.body).toMatchObject({ key: "TMP_KEY" });
  });

  it("env.list reads GET /api/env and never surfaces the value", async () => {
    const { client } = makeAdminHarness(emptyInstallScenario());
    await client.env.set("OPENAI_API_KEY", "sk-FAKE-secretvalue999");
    const listing = await client.env.list();
    expect(listing.vars.some((v) => v.key === "OPENAI_API_KEY")).toBe(true);
    // The listing carries presence/preview, never the plaintext value.
    expect(JSON.stringify(listing.vars)).not.toContain(
      "sk-FAKE-secretvalue999",
    );
  });

  it("env.reveal reads POST /api/env/reveal and returns the plaintext value", async () => {
    const { client, server } = makeAdminHarness(emptyInstallScenario());
    await client.env.set("OPENAI_API_KEY", "sk-FAKE-revealme123");
    const revealed = await client.env.reveal("OPENAI_API_KEY");
    expect(revealed.value).toBe("sk-FAKE-revealme123");
    const entry = server.requestLog.at(-1);
    expect(entry?.method).toBe("POST");
    expect(entry?.path).toBe("/api/env/reveal");
    expect(entry?.body).toMatchObject({ key: "OPENAI_API_KEY" });
  });

  it("installCatalogEntry sends the required `name` field (not `id`)", async () => {
    const { client, server } = makeAdminHarness(richInstallScenario());
    const outcome = await client.mcp.installCatalogEntry({ name: "github" });
    expect(outcome.ok).toBe(true);
    const entry = server.requestLog.at(-1);
    expect(entry?.path).toBe("/api/mcp/catalog/install");
    expect(entry?.body).toMatchObject({ name: "github" });
  });

  it("a catalog entry's parsed name is the install identifier", async () => {
    const { client } = makeAdminHarness(richInstallScenario());
    const catalog = await client.mcp.catalog();
    const github = catalog.find((e) => e.name === "github");
    expect(github).toBeDefined();
    // The same value round-trips into a successful install.
    const outcome = await client.mcp.installCatalogEntry({
      name: github!.name,
    });
    expect(outcome.ok).toBe(true);
  });

  it("hubInstall sends only { identifier } (no unsupported source/force)", async () => {
    const { client, server } = makeAdminHarness(richInstallScenario());
    await client.skills.hubInstall("skills.sh/data-science");
    const entry = server.requestLog.at(-1);
    expect(entry?.path).toBe("/api/skills/hub/install");
    expect(entry?.body).toEqual({ identifier: "skills.sh/data-science" });
  });

  it("hubUpdate sends an empty body (update scopes by profile, no name field)", async () => {
    const { client, server } = makeAdminHarness(richInstallScenario());
    await client.skills.hubUpdate("research");
    const entry = server.requestLog.at(-1);
    expect(entry?.path).toBe("/api/skills/hub/update");
    expect(entry?.body).toEqual({});
  });
});

describe("HermesAdminClient — error normalization", () => {
  it("normalizes 401 into a safe, non-retryable auth error", async () => {
    const server = new FakeHermesServer(richInstallScenario());
    // Build a client with the WRONG token so the fake returns 401.
    const target = { ...targetForFake(server), token: "wrong-token" };
    const client = createHermesAdminClient(target, { fetch: server.fetch });

    const error = await client.skills.list().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HermesAdminError);
    const adminError = error as HermesAdminError;
    expect(adminError.kind).toBe("http");
    expect(adminError.status).toBe(401);
    expect(adminError.retryable).toBe(false);
    expect(adminError.safeMessage).toBe(
      "Hermes rejected the request (not authorized).",
    );
  });

  it("normalizes 404 with the safe not-found message", async () => {
    const { client } = makeAdminHarness(richInstallScenario());
    const error = await client.skills.toggle("does-not-exist", true).then(
      () => undefined,
      (e: unknown) => e as HermesAdminError,
    );
    expect(error?.status).toBe(404);
    expect(error?.safeMessage).toBe("That Hermes resource was not found.");
    expect(error?.retryable).toBe(false);
  });

  it("normalizes 500 into a retryable error", async () => {
    // A custom fetch that always 500s.
    const fetch500 = vi.fn(
      async () =>
        new Response("upstream boom", {
          status: 500,
          headers: { "Content-Type": "text/plain" },
        }),
    );
    const server = new FakeHermesServer();
    const client = createHermesAdminClient(targetForFake(server), {
      fetch: fetch500,
    });
    const error = await client.skills.list().then(
      () => undefined,
      (e: unknown) => e as HermesAdminError,
    );
    expect(error?.status).toBe(500);
    expect(error?.retryable).toBe(true);
    expect(error?.safeMessage).toBe(
      "Hermes ran into a problem with that request.",
    );
  });

  it("treats malformed JSON in a 2xx as a parse error, not a crash", async () => {
    const fetchBadJson = vi.fn(
      async () =>
        new Response("{not json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const server = new FakeHermesServer();
    const client = createHermesAdminClient(targetForFake(server), {
      fetch: fetchBadJson,
    });
    const error = await client.skills.list().then(
      () => undefined,
      (e: unknown) => e as HermesAdminError,
    );
    expect(error?.kind).toBe("parse");
    expect(error?.safeMessage).toBe("Hermes returned an unexpected response.");
    // The error names the REAL endpoint, not a placeholder like "(response)".
    expect(error?.endpoint).toBe("GET /api/skills");
    expect(error?.status).toBe(200);
  });

  it("maps a thrown network failure to a retryable network error", async () => {
    const fetchThrows = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const server = new FakeHermesServer();
    const client = createHermesAdminClient(targetForFake(server), {
      fetch: fetchThrows,
    });
    const error = await client.gateway.status().then(
      () => undefined,
      (e: unknown) => e as HermesAdminError,
    );
    expect(error?.kind).toBe("network");
    expect(error?.retryable).toBe(true);
    expect(error?.safeMessage).toBe("Could not reach Hermes.");
  });

  it("maps an aborted request (client timeout) to a timeout error", async () => {
    const fetchAborts = vi.fn(async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });
    const server = new FakeHermesServer();
    const client = createHermesAdminClient(targetForFake(server), {
      fetch: fetchAborts,
    });
    const error = await client.gateway.status().then(
      () => undefined,
      (e: unknown) => e as HermesAdminError,
    );
    expect(error?.kind).toBe("timeout");
    expect(error?.retryable).toBe(true);
  });
});
