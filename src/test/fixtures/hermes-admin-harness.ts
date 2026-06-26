/**
 * Test harness that wires a {@link FakeHermesServer} to a real
 * {@link createHermesAdminClient}. Test infrastructure — not a test. Keeps the
 * boilerplate (build a target from the fake's base/token, inject the fake's
 * fetch, optionally capture redacted logs) in one place so each suite is just
 * arrange/act/assert.
 */

import {
  AdminStateCache,
  GatewayLifecycle,
  adminTargetFromConnection,
  createHermesAdminClient,
  type HermesAdminClient,
  type HermesAdminMode,
  type HermesAdminTarget,
} from "../../lib/hermes-admin";
import type { HermesBridgeConnection } from "../../lib/tauri";
import {
  FakeHermesServer,
  type FakeHermesScenario,
} from "./fake-hermes-server";

/** Builds a bridge-shaped connection pointing at a fake server, in a chosen
 * mode/profile, so targeting logic is exercised with realistic inputs. */
export function connectionForFake(
  server: FakeHermesServer,
  options: { mode?: HermesAdminMode; profile?: string } = {},
): HermesBridgeConnection {
  const fullMode = options.mode === "unrestricted";
  return {
    baseUrl: server.baseUrl,
    wsUrl: `${server.baseUrl.replace("http", "ws")}/api/ws`,
    token: server.token,
    port: 65535,
    command: "hermes",
    hermesHome: "/tmp/fake-hermes-home",
    cwd: null,
    providerProxyPort: 1,
    pid: 1234,
    sandboxed: !fullMode,
    fullMode,
  };
}

/** A target aimed at a fake server. */
export function targetForFake(
  server: FakeHermesServer,
  options: { mode?: HermesAdminMode; profile?: string } = {},
): HermesAdminTarget {
  return adminTargetFromConnection(
    connectionForFake(server, options),
    options.profile,
  );
}

export type AdminHarness = {
  server: FakeHermesServer;
  target: HermesAdminTarget;
  client: HermesAdminClient;
  cache: AdminStateCache;
  lifecycle: GatewayLifecycle;
  /** Redacted log records the transport emitted, for redaction assertions. */
  logs: Array<Record<string, unknown>>;
};

/** Stands up a fake server + admin client + cache + lifecycle for a scenario. */
export function makeAdminHarness(
  scenario: FakeHermesScenario = {},
  options: { mode?: HermesAdminMode; profile?: string } = {},
): AdminHarness {
  const server = new FakeHermesServer(scenario);
  const target = targetForFake(server, options);
  const logs: Array<Record<string, unknown>> = [];
  const client = createHermesAdminClient(target, {
    fetch: server.fetch,
    logger: (record) => logs.push(record),
  });
  const cache = new AdminStateCache(target);
  const lifecycle = new GatewayLifecycle(client, cache);
  return { server, target, client, cache, lifecycle, logs };
}

/** A `sleep` stub that resolves immediately so poll loops run without real
 * timers in tests. */
export const instantSleep = (): Promise<void> => Promise.resolve();
