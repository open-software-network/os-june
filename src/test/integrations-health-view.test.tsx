import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  buildIntegrationsHealth,
  buildIntegrationsHealthReport,
  healthStatusLabel,
  integrationsHealthReportFilename,
  serializeIntegrationsHealthReport,
  setupBadge,
  parseMcpServer,
  type ExternalDirRow,
  type GatewayLifecycleSnapshot,
  type HealthIssueCode,
  type HermesMcpServerInfo,
  type HermesToolsetInfo,
  type IntegrationsHealthInputs,
  type SkillHealthInput,
} from "../lib/hermes-admin";
import { IntegrationsHealthView } from "../components/settings/IntegrationsHealthSection";

// ---------------------------------------------------------------------------
// Builders for crafted inputs.
// ---------------------------------------------------------------------------

const CLEAN_LIFECYCLE: GatewayLifecycleSnapshot = {
  state: "clean",
  label: "Up to date",
  detail: "No pending changes.",
  canRestart: false,
};

const RESTART_LIFECYCLE: GatewayLifecycleSnapshot = {
  state: "gateway-restart-required",
  label: "Restart required",
  detail: "Restart the Hermes gateway to apply your changes.",
  canRestart: true,
};

const FAILED_LIFECYCLE: GatewayLifecycleSnapshot = {
  state: "restart-failed",
  label: "Restart failed",
  detail: "The gateway did not restart. You can try again.",
  canRestart: true,
  error: "The gateway restart failed.",
};

function serverFromWire(raw: Record<string, unknown>): HermesMcpServerInfo {
  const server = parseMcpServer(raw);
  if (!server) throw new Error("fixture did not parse");
  return server;
}

function toolset(
  name: string,
  overrides: Partial<HermesToolsetInfo> = {},
): HermesToolsetInfo {
  return {
    name,
    enabled: true,
    raw: {},
    ...overrides,
  };
}

function externalDir(
  rawPath: string,
  presence: ExternalDirRow["presence"],
  writability: ExternalDirRow["writability"] = "writable",
): ExternalDirRow {
  return {
    rawPath,
    expanded: false,
    presence,
    writability,
    skillNames: [],
    shadowedByLocal: [],
    readOnlyInJune: true,
  };
}

function baseInputs(
  overrides: Partial<IntegrationsHealthInputs> = {},
): IntegrationsHealthInputs {
  return {
    mode: "sandboxed",
    profile: "default",
    lifecycle: CLEAN_LIFECYCLE,
    skills: [],
    toolsets: [],
    mcpServers: [],
    pendingSkillWrites: 0,
    externalDirs: [],
    ...overrides,
  };
}

function codes(health: ReturnType<typeof buildIntegrationsHealth>): string[] {
  return health.issues.map((issue) => issue.code);
}

// ---------------------------------------------------------------------------
// Overall status derivation.
// ---------------------------------------------------------------------------

describe("buildIntegrationsHealth status", () => {
  it("is ready when nothing is wrong", () => {
    const health = buildIntegrationsHealth(baseInputs());
    expect(health.status).toBe("ready");
    expect(health.statusLabel).toBe("Ready");
    expect(health.issues).toHaveLength(0);
  });

  it("is unknown when no runtime is reachable", () => {
    const health = buildIntegrationsHealth(
      baseInputs({
        unavailable: true,
        // Even a real problem does not override unknown when nothing loaded.
        model: { id: "x", supportsTools: false },
      }),
    );
    expect(health.status).toBe("unknown");
    expect(healthStatusLabel(health.status)).toBe("Unknown");
  });

  it("reports needs setup for a missing skill secret", () => {
    const skills: SkillHealthInput[] = [
      { name: "github", enabled: true, badge: setupBadge("missing-api-key") },
    ];
    const health = buildIntegrationsHealth(baseInputs({ skills }));
    expect(health.status).toBe("needs-setup");
    expect(codes(health)).toContain("skill-missing-secret");
  });

  it("reports needs restart when a gateway restart is staged", () => {
    const health = buildIntegrationsHealth(
      baseInputs({ lifecycle: RESTART_LIFECYCLE }),
    );
    expect(health.status).toBe("needs-restart");
    expect(codes(health)).toEqual(["gateway-restart-required"]);
  });

  it("reports broken when a gateway restart failed", () => {
    const health = buildIntegrationsHealth(
      baseInputs({ lifecycle: FAILED_LIFECYCLE }),
    );
    expect(health.status).toBe("broken");
    expect(codes(health)).toEqual(["gateway-restart-failed"]);
    expect(health.issues[0].target).toBe("mcp-diagnostics");
  });

  it("reports needs review for pending skill writes", () => {
    const health = buildIntegrationsHealth(
      baseInputs({ pendingSkillWrites: 2 }),
    );
    expect(health.status).toBe("needs-review");
    expect(codes(health)).toEqual(["skill-pending-review"]);
    expect(health.issues[0].message).toContain("2 agent-authored skill");
  });

  it("reports risky configuration for an enabled high-risk MCP", () => {
    const servers = [
      serverFromWire({ name: "shell", enabled: true, transport: "stdio" }),
    ];
    const health = buildIntegrationsHealth(
      baseInputs({
        mcpServers: servers,
        highRiskMcpServers: ["shell"],
      }),
    );
    expect(health.status).toBe("risky-configuration");
    expect(codes(health)).toContain("mcp-high-risk");
    expect(health.summary.highRiskMcp).toBe(1);
  });

  it("reports broken when an enabled MCP failed its connection", () => {
    const servers = [
      serverFromWire({
        name: "linear",
        enabled: true,
        transport: "http",
        status: "error",
        statusMessage: "connection refused",
      }),
    ];
    const health = buildIntegrationsHealth(baseInputs({ mcpServers: servers }));
    expect(health.status).toBe("broken");
    expect(codes(health)).toContain("mcp-failing");
  });

  it("reports broken when an external directory is missing", () => {
    const health = buildIntegrationsHealth(
      baseInputs({
        externalDirs: [externalDir("~/skills", "missing")],
      }),
    );
    expect(health.status).toBe("broken");
    expect(codes(health)).toContain("external-dir-missing");
  });
});

