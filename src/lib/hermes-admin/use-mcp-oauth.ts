/**
 * The OAuth login controller behind June's MCP servers page (spec 17). It owns
 * the per-server sign-in lifecycle for OAuth-authenticated HTTP MCP servers,
 * layered on TOP of the MCP servers engine (spec 14) so it shares the SAME
 * foundation primitives:
 *
 * - the Tauri `hermes_mcp_oauth_login` bridge (injectable) runs the browser
 *   sign-in. There is no MCP-OAuth REST endpoint in Hermes v2026.6.19 (the
 *   `/api/providers/oauth/*` endpoints are for LLM providers, not MCP servers),
 *   so per the spec this is the narrowest possible bridge command;
 * - the {@link HermesAdminClient} `mcp.testServer()` re-probes the server AFTER a
 *   sign-in so the row reflects the new token status, exactly as the spec's
 *   "test the server after auth" requires;
 * - the {@link AdminStateCache} invalidates `mcpServers` + `toolsets` and raises
 *   the durable "signed in, restart to expose tools" notification;
 * - the {@link GatewayLifecycle} advances the shared restart banner (a freshly
 *   authenticated OAuth server's tools load at gateway start).
 *
 * Secret hygiene: this controller NEVER receives or stores a token. The bridge
 * returns only `{ ok, message, authUrl, timedOut }`, already redacted in Rust;
 * this layer re-runs the message/URL through the view-layer redactors before
 * surfacing them, and stores nothing token-shaped. The browser sign-in is the
 * user's to finish: a `timedOut` result is NOT a failure, it leaves the row in
 * the waiting state and lets the user re-check.
 *
 * Framework-free so the login/verify/refresh rules are unit-testable against the
 * fake Hermes server with an injected bridge, no rendering and no Tauri runtime.
 */

import { useEffect, useMemo, useState } from "react";
import { hermesMcpOauthLogin, type HermesMcpOauthLoginResult } from "../tauri";
import { HermesAdminError } from "./errors";
import {
  OAUTH_GENERIC_MESSAGE,
  safeAuthorizationUrl,
  safeOauthMessage,
} from "./mcp-oauth-view";
import type { McpServersEngine } from "./use-mcp-servers";

/** A bridge that runs the OAuth sign-in for one server. The production binding
 * is {@link hermesMcpOauthLogin}; tests inject a stub so no Tauri runtime is
 * needed. */
export type McpOauthBridge = (input: {
  mode: "sandboxed" | "unrestricted";
  server: string;
  profile?: string;
}) => Promise<HermesMcpOauthLoginResult>;

/** The phase of a per-server sign-in. `idle` is the default; `signing-in` is the
 * browser handoff in flight; `done` / `failed` are terminal until the next
 * attempt. `waiting` means the bridge timed out before the CLI confirmed (the
 * browser step is still the user's to finish), so the row stays in a non-error
 * "still waiting" state. */
export type McpOauthPhase =
  | "idle"
  | "signing-in"
  | "waiting"
  | "done"
  | "failed";

/** The live sign-in state for one server, keyed by server name. */
export type McpOauthLoginState = {
  server: string;
  phase: McpOauthPhase;
  /** A safe, redacted status message, when present. Never a token. */
  message?: string;
  /** The token-free authorization URL, when the bridge surfaced one, so the UI
   * can offer a manual "open in browser" fallback. */
  authUrl?: string;
  /** A safe error message when `phase === "failed"`. */
  error?: string;
};

/** Everything the OAuth slice of the MCP servers page renders, plus the action
 * it invokes. */
export type McpOauthState = {
  /** Per-server login state, keyed by server name. */
  logins: ReadonlyMap<string, McpOauthLoginState>;
  /** Starts (or restarts) the browser sign-in for a server. After the bridge
   * resolves successfully, re-probes the server, invalidates the inventory, and
   * advances the restart banner. Safe to call for a re-auth. */
  signIn: (server: string) => void;
  /** True while ANY server's sign-in is in flight (browser handoff). */
  busy: boolean;
  /** Clears a terminal (done/failed/waiting) login state for a server. */
  clear: (server: string) => void;
};

/** Test-only knobs. Production constructs the controller with no options and the
 * production bridge. */
export type McpOauthControllerOptions = {
  bridge?: McpOauthBridge;
};

/**
 * The framework-free controller the hook wraps. Tracks the per-server sign-in
 * state for one engine and notifies a single subscriber (the hook) on change.
 */
export class McpOauthController {
  private readonly engine: McpServersEngine;
  private readonly bridge: McpOauthBridge;
  private readonly logins = new Map<string, McpOauthLoginState>();
  private listeners = new Set<() => void>();
  private disposed = false;
  private snapshot: McpOauthState;

  constructor(
    engine: McpServersEngine,
    options: McpOauthControllerOptions = {},
  ) {
    this.engine = engine;
    this.bridge = options.bridge ?? hermesMcpOauthLogin;
    this.snapshot = this.buildSnapshot();
  }

