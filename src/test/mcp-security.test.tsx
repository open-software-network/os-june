import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ALLOWLIST_RECOMMENDATION,
  DEFAULT_MCP_EXPOSURE_POLICY,
  LOCAL_FILE_TOOLS_WARNING,
  McpSecurityController,
  classifyEntryRisk,
  classifyServerRisk,
  destructiveToolsFor,
  enableConfirmationFor,
  exposurePolicyMeta,
  exposurePolicyOptions,
  installConfirmationFor,
  isDestructiveToolName,
  isSecretBacked,
  normalizeExposurePolicy,
  parseMcpCatalogEntry,
  parseMcpServer,
  readExposurePolicy,
  securityLabel,
  securityLabelsFor,
  securityLabelsForEntry,
  type HermesMcpCatalogEntry,
  type HermesMcpServerInfo,
  type McpSecurityState,
} from "../lib/hermes-admin";
import { McpSecurityView } from "../components/settings/McpSecuritySection";
import { McpServersView } from "../components/settings/McpServersSection";
import { McpCatalogView } from "../components/settings/McpCatalogSection";
import { makeAdminHarness } from "./fixtures/hermes-admin-harness";

/** Builds a HermesMcpServerInfo from a wire-shaped object. */
function serverFromWire(raw: Record<string, unknown>): HermesMcpServerInfo {
  const server = parseMcpServer(raw);
  if (!server) throw new Error("fixture did not parse");
  return server;
}

/** Builds a HermesMcpCatalogEntry from a wire-shaped object. */
function entryFromWire(raw: Record<string, unknown>): HermesMcpCatalogEntry {
  const entry = parseMcpCatalogEntry(raw);
  if (!entry) throw new Error("fixture did not parse");
  return entry;
}

const NO_DASH = /[–—]/;

// ---------------------------------------------------------------------------
// Security labels: classify stdio / HTTP / OAuth / secret-backed correctly.
// ---------------------------------------------------------------------------

describe("mcp security — labels", () => {
  it("labels a local stdio server as local subprocess + both sandbox boundaries", () => {
    const server = serverFromWire({
      name: "files",
      transport: "stdio",
      command: "mcp-server-filesystem",
    });
    const codes = securityLabelsFor(server).map((label) => label.code);
    expect(codes).toContain("local-subprocess");
    expect(codes).toContain("sandbox-constrained");
    expect(codes).toContain("unrestricted-capable");
    expect(codes).not.toContain("remote-server");
  });

  it("labels a plain HTTP server as a remote server, not local", () => {
    const server = serverFromWire({
      name: "weather",
      transport: "http",
      url: "https://example.com/mcp",
    });
    const codes = securityLabelsFor(server).map((label) => label.code);
    expect(codes).toContain("remote-server");
    expect(codes).not.toContain("local-subprocess");
    expect(codes).not.toContain("sandbox-constrained");
  });

  it("adds the OAuth label for an OAuth HTTP server", () => {
    const server = serverFromWire({
      name: "linear",
      transport: "http-oauth",
      url: "https://mcp.linear.app",
      auth_status: "authenticated",
    });
    const codes = securityLabelsFor(server).map((label) => label.code);
    expect(codes).toContain("remote-server");
    expect(codes).toContain("oauth");
  });

  it("flags a secret-backed server when env or header keys are configured", () => {
    const withEnv = serverFromWire({
      name: "db",
      transport: "stdio",
      command: "mcp-server-postgres",
      env: { DATABASE_URL: "postgres://secret" },
    });
    expect(isSecretBacked(withEnv)).toBe(true);
    expect(securityLabelsFor(withEnv).map((l) => l.code)).toContain(
      "secret-backed",
    );

    const noSecret = serverFromWire({
      name: "weather",
      transport: "http",
      url: "https://example.com/mcp",
    });
    expect(isSecretBacked(noSecret)).toBe(false);
    expect(securityLabelsFor(noSecret).map((l) => l.code)).not.toContain(
      "secret-backed",
    );
  });

  it("never reveals a secret value in the labels or their blurbs", () => {
    const server = serverFromWire({
      name: "db",
      transport: "stdio",
      command: "mcp-server-postgres",
      env: { DATABASE_URL: "postgres://super-secret-value" },
    });
    const serialized = JSON.stringify(securityLabelsFor(server));
    expect(serialized).not.toContain("super-secret-value");
  });

  it("labels a catalog entry by its declared transport and required env", () => {
    const local = entryFromWire({
      name: "filesystem",
      transport: "stdio",
      required_env: [{ key: "ROOT" }],
    });
    const codes = securityLabelsForEntry(local).map((l) => l.code);
    expect(codes).toContain("local-subprocess");
    expect(codes).toContain("secret-backed");

    const remote = entryFromWire({ name: "weather", transport: "http" });
    expect(securityLabelsForEntry(remote).map((l) => l.code)).toEqual([
      "remote-server",
    ]);
  });

  it("uses sentence case and no dashes in every label and blurb", () => {
    for (const code of [
      "local-subprocess",
      "remote-server",
      "oauth",
      "secret-backed",
      "sandbox-constrained",
      "unrestricted-capable",
    ] as const) {
      const meta = securityLabel(code);
      expect(meta.label).not.toMatch(NO_DASH);
      expect(meta.blurb).not.toMatch(NO_DASH);
      // Sentence case: not ALL CAPS.
      expect(meta.label).not.toBe(meta.label.toUpperCase());
    }
  });
});