// ---------------------------------------------------------------------------
// Priority ordering across multiple simultaneous issues.
// ---------------------------------------------------------------------------

describe("buildIntegrationsHealth priority ordering", () => {
  it("orders the worst status first across every area", () => {
    const skills: SkillHealthInput[] = [
      { name: "github", enabled: true, badge: setupBadge("missing-api-key") },
    ];
    const servers = [
      serverFromWire({
        name: "linear",
        enabled: true,
        transport: "http-oauth",
        auth_status: "unauthenticated",
      }),
      serverFromWire({
        name: "db",
        enabled: true,
        transport: "http",
        status: "error",
      }),
      serverFromWire({ name: "shell", enabled: true, transport: "stdio" }),
    ];
    const health = buildIntegrationsHealth(
      baseInputs({
        model: { id: "tts", name: "Venice TTS", supportsTools: false },
        lifecycle: RESTART_LIFECYCLE,
        skills,
        toolsets: [toolset("bash", { configured: false })],
        mcpServers: servers,
        pendingSkillWrites: 1,
        externalDirs: [externalDir("~/missing", "missing")],
        highRiskMcpServers: ["shell"],
      }),
    );

    // Broken dominates the overall badge.
    expect(health.status).toBe("broken");

    // The list is grouped worst-first: broken, then risky, then needs-restart,
    // then needs-setup, then needs-review.
    const order = health.issues.map((issue) => issue.status);
    const weight: Record<string, number> = {
      broken: 6,
      "risky-configuration": 5,
      "needs-restart": 4,
      "needs-setup": 3,
      "needs-review": 2,
    };
    for (let i = 1; i < order.length; i += 1) {
      expect(weight[order[i - 1]]).toBeGreaterThanOrEqual(weight[order[i]]);
    }

    // Every expected issue is present.
    const present = new Set(codes(health));
    const expected: HealthIssueCode[] = [
      "model-no-tools",
      "gateway-restart-required",
      "skill-missing-secret",
      "skill-pending-review",
      "toolset-needs-setup",
      "mcp-auth-needed",
      "mcp-failing",
      "mcp-high-risk",
      "external-dir-missing",
    ];
    for (const code of expected) expect(present.has(code)).toBe(true);
  });

  it("puts the model blocker first within the needs-setup band", () => {
    const health = buildIntegrationsHealth(
      baseInputs({
        model: { id: "tts", supportsTools: false },
        skills: [
          {
            name: "github",
            enabled: true,
            badge: setupBadge("missing-api-key"),
          },
        ],
      }),
    );
    expect(health.issues[0].code).toBe("model-no-tools");
  });

  it("ignores disabled skills, toolsets, and MCP servers", () => {
    const health = buildIntegrationsHealth(
      baseInputs({
        skills: [
          {
            name: "github",
            enabled: false,
            badge: setupBadge("missing-api-key"),
          },
        ],
        toolsets: [toolset("bash", { enabled: false, configured: false })],
        mcpServers: [
          serverFromWire({
            name: "linear",
            enabled: false,
            transport: "http-oauth",
            auth_status: "unauthenticated",
          }),
        ],
      }),
    );
    expect(health.issues).toHaveLength(0);
    expect(health.status).toBe("ready");
  });
});

// ---------------------------------------------------------------------------
// Each issue links to the correct fixing surface.
// ---------------------------------------------------------------------------

