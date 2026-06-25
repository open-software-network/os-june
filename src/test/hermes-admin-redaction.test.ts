import { describe, expect, it, vi } from "vitest";
import {
  HermesAdminError,
  createHermesAdminClient,
  redactBodyPreview,
  redactForLog,
  redactUrl,
} from "../lib/hermes-admin";
import {
  makeAdminHarness,
  targetForFake,
} from "./fixtures/hermes-admin-harness";
import { FakeHermesServer } from "./fixtures/fake-hermes-server";
import {
  FAKE_BEARER,
  FAKE_SECRET,
  mcpOAuthAuthMissingScenario,
  mcpStdioWithToolsScenario,
} from "./fixtures/hermes-admin-scenarios";

/** Serializes every captured log record to one string for leak scanning. */
function logsAsText(logs: Array<Record<string, unknown>>): string {
  return JSON.stringify(logs);
}

describe("hermes-admin redaction — secrets never reach logs or errors", () => {
  it("never logs the dashboard auth token", async () => {
    const { client, logs, target } = makeAdminHarness(
      mcpStdioWithToolsScenario(),
    );
    await client.skills.list();
    expect(logs.length).toBeGreaterThan(0);
    // The token is real (the fake required it) — it must not appear anywhere
    // in the emitted diagnostics.
    expect(logsAsText(logs)).not.toContain(target.token);
  });

  it("redacts an env value submitted via env.set from the request log", async () => {
    const { client, logs } = makeAdminHarness(mcpStdioWithToolsScenario());
    await client.env.set("OPENAI_API_KEY", FAKE_SECRET);
    const text = logsAsText(logs);
    // The request body was logged (redacted): the key name may show, the value
    // must not.
    expect(text).not.toContain(FAKE_SECRET);
  });

  it("never logs anything for env.reveal (the response is a plaintext secret)", async () => {
    const { client, server, logs } = makeAdminHarness(
      mcpStdioWithToolsScenario(),
    );
    // Seed a value, then reveal it.
    await client.env.set("OPENAI_API_KEY", FAKE_SECRET);
    const logsBefore = logs.length;
    const revealed = await client.env.reveal("OPENAI_API_KEY");
    // The caller DOES get the value back (that is reveal's purpose)...
    expect(revealed.value).toBe(FAKE_SECRET);
    // ...but the reveal call is `silent`: it emits NO log record at all, so the
    // value cannot leak even if response-body logging is later added.
    expect(logs.length).toBe(logsBefore);
    expect(logsAsText(logs)).not.toContain(FAKE_SECRET);
    // The request reached the reveal endpoint (so silence is by design, not a
    // skipped call).
    expect(server.requestLog.at(-1)?.path).toBe("/api/env/reveal");
  });

  it("redacts an MCP server payload's env and headers before logging", async () => {
    const { client, logs } = makeAdminHarness(mcpStdioWithToolsScenario());
    await client.mcp.addServer({
      name: "secret-server",
      transport: "http-oauth",
      url: "https://example.test/mcp",
      env: { API_KEY: FAKE_SECRET },
      headers: { Authorization: FAKE_BEARER },
    });
    const text = logsAsText(logs);
    expect(text).not.toContain(FAKE_SECRET);
    expect(text).not.toContain(FAKE_BEARER);
    expect(text).not.toContain("FAKE-aaaa");
  });

  it("never returns secret-bearing MCP config in a list response", async () => {
    // The OAuth scenario stores a bearer header server-side; the GET must not
    // echo it (the client never reads it, and the fake mirrors the real
    // dashboard by stripping it).
    const { client } = makeAdminHarness(mcpOAuthAuthMissingScenario());
    const servers = await client.mcp.listServers();
    const serialized = JSON.stringify(servers);
    expect(serialized).not.toContain(FAKE_BEARER);
    expect(serialized).not.toContain("FAKE-");
  });

  it("keeps a secret out of a parse-error's raw body preview and log", async () => {
    // A 2xx body that is MALFORMED json AND contains a secret-shaped value
    // drives the transport's real `kind: "parse"` path. Both the resulting
    // error's debug preview and the emitted log record must be redacted.
    const leakyBody = `{ "api_key": "${FAKE_SECRET}", "note": "Bearer ${"z".repeat(
      40,
    )}", BROKEN`;
    const fetchLeaky = vi.fn(
      async () =>
        new Response(leakyBody, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const server = new FakeHermesServer();
    const logs: Array<Record<string, unknown>> = [];
    const client = createHermesAdminClient(targetForFake(server), {
      fetch: fetchLeaky,
      logger: (record) => logs.push(record),
    });

    const error = await client.skills.list().then(
      () => undefined,
      (e: unknown) => e as HermesAdminError,
    );
    expect(error?.kind).toBe("parse");
    expect(error?.rawBodyPreview).toBeDefined();
    expect(error?.rawBodyPreview).not.toContain(FAKE_SECRET);
    expect(error?.rawBodyPreview).not.toContain("zzzz");
    expect(logsAsText(logs)).not.toContain(FAKE_SECRET);
    expect(logsAsText(logs)).not.toContain("zzzz");

    // The standalone preview redactor (used by the parse path) also masks a
    // secret inside well-formed JSON.
    const preview = redactBodyPreview(JSON.stringify({ api_key: FAKE_SECRET }));
    expect(preview).not.toContain(FAKE_SECRET);
  });

  it("masks a secret-shaped value under a BENIGN key on the success (parsed) path", () => {
    // A 44-char separator-free run under an innocent key name. The structural
    // sanitizer's value-shape backstop catches it even though the key is benign.
    const benignKeySecret = "AKIA" + "Z".repeat(40);
    const preview = redactBodyPreview(
      JSON.stringify({ custom_field: benignKeySecret, ok: "fine" }),
    );
    expect(preview).not.toContain(benignKeySecret);
    expect(preview).toContain("fine");
  });

  it("masks a secret-shaped value under a BENIGN key on the MALFORMED path too (parity)", () => {
    // Same secret-shaped value, but the body is unparseable JSON so the
    // structural sanitizer never runs. The raw-string value-shape backstop must
    // still catch it — reaching parity with the parsed path.
    const benignKeySecret = "AKIA" + "Z".repeat(40);
    const malformed = `{ "custom_field": "${benignKeySecret}", "path": "/Users/me/notes.md", BROKEN`;
    const preview = redactBodyPreview(malformed);
    expect(preview).not.toContain(benignKeySecret);
    // A path is a location, not a credential: it is exempt and survives.
    expect(preview).toContain("/Users/me/notes.md");
  });

  it("the malformed path surfaces a benign-key secret nowhere in the error or log", async () => {
    const benignKeySecret = "ghp" + "x".repeat(40);
    const malformed = `{ "webhook": "${benignKeySecret}", BROKEN`;
    const fetchLeaky = vi.fn(
      async () =>
        new Response(malformed, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const server = new FakeHermesServer();
    const logs: Array<Record<string, unknown>> = [];
    const client = createHermesAdminClient(targetForFake(server), {
      fetch: fetchLeaky,
      logger: (record) => logs.push(record),
    });
    const error = await client.skills.list().then(
      () => undefined,
      (e: unknown) => e as HermesAdminError,
    );
    expect(error?.kind).toBe("parse");
    expect(error?.rawBodyPreview).not.toContain(benignKeySecret);
    expect(logsAsText(logs)).not.toContain(benignKeySecret);
  });

  it("HermesAdminError.rawBodyPreview is redacted on construction", () => {
    const error = new HermesAdminError({
      endpoint: "POST /api/env",
      kind: "http",
      status: 400,
      rawBody: JSON.stringify({ error: "bad", value: FAKE_SECRET }),
    });
    expect(error.rawBodyPreview).toBeDefined();
    expect(error.rawBodyPreview).not.toContain(FAKE_SECRET);
    // The safe message never echoes the body.
    expect(error.safeMessage).not.toContain(FAKE_SECRET);
    expect(error.toLogSafe().rawBodyPreview).not.toContain(FAKE_SECRET);
  });

  it("redactUrl strips a token query parameter", () => {
    const redacted = redactUrl(
      "http://127.0.0.1:5000/api/ws?token=super-secret-token&profile=default",
    );
    expect(redacted).not.toContain("super-secret-token");
    expect(redacted).toContain("profile=default");
  });

  it("redactUrl scrubs a token from a non-parseable (relative) URL too", () => {
    const redacted = redactUrl("/api/x?api_key=abc123secret&ok=1");
    expect(redacted).not.toContain("abc123secret");
    expect(redacted).toContain("ok=1");
  });

  it("redactForLog masks sensitive keys recursively", () => {
    const masked = redactForLog({
      name: "ok",
      headers: { Authorization: FAKE_BEARER },
      nested: { api_key: FAKE_SECRET, fine: "visible" },
    }) as Record<string, unknown>;
    const text = JSON.stringify(masked);
    expect(text).not.toContain(FAKE_BEARER);
    expect(text).not.toContain(FAKE_SECRET);
    expect(text).toContain("visible");
  });
});