// ---------------------------------------------------------------------------
// Risk classification: heuristics are WARNINGS, not silent blocks.
// ---------------------------------------------------------------------------

describe("mcp security — risk heuristics", () => {
  it("flags a filesystem server as high risk and requires confirmation", () => {
    const server = serverFromWire({
      name: "filesystem",
      transport: "stdio",
      command: "mcp-server-filesystem",
    });
    const risk = classifyServerRisk(server);
    expect(risk.tier).toBe("high");
    expect(risk.requiresConfirmation).toBe(true);
    expect(risk.reasons.some((r) => r.code === "filesystem")).toBe(true);
  });

  it("flags shell, browser, database, and cloud-admin categories", () => {
    const cases: Array<[string, string, string]> = [
      ["shell", "mcp-server-shell", "shell"],
      ["browser", "mcp-puppeteer", "browser"],
      ["pg", "mcp-server-postgres", "database"],
      ["aws", "mcp-aws-admin", "cloud-admin"],
    ];
    for (const [name, command, code] of cases) {
      const server = serverFromWire({ name, transport: "stdio", command });
      const risk = classifyServerRisk(server);
      expect(risk.requiresConfirmation).toBe(true);
      expect(risk.reasons.some((r) => r.code === code)).toBe(true);
    }
  });

  it("treats a destructive tool NAME as a warning, never a block", () => {
    expect(isDestructiveToolName("delete_workspace")).toBe(true);
    expect(isDestructiveToolName("dropTable")).toBe(true);
    expect(isDestructiveToolName("rm_file")).toBe(true);
    // Recoveries are not destructive.
    expect(isDestructiveToolName("undelete")).toBe(false);
    expect(isDestructiveToolName("list_items")).toBe(false);

    const server = serverFromWire({
      name: "linear",
      transport: "http",
      url: "https://mcp.linear.app",
      tools: [{ name: "list_issues" }, { name: "delete_workspace" }],
    });
    expect(destructiveToolsFor(server)).toEqual(["delete_workspace"]);
    const risk = classifyServerRisk(server);
    // It is flagged (a warning) but the server is NOT removed or disabled —
    // the assessment only ranks and explains.
    expect(risk.requiresConfirmation).toBe(true);
    expect(risk.destructiveTools).toEqual(["delete_workspace"]);
    expect(risk.reasons.some((r) => r.code === "destructive-tool")).toBe(true);
  });

  it("rates a plain remote server as standard (no confirmation)", () => {
    const server = serverFromWire({
      name: "weather",
      transport: "http",
      url: "https://example.com/mcp",
    });
    const risk = classifyServerRisk(server);
    expect(risk.tier).toBe("standard");
    expect(risk.requiresConfirmation).toBe(false);
  });

  it("rates a benign local subprocess as elevated, gated only at high", () => {
    const server = serverFromWire({
      name: "notes",
      transport: "stdio",
      command: "mcp-notes",
    });
    const risk = classifyServerRisk(server);
    expect(risk.tier).toBe("elevated");
    expect(risk.requiresConfirmation).toBe(false);
    // It still carries the local-write boundary note so it is never silent.
    expect(risk.reasons.some((r) => r.code === "local-write")).toBe(true);
  });

  it("classifies a catalog entry the same way for the install gate", () => {
    const entry = entryFromWire({
      name: "filesystem",
      transport: "stdio",
      default_tools: ["read_file", "delete_file"],
    });
    const risk = classifyEntryRisk(entry);
    expect(risk.requiresConfirmation).toBe(true);
    expect(risk.destructiveTools).toEqual(["delete_file"]);
  });

  it("uses the exact spec warning copy and no dashes", () => {
    expect(LOCAL_FILE_TOOLS_WARNING).toBe(
      "This MCP server runs local code and exposes file tools. In unrestricted sessions it may modify files your user account can modify.",
    );
    const server = serverFromWire({
      name: "files",
      transport: "stdio",
      command: "mcp-server-filesystem",
    });
    const confirmation = enableConfirmationFor(server);
    expect(confirmation.lead).toBe(LOCAL_FILE_TOOLS_WARNING);
    expect(confirmation.title).not.toMatch(NO_DASH);
    expect(ALLOWLIST_RECOMMENDATION).not.toMatch(NO_DASH);
    for (const reason of confirmation.reasons) {
      expect(reason).not.toMatch(NO_DASH);
    }
  });
});

