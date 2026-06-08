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
  hermesBridgeFilePreview: vi.fn(),
  hermesBridgeMessagingPlatforms: vi.fn(),
  hermesBridgeSkills: vi.fn(),
  hermesBridgeStatus: vi.fn(),
  hermesBridgeToolsets: vi.fn(),
  importHermesBridgeFile: vi.fn(),
  listAgentTasks: vi.fn(),
  downloadHermesBridgeFile: vi.fn(),
  retryAgentTask: vi.fn(),
  saveAgentAssistantMessage: vi.fn(),
  saveAgentHermesSession: vi.fn(),
  sendAgentMessage: vi.fn(),
  startHermesBridge: vi.fn(),
  suggestAgentSessionTitle: vi.fn(),
  toggleHermesBridgeSkill: vi.fn(),
  toggleHermesBridgeToolset: vi.fn(),
  updateHermesBridgeMessagingPlatform: vi.fn(),
  listHermesSessionMessages: vi.fn(),
  listHermesSessions: vi.fn(),
  gatewayRequest: vi.fn(),
  eventHandlers: new Map<
    string,
    (event: { payload?: { paths?: string[] } }) => void
  >(),
  listen: vi.fn(
    async (
      eventName: string,
      handler: (event: { payload?: { paths?: string[] } }) => void,
    ) => {
      mocks.eventHandlers.set(eventName, handler);
      return () => mocks.eventHandlers.delete(eventName);
    },
  ),
}));

vi.mock("../lib/tauri", () => ({
  cancelAgentTask: mocks.cancelAgentTask,
  createAgentTask: mocks.createAgentTask,
  getAgentTask: mocks.getAgentTask,
  hermesBridgeFilesystemSnapshot: mocks.hermesBridgeFilesystemSnapshot,
  hermesBridgeFilePreview: mocks.hermesBridgeFilePreview,
  hermesBridgeMessagingPlatforms: mocks.hermesBridgeMessagingPlatforms,
  hermesBridgeSkills: mocks.hermesBridgeSkills,
  hermesBridgeStatus: mocks.hermesBridgeStatus,
  hermesBridgeToolsets: mocks.hermesBridgeToolsets,
  importHermesBridgeFile: mocks.importHermesBridgeFile,
  listAgentTasks: mocks.listAgentTasks,
  downloadHermesBridgeFile: mocks.downloadHermesBridgeFile,
  retryAgentTask: mocks.retryAgentTask,
  saveAgentAssistantMessage: mocks.saveAgentAssistantMessage,
  saveAgentHermesSession: mocks.saveAgentHermesSession,
  sendAgentMessage: mocks.sendAgentMessage,
  startHermesBridge: mocks.startHermesBridge,
  suggestAgentSessionTitle: mocks.suggestAgentSessionTitle,
  toggleHermesBridgeSkill: mocks.toggleHermesBridgeSkill,
  toggleHermesBridgeToolset: mocks.toggleHermesBridgeToolset,
  updateHermesBridgeMessagingPlatform:
    mocks.updateHermesBridgeMessagingPlatform,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
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
    mocks.hermesBridgeFilePreview.mockResolvedValue(null);
    mocks.importHermesBridgeFile.mockImplementation(async (path: string) => ({
      name: path.split("/").pop() ?? "attachment",
      path: `/Users/junho/Library/Application Support/co.opensoftware.scribe/hermes/workspace/uploads/${path.split("/").pop() ?? "attachment"}`,
      rootLabel: "Workspace",
      size: 1234,
      previewDataUrl: path.endsWith(".png")
        ? "data:image/png;base64,preview"
        : null,
    }));
    mocks.downloadHermesBridgeFile.mockResolvedValue(
      "/Users/junho/Downloads/sample.pdf",
    );
    mocks.suggestAgentSessionTitle.mockResolvedValue({
      title: "Summarize Current Page",
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.create") {
        return Promise.resolve({
          session_id: "runtime-session-2",
          stored_session_id: "session-2",
        });
      }
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
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
    mocks.listHermesSessions.mockResolvedValue([
      {
        id: "session-2",
        title: "Untitled session",
        preview: "summarize the current page",
        last_active: "2026-06-04T12:01:00Z",
      },
    ]);

    render(<AgentWorkspace />);

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "summarize the current page",
      }),
    );
    expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.create", {
      title: "Summarize Current Page",
      cols: 96,
    });
    expect(
      await screen.findByText("Summarize Current Page"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Untitled session")).toBeNull();
    expect(
      window.sessionStorage.getItem(AGENT_NEW_SESSION_PENDING_KEY),
    ).toBeNull();
  });

  it("renders generated workspace files mentioned by Hermes as downloadable artifacts", async () => {
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

    await user.click(
      screen.getByRole("button", { name: "Download sample.pdf" }),
    );

    expect(mocks.downloadHermesBridgeFile).toHaveBeenCalledWith(samplePath);
  });

  it("renders generated workspace images as thumbnails", async () => {
    const screenshotPath =
      "/Users/junho/Library/Application Support/co.opensoftware.scribe/hermes/workspace/screenshot.png";
    mocks.hermesBridgeFilePreview.mockResolvedValue(
      "data:image/png;base64,generated-preview",
    );
    mocks.hermesBridgeFilesystemSnapshot.mockResolvedValue({
      roots: [
        {
          id: "workspace",
          label: "Workspace",
          path: "/Users/junho/Library/Application Support/co.opensoftware.scribe/hermes/workspace",
          description: "Hermes scratch files and generated outputs.",
          entries: [
            {
              name: "screenshot.png",
              path: screenshotPath,
              kind: "file",
              size: 2048,
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
        content: "I saved the screenshot as `screenshot.png`.",
        timestamp: "2026-06-04T18:39:00Z",
      },
    ]);

    render(<AgentWorkspace />);

    expect(
      await screen.findByRole("img", { name: "screenshot.png" }),
    ).toHaveAttribute("src", "data:image/png;base64,generated-preview");
    expect(mocks.hermesBridgeFilePreview).toHaveBeenCalledWith(screenshotPath);
  });

  it("imports dropped files into the Hermes workspace before submitting", async () => {
    const user = userEvent.setup();
    render(<AgentWorkspace />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith(
        "tauri://drag-drop",
        expect.any(Function),
      ),
    );

    mocks.eventHandlers.get("tauri://drag-drop")?.({
      payload: {
        paths: [
          "/Users/junho/Library/Application Support/CleanShot/media/screenshot.png",
        ],
      },
    });

    expect(await screen.findByText("screenshot.png")).toBeInTheDocument();
    expect(
      document.querySelector(".agent-attachment-chip img"),
    ).toHaveAttribute("src", "data:image/png;base64,preview");
    await user.type(
      screen.getByPlaceholderText("Send a follow-up"),
      "what is in this image?",
    );
    await user.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: expect.stringContaining(
          "/Users/junho/Library/Application Support/co.opensoftware.scribe/hermes/workspace/uploads/screenshot.png",
        ),
      }),
    );
    expect(mocks.importHermesBridgeFile).toHaveBeenCalledWith(
      "/Users/junho/Library/Application Support/CleanShot/media/screenshot.png",
    );
  });
});