describe("issue targets", () => {
  it("maps each issue code to its fixing settings tab", () => {
    const skills: SkillHealthInput[] = [
      { name: "github", enabled: true, badge: setupBadge("missing-api-key") },
      { name: "notion", enabled: true, badge: setupBadge("missing-config") },
    ];
    const servers = [
      serverFromWire({
        name: "linear",
        enabled: true,
        transport: "http-oauth",
        auth_status: "unauthenticated",
      }),
      serverFromWire({
        name: "db",
        enabled: true,
        transport: "http",
        status: "error",
      }),
    ];
    const health = buildIntegrationsHealth(
      baseInputs({
        model: { id: "tts", supportsTools: false },
        lifecycle: RESTART_LIFECYCLE,
        skills,
        toolsets: [toolset("bash", { configured: false })],
        mcpServers: servers,
        pendingSkillWrites: 1,
        externalDirs: [externalDir("~/missing", "missing")],
      }),
    );
    const targetByCode = new Map(
      health.issues.map((issue) => [issue.code, issue.target]),
    );
    expect(targetByCode.get("model-no-tools")).toBe("models");
    expect(targetByCode.get("gateway-restart-required")).toBe(
      "mcp-diagnostics",
    );
    expect(targetByCode.get("skill-missing-secret")).toBe("skills");
    expect(targetByCode.get("skill-missing-config")).toBe("skills");
    expect(targetByCode.get("skill-pending-review")).toBe("skill-review");
    expect(targetByCode.get("toolset-needs-setup")).toBe("toolsets");
    expect(targetByCode.get("mcp-auth-needed")).toBe("mcp");
    expect(targetByCode.get("mcp-failing")).toBe("mcp-diagnostics");
    expect(targetByCode.get("external-dir-missing")).toBe("external-dirs");
  });
});

// ---------------------------------------------------------------------------
// Sanitized health report export.
// ---------------------------------------------------------------------------

describe("buildIntegrationsHealthReport redaction", () => {
  it("counts secrets but never reveals a value", () => {
    const health = buildIntegrationsHealth(
      baseInputs({
        secrets: { configured: 3, missing: 1 },
        skills: [
          {
            name: "github",
            enabled: true,
            badge: setupBadge("missing-api-key"),
          },
        ],
      }),
    );
    const report = buildIntegrationsHealthReport(health, {
      now: new Date("2026-06-26T00:00:00Z"),
    });
    expect(report.summary.secrets).toEqual({ configured: 3, missing: 1 });
    expect(report.schemaVersion).toBe(1);
    expect(report.generatedAt).toBe("2026-06-26T00:00:00.000Z");
    // The serialized form carries counts, no value-shaped fields.
    const text = serializeIntegrationsHealthReport(report);
    expect(text).toContain('"configured": 3');
  });

  it("never echoes a server status message that carries a token", () => {
    // The MCP failing issue is a fixed, generic message, so a token in the
    // server's status message never enters the report in the first place.
    const servers = [
      serverFromWire({
        name: "db",
        enabled: true,
        transport: "http",
        status: "error",
        statusMessage:
          "auth failed with token sk0123456789abcdef0123456789abcdef",
      }),
    ];
    const health = buildIntegrationsHealth(baseInputs({ mcpServers: servers }));
    const report = buildIntegrationsHealthReport(health);
    const text = serializeIntegrationsHealthReport(report);
    expect(text).not.toContain("sk0123456789abcdef0123456789abcdef");
  });

  it("masks a credential-shaped token that rode into the model name", () => {
    // The model name is free text that flows into the report, so the structural
    // redactor backstop must mask a credential-shaped run inside it.
    const health = buildIntegrationsHealth(
      baseInputs({
        model: {
          id: "sk0123456789abcdef0123456789abcdef",
          name: "sk0123456789abcdef0123456789abcdef",
          supportsTools: false,
        },
      }),
    );
    const report = buildIntegrationsHealthReport(health);
    const text = serializeIntegrationsHealthReport(report);
    expect(text).not.toContain("sk0123456789abcdef0123456789abcdef");
    expect(text).toContain("[redacted]");
  });

  it("builds a stable, filesystem-safe filename", () => {
    const name = integrationsHealthReportFilename(
      "team/profile",
      new Date("2026-06-26T12:34:56Z"),
    );
    expect(name).toBe(
      "integrations-health-team-profile-2026-06-26T12-34-56-000Z.json",
    );
  });
});

// ---------------------------------------------------------------------------
// The render-only view: deep-link navigation and the unavailable state.
// ---------------------------------------------------------------------------

describe("IntegrationsHealthView", () => {
  it("renders the unavailable state when no runtime is reachable", () => {
    const health = buildIntegrationsHealth(baseInputs({ unavailable: true }));
    render(<IntegrationsHealthView health={health} />);
    expect(screen.getByText("Hermes is not running")).toBeTruthy();
  });

  it("navigates to the fixing tab when an issue link is clicked", async () => {
    const health = buildIntegrationsHealth(
      baseInputs({ model: { id: "tts", supportsTools: false } }),
    );
    const onNavigate = vi.fn();
    render(<IntegrationsHealthView health={health} onNavigate={onNavigate} />);
    await userEvent.click(screen.getByRole("button", { name: /Open models/i }));
    expect(onNavigate).toHaveBeenCalledWith("models");
  });

  it("shows the all-clear message when everything is ready", () => {
    const health = buildIntegrationsHealth(baseInputs());
    render(<IntegrationsHealthView health={health} />);
    expect(screen.getByText(/Everything is ready/i)).toBeTruthy();
  });
});
