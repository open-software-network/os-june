import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InstalledSkillsSection } from "../components/settings/InstalledSkillsSection";
import { McpServersSection } from "../components/settings/McpServersSection";
import {
  resetActiveHermesProfileForTests,
  setActiveHermesProfileName,
} from "../lib/active-hermes-profile";
import { FakeHermesServer, type FakeHermesScenario } from "./fixtures/fake-hermes-server";

const mocks = vi.hoisted(() => ({
  hermesBridgeStatus: vi.fn(),
  invoke: vi.fn(),
  startHermesBridge: vi.fn(),
  stopHermesBridge: vi.fn(),
  hermesMcpOauthLogin: vi.fn(),
  hermesResetBundledSkill: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  hermesBridgeStatus: mocks.hermesBridgeStatus,
  invoke: mocks.invoke,
  startHermesBridge: mocks.startHermesBridge,
  stopHermesBridge: mocks.stopHermesBridge,
  hermesMcpOauthLogin: mocks.hermesMcpOauthLogin,
  hermesResetBundledSkill: mocks.hermesResetBundledSkill,
}));

type ServerSet = {
  default: FakeHermesServer;
  work: FakeHermesServer;
};

function scenarioFor(label: string): FakeHermesScenario {
  return {
    token: `fake-token-${label}`,
    skills: [
      {
        name: `${label}-skill`,
        description: `${label} profile skill`,
        enabled: true,
        source: "hub",
      },
    ],
    mcpServers: [
      {
        name: `${label}-server`,
        enabled: true,
        transport: "stdio",
        command: `mcp-${label}`,
        status: "connected",
        auth_status: "not-required",
      },
    ],
    gateway: { gateway_running: true },
  };
}

function makeServers(): ServerSet {
  return {
    default: new FakeHermesServer(scenarioFor("default")),
    work: new FakeHermesServer(scenarioFor("work")),
  };
}

function bridgeStatus(server: FakeHermesServer) {
  const connection = {
    baseUrl: server.baseUrl,
    wsUrl: `${server.baseUrl.replace("http", "ws")}/api/ws`,
    token: server.token,
    port: 65535,
    command: "hermes",
    hermesHome: "/tmp/fake-hermes-home",
    cwd: null,
    providerProxyPort: 1,
    pid: 1234,
    sandboxed: true,
    fullMode: false,
  };
  return {
    running: true,
    connection,
    connections: [connection],
  };
}

function routeAdminRequests(servers: ServerSet): string[] {
  const paths: string[] = [];
  mocks.hermesBridgeStatus.mockResolvedValue(bridgeStatus(servers.default));
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command !== "hermes_admin_request") {
      throw new Error(`Unexpected command: ${command}`);
    }

    const path = String(args.path);
    paths.push(path);
    const profile = new URL(`http://fake.local${path}`).searchParams.get("profile") ?? "default";
    const server = profile === "work" ? servers.work : servers.default;
    const response = await server.fetch(`${server.baseUrl}${path}`, {
      method: String(args.method ?? "GET"),
      headers: { "X-Hermes-Session-Token": server.token },
      body: args.body === undefined ? undefined : JSON.stringify(args.body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Hermes API returned ${response.status}: ${text}`);
    }
    return text.trim() ? JSON.parse(text) : null;
  });
  return paths;
}

describe("profile-scoped settings sections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetActiveHermesProfileForTests();
  });

  afterEach(() => {
    resetActiveHermesProfileForTests();
  });

  describe("McpServersSection", () => {
    it("requests MCP servers for the active profile", async () => {
      const servers = makeServers();
      const paths = routeAdminRequests(servers);
      Object.assign(servers.default, { activeProfile: "work" });
      setActiveHermesProfileName("work");

      render(<McpServersSection />);

      expect(await screen.findByText("work-server")).toBeInTheDocument();
      expect(paths).toContain("/api/mcp/servers?profile=work");
      expect(servers.work.requestLog.some((entry) => entry.query.profile === "work")).toBe(true);
    });

    it("keeps the default-profile request path unchanged", async () => {
      const servers = makeServers();
      const paths = routeAdminRequests(servers);

      render(<McpServersSection />);

      expect(await screen.findByText("default-server")).toBeInTheDocument();
      expect(paths).toContain("/api/mcp/servers?profile=default");
    });

    it("refetches on active-profile switch without showing the previous profile cache", async () => {
      const servers = makeServers();
      const paths = routeAdminRequests(servers);

      render(<McpServersSection />);

      expect(await screen.findByText("default-server")).toBeInTheDocument();

      await act(async () => {
        setActiveHermesProfileName("work");
      });

      expect(await screen.findByText("work-server")).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByText("default-server")).not.toBeInTheDocument());
      expect(paths).toContain("/api/mcp/servers?profile=default");
      expect(paths).toContain("/api/mcp/servers?profile=work");
    });
  });

  describe("InstalledSkillsSection", () => {
    it("waits for a confirmed active profile before loading installed skills", async () => {
      const servers = {
        default: new FakeHermesServer({
          ...scenarioFor("default"),
          profileActiveError: { status: 503, error: "active profile read failed" },
        }),
        work: new FakeHermesServer(scenarioFor("work")),
      };
      const paths = routeAdminRequests(servers);

      const { container, unmount } = render(<InstalledSkillsSection />);

      await waitFor(() => expect(paths).toContain("/api/profiles/active"));
      expect(paths).not.toContain("/api/skills?profile=default");
      expect(container.querySelector(".installed-skill-skeleton")).toBeTruthy();

      unmount();
      servers.default.setProfileActiveError(undefined);
      Object.assign(servers.default, { activeProfile: "work" });

      render(<InstalledSkillsSection />);

      expect(await screen.findByText("work-skill")).toBeInTheDocument();
      expect(paths).not.toContain("/api/skills?profile=default");
      expect(paths).toContain("/api/skills?profile=work");
    });

    it("keeps the Hermes-not-running surface while the active profile is unconfirmed", async () => {
      mocks.hermesBridgeStatus.mockResolvedValue({
        running: false,
        connections: [],
      });

      render(<InstalledSkillsSection />);

      expect(await screen.findByText("Hermes is not running")).toBeInTheDocument();
      expect(mocks.invoke).not.toHaveBeenCalled();
    });

    it("requests installed skills for the active profile", async () => {
      const servers = makeServers();
      const paths = routeAdminRequests(servers);
      Object.assign(servers.default, { activeProfile: "work" });
      setActiveHermesProfileName("work");

      render(<InstalledSkillsSection />);

      expect(await screen.findByText("work-skill")).toBeInTheDocument();
      expect(paths).toContain("/api/skills?profile=work");
      expect(servers.work.requestLog.some((entry) => entry.query.profile === "work")).toBe(true);
    });

    it("keeps the default-profile request path unchanged", async () => {
      const servers = makeServers();
      const paths = routeAdminRequests(servers);

      render(<InstalledSkillsSection />);

      expect(await screen.findByText("default-skill")).toBeInTheDocument();
      expect(paths).toContain("/api/skills?profile=default");
    });

    it("refetches on active-profile switch without showing the previous profile cache", async () => {
      const servers = makeServers();
      const paths = routeAdminRequests(servers);

      render(<InstalledSkillsSection />);

      expect(await screen.findByText("default-skill")).toBeInTheDocument();

      await act(async () => {
        setActiveHermesProfileName("work");
      });

      expect(await screen.findByText("work-skill")).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByText("default-skill")).not.toBeInTheDocument());
      expect(paths).toContain("/api/skills?profile=default");
      expect(paths).toContain("/api/skills?profile=work");
    });
  });
});
