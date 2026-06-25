import { describe, expect, it } from "vitest";
// Read the client/transport SOURCE as text (Vite `?raw`) for the structural
// guard below — no node fs needed, works in the jsdom test environment.
import clientSource from "../lib/hermes-admin/client.ts?raw";
import transportSource from "../lib/hermes-admin/transport.ts?raw";
import {
  adminTargetForCurrentMode,
  adminTargetForMode,
  adminTargetFromConnection,
  createHermesAdminClient,
  modeForConnection,
  targetKey,
} from "../lib/hermes-admin";
import type { HermesBridgeConnection, HermesBridgeStatus } from "../lib/tauri";
import { FakeHermesServer } from "./fixtures/fake-hermes-server";
import { connectionForFake } from "./fixtures/hermes-admin-harness";

function connection(
  overrides: Partial<HermesBridgeConnection>,
): HermesBridgeConnection {
  return {
    baseUrl: "http://127.0.0.1:1000",
    wsUrl: "ws://127.0.0.1:1000/api/ws",
    token: "t",
    port: 1000,
    command: "hermes",
    hermesHome: "/home/.hermes",
    cwd: null,
    providerProxyPort: 1,
    pid: 1,
    sandboxed: true,
    fullMode: false,
    ...overrides,
  };
}

describe("admin targeting — profile/mode must be explicit", () => {
  it("derives mode from the connection's fullMode flag", () => {
    expect(modeForConnection(connection({ fullMode: false }))).toBe(
      "sandboxed",
    );
    expect(modeForConnection(connection({ fullMode: true }))).toBe(
      "unrestricted",
    );
  });

  it("selects the matching mode from a multi-connection status", () => {
    const status: HermesBridgeStatus = {
      running: true,
      connections: [
        connection({ baseUrl: "http://127.0.0.1:1000", fullMode: false }),
        connection({
          baseUrl: "http://127.0.0.1:2000",
          fullMode: true,
          sandboxed: false,
        }),
      ],
    };
    expect(adminTargetForMode(status, "sandboxed")?.baseUrl).toBe(
      "http://127.0.0.1:1000",
    );
    expect(adminTargetForMode(status, "unrestricted")?.baseUrl).toBe(
      "http://127.0.0.1:2000",
    );
  });

  it("returns undefined (does NOT fall back to the other runtime) when the requested mode is not running", () => {
    // Only the sandboxed runtime is up. Asking for unrestricted must NOT
    // silently return the sandboxed connection — that is the exact "implicit
    // first connection" bug this whole design forbids.
    const status: HermesBridgeStatus = {
      running: true,
      connections: [connection({ fullMode: false })],
    };
    expect(adminTargetForMode(status, "unrestricted")).toBeUndefined();
    expect(adminTargetForCurrentMode(status, "unrestricted")).toBeUndefined();
    // The mode that IS running resolves.
    expect(adminTargetForCurrentMode(status, "sandboxed")).toBeDefined();
  });

  it("does not pick connections[0] when the first entry is the wrong mode", () => {
    // First entry is unrestricted; a sandboxed caller must get the SECOND one,
    // proving selection is by mode, not by position.
    const status: HermesBridgeStatus = {
      running: true,
      connections: [
        connection({
          baseUrl: "http://127.0.0.1:9000",
          fullMode: true,
          sandboxed: false,
        }),
        connection({ baseUrl: "http://127.0.0.1:8000", fullMode: false }),
      ],
    };
    expect(adminTargetForMode(status, "sandboxed")?.baseUrl).toBe(
      "http://127.0.0.1:8000",
    );
  });

  it("targetKey is profile- and mode-scoped, so two targets cannot collide", () => {
    const sandboxed = adminTargetFromConnection(
      connection({ fullMode: false }),
      "default",
    );
    const unrestricted = adminTargetFromConnection(
      connection({ fullMode: true, sandboxed: false }),
      "default",
    );
    const otherProfile = adminTargetFromConnection(
      connection({ fullMode: false }),
      "work",
    );
    expect(targetKey(sandboxed)).not.toBe(targetKey(unrestricted));
    expect(targetKey(sandboxed)).not.toBe(targetKey(otherProfile));
  });

  it("a client only ever talks to ITS target — a write lands on the chosen runtime", async () => {
    // Two independent runtimes. A client built for the sandboxed target must
    // mutate ONLY the sandboxed server, never the unrestricted one.
    const sandboxedServer = new FakeHermesServer({
      token: "sbx",
      skills: [{ name: "x", enabled: false, source: "bundled" }],
    });
    const unrestrictedServer = new FakeHermesServer({
      token: "unr",
      skills: [{ name: "x", enabled: false, source: "bundled" }],
    });

    const sandboxedClient = createHermesAdminClient(
      adminTargetFromConnection(
        connectionForFake(sandboxedServer, { mode: "sandboxed" }),
      ),
      { fetch: sandboxedServer.fetch },
    );

    await sandboxedClient.skills.toggle("x", true);

    // Only the sandboxed server saw the write.
    expect(
      sandboxedServer.requestLog.some((e) => e.path === "/api/skills/toggle"),
    ).toBe(true);
    expect(unrestrictedServer.requestLog).toHaveLength(0);
  });
});

/**
 * STRUCTURAL REGRESSION GUARD. The whole point of the targeting design is that
 * no profile/mode-sensitive WRITE silently reaches for "the first connection".
 * The client is constructed from one explicit target and has no access to a
 * connection list, so this property is enforced by construction. This test
 * locks that in by scanning the client and transport source for the
 * implicit-first-connection access patterns (`connections[0]`,
 * `.connections.find(... )` inside the client, `status.connection` as a write
 * target). If a future change reintroduces an implicit selection INSIDE the
 * client/transport, this fails.
 */
describe("admin targeting — implicit-first-connection guard", () => {
  it("client.ts and transport.ts never read a connection list or status", () => {
    for (const src of [clientSource, transportSource]) {
      expect(src).not.toMatch(/connections\s*\[\s*0\s*\]/);
      expect(src).not.toMatch(/\.connections\b/);
      // The client must not import the bridge status type at all — it works
      // off a resolved target only.
      expect(src).not.toMatch(/HermesBridgeStatus/);
    }
  });
});