// ---------------------------------------------------------------------------
// Exposure policy: conservative default, normalization, config read.
// ---------------------------------------------------------------------------

describe("mcp security — exposure policy", () => {
  it("defaults to the conservative install-disabled policy", () => {
    expect(DEFAULT_MCP_EXPOSURE_POLICY).toBe("install-disabled");
    expect(exposurePolicyMeta("install-disabled").recommended).toBe(true);
    expect(exposurePolicyMeta("enable-all").recommended).toBe(false);
    // The recommended option is listed first.
    expect(exposurePolicyOptions()[0].policy).toBe("install-disabled");
  });

  it("normalizes junk and aliases to a known policy, defaulting safely", () => {
    expect(normalizeExposurePolicy("enable_all")).toBe("enable-all");
    expect(normalizeExposurePolicy("enable-with-safe-allowlist")).toBe(
      "enable-with-allowlist",
    );
    expect(normalizeExposurePolicy("install-disabled-by-default")).toBe(
      "install-disabled",
    );
    expect(normalizeExposurePolicy(undefined)).toBe("install-disabled");
    expect(normalizeExposurePolicy("nonsense")).toBe("install-disabled");
  });

  it("reads the policy out of a config tree, defaulting when absent", () => {
    expect(readExposurePolicy({})).toBe("install-disabled");
    expect(readExposurePolicy({ mcp: { exposure_policy: "enable-all" } })).toBe(
      "enable-all",
    );
    // A malformed mcp node degrades to the default.
    expect(readExposurePolicy({ mcp: "oops" })).toBe("install-disabled");
  });

  it("round-trips the policy through the config REST surface", async () => {
    const harness = makeAdminHarness({
      config: { mcp: { exposure_policy: "enable-all" } },
    });
    const controller = new McpSecurityController({
      target: harness.target,
      client: harness.client,
      cache: harness.cache,
      lifecycle: harness.lifecycle,
    });
    await controller.load();
    expect(controller.getSnapshot().policy).toBe("enable-all");

    await controller.setPolicy("install-disabled");
    expect(controller.getSnapshot().policy).toBe("install-disabled");
    // The write landed in the fake server's config tree.
    const config = await harness.client.config.get();
    expect(readExposurePolicy(config.config)).toBe("install-disabled");
    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// Component wiring: confirmation gates + the policy setting page.
// ---------------------------------------------------------------------------

const BASE_LIFECYCLE = {
  state: "clean" as const,
  label: "Up to date",
  detail: "No pending changes.",
  canRestart: false,
};

function securityState(
  overrides: Partial<McpSecurityState> = {},
): McpSecurityState {
  return {
    status: "ready",
    policy: "install-disabled",
    mode: "sandboxed",
    profile: "default",
    busy: false,
    retryable: false,
    lifecycle: BASE_LIFECYCLE,
    notifications: [],
    refresh: vi.fn(),
    setPolicy: vi.fn(),
    dismissNotification: vi.fn(),
    ...overrides,
  };
}

describe("McpSecurityView — component", () => {
  it("renders the three exposure policy options with the default selected", () => {
    render(<McpSecurityView state={securityState()} />);
    const group = screen.getByRole("radiogroup", {
      name: "Default MCP exposure policy",
    });
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(3);
    const selected = radios.find(
      (radio) => radio.getAttribute("aria-checked") === "true",
    );
    expect(selected).toHaveAttribute("data-policy", "install-disabled");
  });

  it("calls setPolicy when a different option is chosen", () => {
    const setPolicy = vi.fn();
    render(<McpSecurityView state={securityState({ setPolicy })} />);
    fireEvent.click(screen.getByRole("radio", { name: /Enable all tools/ }));
    expect(setPolicy).toHaveBeenCalledWith("enable-all");
  });

  it("explains every security label in the legend", () => {
    render(<McpSecurityView state={securityState()} />);
    for (const text of [
      "Local subprocess",
      "Remote server",
      "OAuth",
      "Secret-backed",
      "Sandbox constrained",
      "Unrestricted capable",
    ]) {
      expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    }
  });
});

const SERVERS_LIFECYCLE = BASE_LIFECYCLE;

function serversState(servers: HermesMcpServerInfo[], setEnabled = vi.fn()) {
  return {
    status: "ready" as const,
    servers,
    mode: "sandboxed" as const,
    profile: "default",
    pending: new Set<string>(),
    tests: new Map(),
    adding: false,
    retryable: false,
    lifecycle: SERVERS_LIFECYCLE,
    notifications: [],
    refresh: vi.fn(),
    setEnabled,
    test: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
    dismissNotification: vi.fn(),
  };
}

describe("McpServersView — high-risk enable gate", () => {
  it("confirms before enabling a high-risk (filesystem) server", async () => {
    const setEnabled = vi.fn();
    const server = serverFromWire({
      name: "filesystem",
      transport: "stdio",
      command: "mcp-server-filesystem",
      enabled: false,
    });
    render(<McpServersView state={serversState([server], setEnabled)} />);

    // Flipping the toggle on does NOT immediately enable; it opens a confirm.
    fireEvent.click(screen.getByRole("switch"));
    expect(setEnabled).not.toHaveBeenCalled();

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(LOCAL_FILE_TOOLS_WARNING),
    ).toBeInTheDocument();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Enable server" }),
    );
    await waitFor(() =>
      expect(setEnabled).toHaveBeenCalledWith("filesystem", true),
    );
  });

  it("enables a standard-risk server without a confirmation", () => {
    const setEnabled = vi.fn();
    const server = serverFromWire({
      name: "weather",
      transport: "http",
      url: "https://example.com/mcp",
      enabled: false,
    });
    render(<McpServersView state={serversState([server], setEnabled)} />);
    fireEvent.click(screen.getByRole("switch"));
    expect(setEnabled).toHaveBeenCalledWith("weather", true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("disabling a high-risk server is never gated", () => {
    const setEnabled = vi.fn();
    const server = serverFromWire({
      name: "filesystem",
      transport: "stdio",
      command: "mcp-server-filesystem",
      enabled: true,
    });
    render(<McpServersView state={serversState([server], setEnabled)} />);
    fireEvent.click(screen.getByRole("switch"));
    expect(setEnabled).toHaveBeenCalledWith("filesystem", false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