  getSnapshot(): McpOauthState {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  /**
   * Runs the browser sign-in for a server, then verifies it. Sequence:
   * 1. mark the row `signing-in` (the UI shows the waiting state);
   * 2. run the bridge — it opens the browser and waits (bounded). The browser
   *    step is the user's; a timeout is `waiting`, not a failure;
   * 3. on a confirmed sign-in, re-probe via `mcp.testServer` so the row reflects
   *    the new token status, then invalidate `mcpServers` + `toolsets`, raise the
   *    "signed in" notification, and advance the restart banner;
   * 4. surface a safe error inline on any bridge/transport failure.
   * Never throws; never stores a token.
   */
  async signIn(server: string): Promise<void> {
    if (this.logins.get(server)?.phase === "signing-in") return;
    this.setLogin(server, { phase: "signing-in" });

    let result: HermesMcpOauthLoginResult;
    try {
      result = await this.bridge({
        mode: this.engine.target.mode,
        server,
        profile: this.engine.target.profile,
      });
    } catch (error) {
      if (this.disposed) return;
      const adminError = HermesAdminError.from("hermes mcp login", error);
      this.setLogin(server, { phase: "failed", error: adminError.safeMessage });
      return;
    }
    if (this.disposed) return;

    // Re-run the bridge's (already Rust-redacted) message/URL through the view
    // redactors as defense in depth before anything reaches the screen.
    const message = safeOauthMessage(result.message ?? undefined);
    const authUrl = safeAuthorizationUrl(result.authUrl ?? undefined);

    if (!result.ok) {
      // A timeout is NOT a failure: the user may still be completing the browser
      // step. Leave the row waiting with the URL so they can re-open / re-check.
      if (result.timedOut) {
        this.setLogin(server, { phase: "waiting", message, authUrl });
        return;
      }
      this.setLogin(server, {
        phase: "failed",
        error: message ?? `Could not sign in to ${server}.`,
        authUrl,
      });
      return;
    }

    // Confirmed sign-in: verify the server, then reconcile the inventory.
    await this.verifyAndReconcile(server);
    if (this.disposed) return;
    this.setLogin(server, {
      phase: "done",
      message: message ?? OAUTH_GENERIC_MESSAGE,
      authUrl,
    });
  }

  clear(server: string): void {
    if (this.logins.delete(server)) this.recompute();
  }

  /** Re-probes the server (so its token status updates) and applies the cache
   * invalidation + durable notification + restart banner for the sign-in. A
   * failed probe is non-fatal here: the sign-in itself succeeded; the probe
   * result is surfaced through the server row's own test state. */
  private async verifyAndReconcile(server: string): Promise<void> {
    try {
      await this.engine.client.mcp.testServer(server);
    } catch {
      // Ignore: the sign-in succeeded; a probe failure is reflected elsewhere.
    }
    if (this.disposed) return;
    this.engine.cache.afterMutation("mcp.oauthLogin", server);
    this.engine.lifecycle.noteMutation("mcp.oauthLogin");
  }

  private setLogin(
    server: string,
    next: Omit<McpOauthLoginState, "server">,
  ): void {
    this.logins.set(server, { server, ...next });
    this.recompute();
  }

  private buildSnapshot(): McpOauthState {
    let busy = false;
    for (const login of this.logins.values()) {
      if (login.phase === "signing-in") busy = true;
    }
    return {
      logins: new Map(this.logins),
      signIn: this.signInAction,
      clear: this.clearAction,
      busy,
    };
  }

  private recompute(): void {
    if (this.disposed) return;
    this.snapshot = this.buildSnapshot();
    for (const listener of [...this.listeners]) listener();
  }

  private readonly signInAction = (server: string): void => {
    void this.signIn(server);
  };
  private readonly clearAction = (server: string): void => {
    this.clear(server);
  };
}

/**
 * Binds an {@link McpOauthController} to React for one engine. A null engine
 * yields the empty state without constructing a controller.
 */
export function useMcpOauthController(
  engine: McpServersEngine | null,
  options: McpOauthControllerOptions = {},
): McpOauthState {
  // Options are stable per engine in production (none are passed); tests pass a
  // bridge once. Keyed on the engine so a new engine rebuilds the controller.
  const controller = useMemo(
    () => (engine ? new McpOauthController(engine, options) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by engine
    [engine],
  );

  const [snapshot, setSnapshot] = useState<McpOauthState>(() =>
    controller ? controller.getSnapshot() : EMPTY_STATE,
  );

  useEffect(() => {
    if (!controller) {
      setSnapshot(EMPTY_STATE);
      return;
    }
    setSnapshot(controller.getSnapshot());
    const unsubscribe = controller.subscribe(() => {
      setSnapshot(controller.getSnapshot());
    });
    return () => {
      unsubscribe();
      controller.dispose();
    };
  }, [controller]);

  return snapshot;
}

/** The frozen state shown when there is no runtime to talk to. */
const EMPTY_STATE: McpOauthState = Object.freeze({
  logins: new Map<string, McpOauthLoginState>(),
  signIn: () => {},
  clear: () => {},
  busy: false,
}) as McpOauthState;
