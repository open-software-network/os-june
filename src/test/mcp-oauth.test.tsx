import { render, renderHook, screen, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  McpOauthController,
  oauthClientConfig,
  oauthStateFor,
  oauthStatusMeta,
  needsClientCredentials,
  parseMcpServer,
  safeAuthorizationUrl,
  safeOauthMessage,
  useMcpOauthController,
  usesOauth,
  type HermesMcpServerInfo,
  type McpOauthBridge,
  type McpOauthState,
  type McpServersEngine,
  type McpServersState,
} from "../lib/hermes-admin";
import { McpServersView } from "../components/settings/McpServersSection";
import { makeAdminHarness } from "./fixtures/hermes-admin-harness";
import { mcpOAuthAuthMissingScenario } from "./fixtures/hermes-admin-scenarios";

function serverFromWire(raw: Record<string, unknown>): HermesMcpServerInfo {
  const server = parseMcpServer(raw);
  if (!server) throw new Error("fixture did not parse");
  return server;
}

// ---------------------------------------------------------------------------
// Pure view logic: applicability, status classification, client credentials.
// ---------------------------------------------------------------------------

describe("mcp oauth — view logic", () => {
  it("treats an http-oauth transport as an OAuth server", () => {
    const server = serverFromWire({
      name: "linear",
      transport: "http-oauth",
      url: "https://mcp.linear.app/sse",
      auth_status: "unauthenticated",
    });
    expect(usesOauth(server)).toBe(true);
  });

  it("excludes stdio and plain no-auth http servers", () => {
    const stdio = serverFromWire({
      name: "sqlite",
      transport: "stdio",
      command: "mcp-server-sqlite",
    });
    const http = serverFromWire({
      name: "weather",
      transport: "http",
      url: "https://weather.example.com/mcp",
    });
    expect(usesOauth(stdio)).toBe(false);
    expect(usesOauth(http)).toBe(false);
  });

  it("classifies each token status to a state with no dashes in copy", () => {
    const cases: Array<[string, ReturnType<typeof oauthStateFor>]> = [
      ["authenticated", "connected"],
      ["unauthenticated", "needs-sign-in"],
      ["expired", "expired"],
    ];
    for (const [authStatus, expected] of cases) {
      const server = serverFromWire({
        name: "s",
        transport: "http-oauth",
        url: "https://x/mcp",
        auth_status: authStatus,
      });
      expect(oauthStateFor(server)).toBe(expected);
      const meta = oauthStatusMeta(oauthStateFor(server));
      expect(meta.label).not.toMatch(/[–—]/);
      expect(meta.blurb).not.toMatch(/[–—]/);
    }
  });

  it("shows the waiting state while a sign-in is in flight", () => {
    const server = serverFromWire({
      name: "linear",
      transport: "http-oauth",
      url: "https://mcp.linear.app/sse",
      auth_status: "unauthenticated",
    });
    expect(oauthStateFor(server, true)).toBe("signing-in");
    expect(oauthStatusMeta("signing-in").action).toBe("none");
  });

  it("flags a provider with no dynamic registration and no client id", () => {
    const server = serverFromWire({
      name: "custom",
      transport: "http-oauth",
      url: "https://api.example.com/mcp",
      auth_status: "unauthenticated",
      oauth: { dynamic_registration: false },
    });
    expect(needsClientCredentials(server)).toBe(true);
    expect(oauthStateFor(server)).toBe("needs-client-credentials");

    const withId = serverFromWire({
      name: "custom",
      transport: "http-oauth",
      url: "https://api.example.com/mcp",
      auth_status: "unauthenticated",
      oauth: { dynamic_registration: false, client_id: "abc123" },
    });
    expect(needsClientCredentials(withId)).toBe(false);
    expect(oauthStateFor(withId)).toBe("needs-sign-in");
  });

  it("reads client-credential presence without reading a secret value", () => {
    const server = serverFromWire({
      name: "custom",
      transport: "http-oauth",
      url: "https://api.example.com/mcp",
      oauth: {
        dynamic_registration: false,
        client_id: "client-abc",
        has_client_secret: true,
      },
    });
    const config = oauthClientConfig(server);
    expect(config).toEqual({
      required: true,
      hasClientId: true,
      hasClientSecret: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Redaction: the CLI message and authorization URL never leak a token.
// ---------------------------------------------------------------------------

describe("mcp oauth — redaction", () => {
  it("redacts a bearer token and token query from a login message", () => {
    const message =
      "Authorized. Authorization: Bearer sk-secret-token-value-1234";
    const safe = safeOauthMessage(message);
    expect(safe).toBeTruthy();
    expect(safe).not.toContain("sk-secret-token-value-1234");
    expect(safe).toMatch(/redacted/i);
  });

  it("redacts a token in an authorization URL but keeps the host", () => {
    const url = safeAuthorizationUrl(
      "https://auth.example.com/authorize?client_id=abc&token=super-secret-xyz",
    );
    expect(url).toBeTruthy();
    expect(url).not.toContain("super-secret-xyz");
    expect(url).toContain("auth.example.com");
  });

  it("rejects a non-http authorization URL", () => {
    expect(safeAuthorizationUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeAuthorizationUrl(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Controller: sign-in success / timeout / failure, verify + invalidate.
// ---------------------------------------------------------------------------

/** A bridge stub that resolves the next login with a canned result. */
function bridgeResolving(
  result: Partial<{
    ok: boolean;
    message: string | null;
    authUrl: string | null;
    timedOut: boolean;
  }>,
): McpOauthBridge {
  return vi.fn(async () => ({
    ok: result.ok ?? true,
    message: result.message ?? null,
    authUrl: result.authUrl ?? null,
    timedOut: result.timedOut ?? false,
  }));
}

describe("mcp oauth — controller", () => {
  it("signs in, re-tests the server, invalidates, and notifies", async () => {
    const harness = makeAdminHarness(mcpOAuthAuthMissingScenario());
    const testSpy = vi.spyOn(harness.client.mcp, "testServer");
    const controller = new McpOauthController(harness as McpServersEngine, {
      bridge: bridgeResolving({ ok: true, message: "Authorized linear." }),
    });

    await controller.signIn("linear");

    const login = controller.getSnapshot().logins.get("linear");
    expect(login?.phase).toBe("done");
    // It re-probed the server after the sign-in (the spec's "test after auth").
    expect(testSpy).toHaveBeenCalledWith("linear");
    // It invalidated the MCP servers inventory and advanced the restart banner.
    expect(harness.cache.isStale("mcpServers")).toBe(true);
    expect(harness.lifecycle.getSnapshot().state).toBe(
      "gateway-restart-required",
    );
    // It raised the durable "signed in, restart to expose tools" notification.
    const note = harness.cache.getNotifications().at(-1);
    expect(note?.mutation).toBe("mcp.oauthLogin");
    expect(note?.message).toMatch(/restart/i);

    controller.dispose();
  });

  it("leaves the row waiting (not failed) when the bridge times out", async () => {
    const harness = makeAdminHarness(mcpOAuthAuthMissingScenario());
    const testSpy = vi.spyOn(harness.client.mcp, "testServer");
    const controller = new McpOauthController(harness as McpServersEngine, {
      bridge: bridgeResolving({
        ok: false,
        timedOut: true,
        authUrl: "https://auth.linear.app/authorize?client_id=abc",
      }),
    });

    await controller.signIn("linear");

    const login = controller.getSnapshot().logins.get("linear");
    expect(login?.phase).toBe("waiting");
    expect(login?.error).toBeUndefined();
    // A timeout is the user's browser step to finish: no verify, no notification.
    expect(testSpy).not.toHaveBeenCalled();
    expect(login?.authUrl).toContain("auth.linear.app");

    controller.dispose();
  });

  it("surfaces a safe error when the bridge fails outright", async () => {
    const harness = makeAdminHarness(mcpOAuthAuthMissingScenario());
    const controller = new McpOauthController(harness as McpServersEngine, {
      bridge: vi.fn(async () => {
        throw new Error("could not run hermes mcp login");
      }),
    });

    await controller.signIn("linear");

    const login = controller.getSnapshot().logins.get("linear");
    expect(login?.phase).toBe("failed");
    expect(login?.error).toBeTruthy();

    controller.dispose();
  });

  it("never stores or surfaces a token returned by the bridge", async () => {
    const harness = makeAdminHarness(mcpOAuthAuthMissingScenario());
    const controller = new McpOauthController(harness as McpServersEngine, {
      bridge: bridgeResolving({
        ok: true,
        message: "Signed in. Bearer sk-LEAKED-TOKEN-abcdefghijklmnop",
        authUrl: "https://auth.linear.app/cb?token=LEAKED-URL-TOKEN-xyz",
      }),
    });

    await controller.signIn("linear");

    const blob = JSON.stringify(controller.getSnapshot().logins.get("linear"));
    expect(blob).not.toContain("sk-LEAKED-TOKEN-abcdefghijklmnop");
    expect(blob).not.toContain("LEAKED-URL-TOKEN-xyz");

    controller.dispose();
  });

  it("does not re-enter a sign-in already in flight", async () => {
    const harness = makeAdminHarness(mcpOAuthAuthMissingScenario());
    let resolve: (() => void) | undefined;
    const bridge = vi.fn(
      () =>
        new Promise<{
          ok: boolean;
          message: string | null;
          authUrl: string | null;
          timedOut: boolean;
        }>((res) => {
          resolve = () =>
            res({ ok: true, message: null, authUrl: null, timedOut: false });
        }),
    );
    const controller = new McpOauthController(harness as McpServersEngine, {
      bridge: bridge as unknown as McpOauthBridge,
    });

    void controller.signIn("linear");
    void controller.signIn("linear"); // ignored while in flight
    expect(bridge).toHaveBeenCalledTimes(1);
    resolve?.();
    await Promise.resolve();

    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// Hook + component wiring.
// ---------------------------------------------------------------------------

describe("mcp oauth — useMcpOauthController", () => {
  it("returns the empty state for a null engine", () => {
    const { result } = renderHook(() => useMcpOauthController(null));
    expect(result.current.logins.size).toBe(0);
    expect(result.current.busy).toBe(false);
  });
});

/** A minimal servers state carrying one OAuth server, for the view test. */
function oauthServersState(): McpServersState {
  const server = serverFromWire({
    name: "linear",
    enabled: true,
    transport: "http-oauth",
    url: "https://mcp.linear.app/sse",
    auth_status: "unauthenticated",
    status: "error",
  });
  return {
    status: "ready",
    servers: [server],
    pending: new Set(),
    tests: new Map(),
    adding: false,
    retryable: false,
    lifecycle: {
      state: "clean",
      label: "Up to date",
      detail: "No pending changes.",
      canRestart: false,
    },
    notifications: [],
    refresh: () => {},
    setEnabled: () => {},
    test: () => Promise.resolve({ pending: false }),
    add: () => Promise.resolve(false),
    remove: () => Promise.resolve(false),
    dismissNotification: () => {},
  } as McpServersState;
}

describe("mcp oauth — McpServersView", () => {
  it("renders the sign-in action and routes a click to the oauth controller", async () => {
    const signIn = vi.fn();
    const oauth: McpOauthState = {
      logins: new Map(),
      signIn,
      clear: () => {},
      busy: false,
    };
    render(<McpServersView state={oauthServersState()} oauth={oauth} />);

    const button = await screen.findByRole("button", { name: "Sign in" });
    await act(async () => {
      button.click();
    });
    expect(signIn).toHaveBeenCalledWith("linear");
  });

  it("shows the waiting state and a manual sign-in link while signing in", () => {
    const oauth: McpOauthState = {
      logins: new Map([
        [
          "linear",
          {
            server: "linear",
            phase: "waiting",
            authUrl: "https://auth.linear.app/authorize",
          },
        ],
      ]),
      signIn: () => {},
      clear: () => {},
      busy: false,
    };
    render(<McpServersView state={oauthServersState()} oauth={oauth} />);
    expect(screen.getByText(/Waiting for browser/i)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Open the sign-in page/i });
    expect(link).toHaveAttribute("href", "https://auth.linear.app/authorize");
  });
});
