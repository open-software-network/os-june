import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_NEW_SESSION_EVENT,
  AGENT_NEW_SESSION_PENDING_KEY,
  AgentWorkspace,
} from "../components/agent/AgentWorkspace";

const mocks = vi.hoisted(() => ({
  cancelAgentTask: vi.fn(),
  createAgentTask: vi.fn(),
  getAgentTask: vi.fn(),
  hermesBridgeFilesystemSnapshot: vi.fn(),
  hermesBridgeMessagingPlatforms: vi.fn(),
  hermesBridgeSkills: vi.fn(),
  hermesBridgeStatus: vi.fn(),
  hermesBridgeToolsets: vi.fn(),
  listAgentTasks: vi.fn(),
  openHermesBridgeFile: vi.fn(),
  retryAgentTask: vi.fn(),
  saveAgentAssistantMessage: vi.fn(),
  saveAgentHermesSession: vi.fn(),
  sendAgentMessage: vi.fn(),
  startHermesBridge: vi.fn(),
  toggleHermesBridgeSkill: vi.fn(),
  toggleHermesBridgeToolset: vi.fn(),
  updateHermesBridgeMessagingPlatform: vi.fn(),
  listHermesSessionMessages: vi.fn(),
  listHermesSessions: vi.fn(),
  gatewayRequest: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  cancelAgentTask: mocks.cancelAgentTask,
  createAgentTask: mocks.createAgentTask,
  getAgentTask: mocks.getAgentTask,
  hermesBridgeFilesystemSnapshot: mocks.hermesBridgeFilesystemSnapshot,
  hermesBridgeMessagingPlatforms: mocks.hermesBridgeMessagingPlatforms,
  hermesBridgeSkills: mocks.hermesBridgeSkills,
  hermesBridgeStatus: mocks.hermesBridgeStatus,
  hermesBridgeToolsets: mocks.hermesBridgeToolsets,
  listAgentTasks: mocks.listAgentTasks,
  openHermesBridgeFile: mocks.openHermesBridgeFile,
  retryAgentTask: mocks.retryAgentTask,
  saveAgentAssistantMessage: mocks.saveAgentAssistantMessage,
  saveAgentHermesSession: mocks.saveAgentHermesSession,
  sendAgentMessage: mocks.sendAgentMessage,
  startHermesBridge: mocks.startHermesBridge,
  toggleHermesBridgeSkill: mocks.toggleHermesBridgeSkill,
  toggleHermesBridgeToolset: mocks.toggleHermesBridgeToolset,
  updateHermesBridgeMessagingPlatform:
    mocks.updateHermesBridgeMessagingPlatform,
}));

vi.mock("../lib/hermes-adapter", () => ({
  listHermesSessionMessages: mocks.listHermesSessionMessages,
  listHermesSessions: mocks.listHermesSessions,
  sessionTimestamp: (session: { last_active?: string; started_at?: string }) =>
    session.last_active ?? session.started_at ?? "",
  titleFromPrompt: (prompt: string) => prompt.trim() || "Untitled session",
}));

vi.mock("../lib/hermes-gateway", () => ({
  HermesGatewayClient: class {
    connect = vi.fn();
    close = vi.fn();
    onEvent = vi.fn(() => vi.fn());
    request = mocks.gatewayRequest;
  },
}));

const existingTask = {
  id: "task-1",
  title: "Existing task",
  prompt: "Existing task",
  status: "completed",
  progressSummary: "",
  createdAt: "2026-06-04T12:00:00Z",
  updatedAt: "2026-06-04T12:00:00Z",
  messages: [],
  toolEvents: [],
};

const existingSession = {
  id: "session-1",
  title: "Existing session",
  preview: "Existing preview",
  last_active: "2026-06-04T12:00:00Z",
};

describe("AgentWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    mocks.listAgentTasks.mockResolvedValue({ items: [existingTask] });
    mocks.getAgentTask.mockResolvedValue(existingTask);
    mocks.hermesBridgeStatus.mockResolvedValue({
      running: true,
      connection: { port: 61234, wsUrl: "ws://127.0.0.1:61234" },
    });
    mocks.startHermesBridge.mockResolvedValue({
      running: true,
      connection: { port: 61234, wsUrl: "ws://127.0.0.1:61234" },
    });
    mocks.listHermesSessions.mockResolvedValue([existingSession]);
    mocks.listHermesSessionMessages.mockResolvedValue([]);
    mocks.hermesBridgeFilesystemSnapshot.mockResolvedValue({ roots: [] });
    mocks.openHermesBridgeFile.mockResolvedValue(undefined);
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.create") {
        return Promise.resolve({
          session_id: "runtime-session-2",
          stored_session_id: "session-2",
        });
      }
      return Promise.resolve({});
    });
  });

  it("honors a pending New Session request instead of selecting existing work", async () => {
    window.sessionStorage.setItem(AGENT_NEW_SESSION_PENDING_KEY, "1");

    render(<AgentWorkspace />);

    expect(
      await screen.findByText("Start an agent session"),
    ).toBeInTheDocument();
    await waitFor(() => expect(mocks.listHermesSessions).toHaveBeenCalled());
    expect(screen.queryByText("Existing session")).toBeNull();
    expect(screen.queryByText("Existing task")).toBeNull();
    expect(
      window.sessionStorage.getItem(AGENT_NEW_SESSION_PENDING_KEY),
    ).toBeNull();
  });

  it("keeps the blank composer after a New Session event during refresh", async () => {
    render(<AgentWorkspace />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    window.dispatchEvent(new CustomEvent(AGENT_NEW_SESSION_EVENT));

    expect(
      await screen.findByText("Start an agent session"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Existing session")).toBeNull();
  });

  it("submits a pending New Session prompt as a fresh Hermes session", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ prompt: "summarize the current page" }),
    );

    render(<AgentWorkspace />);

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "summarize the current page",
      }),
    );
    expect(
      window.sessionStorage.getItem(AGENT_NEW_SESSION_PENDING_KEY),
    ).toBeNull();
  });

  it("renders generated workspace files mentioned by Hermes as openable artifacts", async () => {
    const user = userEvent.setup();
    const samplePath =
      "/Users/junho/Library/Application Support/co.opensoftware.scribe/hermes/workspace/sample.pdf";
    mocks.hermesBridgeFilesystemSnapshot.mockResolvedValue({
      roots: [
        {
          id: "workspace",
          label: "Workspace",
          path: "/Users/junho/Library/Application Support/co.opensoftware.scribe/hermes/workspace",
          description: "Hermes scratch files and generated outputs.",
          entries: [
            {
              name: "sample.pdf",
              path: samplePath,
              kind: "file",
              size: 1768,
              modifiedAt: "2026-06-04T18:39:00Z",
            },
          ],
        },
      ],
    });
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "message-1",
        role: "assistant",
        content: "Done. The PDF is available as `sample.pdf`.",
        timestamp: "2026-06-04T18:39:00Z",
      },
    ]);

    render(<AgentWorkspace />);

    expect(await screen.findByLabelText("Generated files")).toBeInTheDocument();
    expect(screen.getAllByText("sample.pdf").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Open" }));

    expect(mocks.openHermesBridgeFile).toHaveBeenCalledWith(samplePath);
  });
});
