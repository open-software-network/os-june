import { describe, expect, it, vi } from "vitest";
import {
  createHermesAdminClient,
  createRustAdminFetch,
  HERMES_ADMIN_REQUEST_COMMAND,
  type HermesAdminTarget,
} from "../lib/hermes-admin";

/** A target whose baseUrl/token the Rust transport must IGNORE (Rust resolves
 * them from the bridge connection). The mode is the only routing input. */
function target(mode: "sandboxed" | "unrestricted"): HermesAdminTarget {
  return {
    baseUrl: "http://127.0.0.1:54321",
    token: "should-not-be-used",
    mode,
    fullMode: mode === "unrestricted",
    sandboxed: mode === "sandboxed",
    hermesHome: "/tmp/hermes",
    profile: "default",
  };
}

describe("createRustAdminFetch — routes through invoke, not webview fetch", () => {
  it("invokes hermes_admin_request with the explicit mode, method, path+query, and body", async () => {
    const invoke = vi.fn().mockResolvedValue([{ name: "git", enabled: true }]);
    const client = createHermesAdminClient(target("sandboxed"), {
      fetch: createRustAdminFetch("sandboxed", invoke),
    });

    const skills = await client.skills.list();

    expect(invoke).toHaveBeenCalledTimes(1);
    const [command, args] = invoke.mock.calls[0];
    expect(command).toBe(HERMES_ADMIN_REQUEST_COMMAND);
    expect(args).toMatchObject({
      mode: "sandboxed",
      method: "GET",
      // The transport adds ?profile=default centrally; only path+query is sent
      // (no origin/baseUrl), since Rust resolves the base from the connection.
      path: "/api/skills?profile=default",
    });
    expect(args.body).toBeUndefined();
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: "git", enabled: true });
  });

  it("forwards the chosen runtime mode (unrestricted) so Rust does not pick the first connection", async () => {
    const invoke = vi.fn().mockResolvedValue([]);
    const client = createHermesAdminClient(target("unrestricted"), {
      fetch: createRustAdminFetch("unrestricted", invoke),
    });

    await client.skills.list();

    expect(invoke.mock.calls[0][1]).toMatchObject({ mode: "unrestricted" });
  });

  it("parses the JSON-string body the transport produces back into a value", async () => {
    const invoke = vi.fn().mockResolvedValue({
      object: "skill.toggle",
      name: "git",
      enabled: false,
    });
    const client = createHermesAdminClient(target("sandboxed"), {
      fetch: createRustAdminFetch("sandboxed", invoke),
    });

    await client.skills.toggle("git", false);

    const args = invoke.mock.calls[0][1];
    expect(args.method).toBe("PUT");
    expect(args.path).toBe("/api/skills/toggle?profile=default");
    // The transport JSON.stringifies the body; the adapter parses it back so
    // Rust receives a real JSON object, not a string.
    expect(args.body).toEqual({ name: "git", enabled: false });
  });

  it("does NOT touch globalThis.fetch", async () => {
    const invoke = vi.fn().mockResolvedValue([]);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = createHermesAdminClient(target("sandboxed"), {
      fetch: createRustAdminFetch("sandboxed", invoke),
    });

    await client.skills.list();

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("surfaces a rejected invoke as a thrown error (transport normalizes to a network error)", async () => {
    const invoke = vi
      .fn()
      .mockRejectedValue(new Error("Hermes bridge is not running."));
    const client = createHermesAdminClient(target("sandboxed"), {
      fetch: createRustAdminFetch("sandboxed", invoke),
    });

    await expect(client.skills.list()).rejects.toThrow();
  });

  it("surfaces a non-2xx Hermes response as an HTTP error with its real status, not a network error", async () => {
    // The Rust proxy turns a non-2xx into `Hermes API returned <status>: <body>`.
    // The adapter must report that as an HTTP error carrying the real status, so
    // the UI shows the actual problem instead of the misleading "Could not reach
    // Hermes" that a network-kind error renders.
    const invoke = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'Hermes API returned 422 Unprocessable Entity: {"detail":"bad env"}',
        ),
      );
    const client = createHermesAdminClient(target("sandboxed"), {
      fetch: createRustAdminFetch("sandboxed", invoke),
    });

    const error = await client.skills.list().then(
      () => null,
      (e: { kind?: string; status?: number }) => e,
    );
    expect(error?.kind).toBe("http");
    expect(error?.status).toBe(422);
  });
});
