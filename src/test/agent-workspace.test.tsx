import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_DELETE_SESSION_EVENT,
  AGENT_NEW_SESSION_EVENT,
  AGENT_NEW_SESSION_PENDING_KEY,
  AGENT_SESSIONS_CHANGED_EVENT,
  AgentWorkspace,
  HERO_GREETINGS,
  SkillsToolsPanel,
  resetAgentSessionContinuity,
  type AgentSessionsChangedDetail,
} from "../components/agent/AgentWorkspace";
import {
  ANONYMOUS_MODEL_DESCRIPTION,
  E2EE_MODEL_DESCRIPTION,
  PROVIDER_MODEL_SETTINGS_CHANGED_EVENT,
} from "../lib/model-privacy";
import { HermesGatewayError } from "../lib/hermes-gateway";
import { classifyHermesEvent } from "../lib/hermes-control-plane";
import { hermesArtifactStore } from "../lib/hermes-artifact-store";
import { hermesTraceBuffer } from "../lib/hermes-trace-buffer";
import { pendingActionStore } from "../lib/hermes-pending-actions";

// The hero greeting cycles per visit, so tests match any entry in the pool.
const HERO_GREETING = new RegExp(
  `^(?:${HERO_GREETINGS.map((greeting) => greeting.replace("?", "\\?")).join("|")})$`,
);

const mocks = vi.hoisted(() => ({
  cancelAgentTask: vi.fn(),
  createAgentTask: vi.fn(),
  ensureHermesBridgeSession: vi.fn(),
  generateImage: vi.fn(),
  getAgentTask: vi.fn(),
  getHermesBridgeSkill: vi.fn(),
  hermesBridgeFilesystemSnapshot: vi.fn(),
  hermesBridgeFilePreview: vi.fn(),
  hermesBridgeFileText: vi.fn(),
  hermesBridgeMessagingPlatforms: vi.fn(),
  hermesBridgeSkills: vi.fn(),
  hermesBridgeStatus: vi.fn(),
  hermesBridgeToolsets: vi.fn(),
  importHermesBridgeFile: vi.fn(),
  importHermesBridgeFileBytes: vi.fn(),
  listVeniceModels: vi.fn(),
  listAgentTasks: vi.fn(),
  downloadHermesBridgeFile: vi.fn(),
  osAccountsUpgrade: vi.fn(),
  setVeniceModel: vi.fn(),
  providerModelSettings: vi.fn(),
  retryAgentTask: vi.fn(),
  saveAgentAssistantMessage: vi.fn(),
  saveAgentHermesSession: vi.fn(),
  sendAgentMessage: vi.fn(),
  startHermesBridge: vi.fn(),
  submitIssueReport: vi.fn(),
  suggestAgentSessionTitle: vi.fn(),
  explainAgentApproval: vi.fn(),
  toggleHermesBridgeSkill: vi.fn(),
  toggleHermesBridgeToolset: vi.fn(),
  updateHermesBridgeMessagingPlatform: vi.fn(),
  deleteHermesSession: vi.fn(),
  listHermesSessionMessages: vi.fn(),
  hermesAgentCliAccess: vi.fn(),
  setHermesAgentCliAccess: vi.fn(),
  listHermesSessions: vi.fn(),
  gatewayRequest: vi.fn(),
  gatewayEventHandlers: new Set<(event: Record<string, unknown>) => void>(),
  gatewayInstances: [] as Array<{
    connect: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }>,
  eventHandlers: new Map<string, (event: { payload?: { paths?: string[] } }) => void>(),
  listen: vi.fn(
    async (eventName: string, handler: (event: { payload?: { paths?: string[] } }) => void) => {
      mocks.eventHandlers.set(eventName, handler);
      return () => mocks.eventHandlers.delete(eventName);
    },
  ),
}));

vi.mock("../lib/tauri", () => ({
  // The pending skill-writes tray loads through the Rust bridge via this named
  // `invoke`. A quiet stub keeps these workspace tests off that path.
  invoke: vi.fn(async () => []),
  cancelAgentTask: mocks.cancelAgentTask,
  createAgentTask: mocks.createAgentTask,
  ensureHermesBridgeSession: mocks.ensureHermesBridgeSession,
  generateImage: mocks.generateImage,
  getAgentTask: mocks.getAgentTask,
  getHermesBridgeSkill: mocks.getHermesBridgeSkill,
  hermesBridgeFilesystemSnapshot: mocks.hermesBridgeFilesystemSnapshot,
  hermesBridgeFilePreview: mocks.hermesBridgeFilePreview,
  hermesBridgeFileText: mocks.hermesBridgeFileText,
  hermesBridgeMessagingPlatforms: mocks.hermesBridgeMessagingPlatforms,
  hermesAgentCliAccess: mocks.hermesAgentCliAccess,
  hermesBridgeSkills: mocks.hermesBridgeSkills,
  hermesBridgeStatus: mocks.hermesBridgeStatus,
  hermesBridgeToolsets: mocks.hermesBridgeToolsets,
  importHermesBridgeFile: mocks.importHermesBridgeFile,
  importHermesBridgeFileBytes: mocks.importHermesBridgeFileBytes,
  listVeniceModels: mocks.listVeniceModels,
  listAgentTasks: mocks.listAgentTasks,
  downloadHermesBridgeFile: mocks.downloadHermesBridgeFile,
  osAccountsUpgrade: mocks.osAccountsUpgrade,
  providerModelSettings: mocks.providerModelSettings,
  retryAgentTask: mocks.retryAgentTask,
  setHermesAgentCliAccess: mocks.setHermesAgentCliAccess,
  setVeniceModel: mocks.setVeniceModel,
  saveAgentAssistantMessage: mocks.saveAgentAssistantMessage,
  saveAgentHermesSession: mocks.saveAgentHermesSession,
  sendAgentMessage: mocks.sendAgentMessage,
  startHermesBridge: mocks.startHermesBridge,
  submitIssueReport: mocks.submitIssueReport,
  suggestAgentSessionTitle: mocks.suggestAgentSessionTitle,
  explainAgentApproval: mocks.explainAgentApproval,
  toggleHermesBridgeSkill: mocks.toggleHermesBridgeSkill,
  toggleHermesBridgeToolset: mocks.toggleHermesBridgeToolset,
  updateHermesBridgeMessagingPlatform: mocks.updateHermesBridgeMessagingPlatform,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

vi.mock("../lib/hermes-adapter", async (importOriginal) => ({
  // Spread the real module so the pure scheduled-run helpers
  // (isScheduledRunPreamble/stripScheduledRunPreamble) are present for the
  // chat runtime; only the network-touching calls are overridden.
  ...(await importOriginal<typeof import("../lib/hermes-adapter")>()),
  deleteHermesSession: mocks.deleteHermesSession,
  listHermesSessionMessages: mocks.listHermesSessionMessages,
  listHermesSessions: mocks.listHermesSessions,
  sessionTimestamp: (session: { last_active?: string; started_at?: string }) =>
    session.last_active ?? session.started_at ?? "",
  titleFromPrompt: (prompt: string) => prompt.trim() || "Untitled session",
}));

vi.mock("../lib/hermes-gateway", async (importOriginal) => ({
  // Real HermesGatewayError / isSessionBusyError — only the client is faked.
  ...(await importOriginal<typeof import("../lib/hermes-gateway")>()),
  HermesGatewayClient: class {
    constructor() {
      mocks.gatewayInstances.push(this as unknown as (typeof mocks.gatewayInstances)[number]);
    }
    connect = vi.fn();
    close = vi.fn();
    onEvent = vi.fn((handler: (event: Record<string, unknown>) => void) => {
      mocks.gatewayEventHandlers.add(handler);
      return () => mocks.gatewayEventHandlers.delete(handler);
    });
    onClose = vi.fn(() => vi.fn());
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

function mockGlmCapabilities(capabilities: string[]) {
  mocks.listVeniceModels.mockResolvedValue({
    mode: "generation",
    modelType: "text",
    selectedModel: "zai-org-glm-5-2",
    models: [
      {
        provider: "venice",
        id: "zai-org-glm-5-2",
        name: "GLM 5.2",
        modelType: "text",
        privacy: "private",
        traits: [],
        capabilities,
      },
      {
        provider: "venice",
        id: "kimi-k2-6",
        name: "Kimi K2.6",
        modelType: "text",
        privacy: "private",
        traits: [],
        capabilities: [],
      },
    ],
  });
}

describe("AgentWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gatewayEventHandlers.clear();
    mocks.gatewayInstances.length = 0;
    // Auto-cleanup unmounts the workspace after each test, which snapshots
    // any still-working session for the next mount — across tests that would
    // leak one test's mid-run session into the next.
    resetAgentSessionContinuity();
    // Feature 14: the artifact store is a process-wide singleton; drop the
    // session rows these tests touch so one test's artifacts don't leak into
    // the next.
    for (const id of ["session-1", "session-2", "runtime-session-2"]) {
      hermesArtifactStore.clearSession(id);
    }
    // Feature 04: the pending-action store is the same kind of process-wide
    // singleton. Clear these tests' session ids so a prior test's "Needs you"
    // rows (now keyed by the durable stored id) don't leak into the next.
    for (const id of ["session-1", "session-2", "runtime-session-2"]) {
      pendingActionStore.resolveSession(id);
    }
    window.sessionStorage.clear();
    window.localStorage.clear();
    mocks.listAgentTasks.mockResolvedValue({ items: [existingTask] });
    mocks.providerModelSettings.mockResolvedValue({
      settings: {
        transcriptionProvider: "venice",
        transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
        generationModel: "zai-org-glm-5-2",
      },
    });
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: "zai-org-glm-5-2",
      models: [
        {
          provider: "venice",
          id: "zai-org-glm-5-2",
          name: "GLM 5.2",
          modelType: "text",
          privacy: "private",
          traits: [],
          capabilities: ["functionCalling"],
        },
        {
          provider: "venice",
          id: "kimi-k2-6",
          name: "Kimi K2.6",
          modelType: "text",
          privacy: "private",
          traits: [],
          capabilities: [],
        },
      ],
    });
    mocks.getAgentTask.mockResolvedValue(existingTask);
    mocks.hermesBridgeStatus.mockResolvedValue({
      running: true,
      connection: { port: 61234, wsUrl: "ws://127.0.0.1:61234" },
    });
    // Mirrors the backend: starting a mode yields a status that contains
    // that mode's connection (alongside any other live mode).
    mocks.startHermesBridge.mockImplementation(async (_cwd?: string, fullMode?: boolean) => {
      const connection = {
        port: 61234,
        wsUrl: "ws://127.0.0.1:61234",
        fullMode: Boolean(fullMode),
      };
      return { running: true, connection, connections: [connection] };
    });
    mocks.listHermesSessions.mockResolvedValue([existingSession]);
    mocks.listHermesSessionMessages.mockResolvedValue([]);
    mocks.hermesAgentCliAccess.mockResolvedValue({ enabled: false });
    mocks.hermesBridgeSkills.mockResolvedValue([]);
    mocks.getHermesBridgeSkill.mockImplementation(async (name: string) => ({
      name,
      relativePath: `${name}/SKILL.md`,
      content: `# ${name}\n\nUse ${name}.`,
    }));
    mocks.hermesBridgeFilesystemSnapshot.mockResolvedValue({ roots: [] });
    // Mirrors the Rust image_preview_data_url: an image path yields a
    // data url, anything else null. Feature 19's structured image attach reads
    // the bytes through this command at attach time.
    mocks.hermesBridgeFilePreview.mockImplementation(async (path: string) =>
      /\.(png|jpe?g|gif|webp|tiff?)$/i.test(path) ? "data:image/png;base64,cHJldmlldw==" : null,
    );
    mocks.hermesBridgeFileText.mockResolvedValue(null);
    mocks.importHermesBridgeFile.mockImplementation(async (path: string) => ({
      name: path.split("/").pop() ?? "attachment",
      path: `/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace/uploads/${path.split("/").pop() ?? "attachment"}`,
      rootLabel: "Workspace",
      size: 1234,
      previewDataUrl: path.endsWith(".png") ? "data:image/png;base64,preview" : null,
    }));
    mocks.importHermesBridgeFileBytes.mockImplementation(async (name: string) => ({
      name,
      path: `/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace/uploads/${name}`,
      rootLabel: "Workspace",
      size: 5,
      previewDataUrl: null,
    }));
    mocks.downloadHermesBridgeFile.mockResolvedValue("/Users/alex/Downloads/sample.pdf");
    mocks.ensureHermesBridgeSession.mockResolvedValue({});
    mocks.deleteHermesSession.mockResolvedValue(undefined);
    mocks.suggestAgentSessionTitle.mockResolvedValue({
      title: "Summarize Current Page",
    });
    mocks.explainAgentApproval.mockResolvedValue({
      explanation: "This deletes the build folder, then rebuilds the project from scratch.",
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

  it("lets users cancel a clean skill editor without making changes", async () => {
    const user = userEvent.setup();

    render(
      <SkillsToolsPanel
        loading={false}
        query=""
        saving={null}
        skills={[
          {
            name: "editing-skill",
            description: "Drafts responses.",
            category: "Writing",
            enabled: true,
          },
        ]}
        toolsets={[]}
        onQueryChange={vi.fn()}
        onRefresh={vi.fn()}
        onToggleSkill={vi.fn()}
        onToggleToolset={vi.fn()}
        onOpenSkill={async (skill) => ({
          name: skill.name,
          relativePath: `${skill.name}/SKILL.md`,
          content: "# Editing skill\n\nDo the work.",
        })}
        onSaveSkill={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /editing-skill/i }));
    const editor = await screen.findByRole("textbox", {
      name: "editing-skill skill Markdown",
    });
    expect(editor).toHaveValue("# Editing skill\n\nDo the work.");

    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toBeEnabled();
    await user.click(cancel);

    expect(
      screen.queryByRole("textbox", {
        name: "editing-skill skill Markdown",
      }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Skills and tools" })).toBeInTheDocument();
  });

  it("keeps skill editor cancel disabled while the document loads", async () => {
    const user = userEvent.setup();

    render(
      <SkillsToolsPanel
        loading={false}
        query=""
        saving={null}
        skills={[
          {
            name: "editing-skill",
            description: "Drafts responses.",
            category: "Writing",
            enabled: true,
          },
        ]}
        toolsets={[]}
        onQueryChange={vi.fn()}
        onRefresh={vi.fn()}
        onToggleSkill={vi.fn()}
        onToggleToolset={vi.fn()}
        onOpenSkill={() => new Promise<never>(() => undefined)}
        onSaveSkill={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /editing-skill/i }));

    expect(await screen.findByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("confirms before canceling dirty skill edits", async () => {
    const user = userEvent.setup();

    render(
      <SkillsToolsPanel
        loading={false}
        query=""
        saving={null}
        skills={[
          {
            name: "editing-skill",
            description: "Drafts responses.",
            category: "Writing",
            enabled: true,
          },
        ]}
        toolsets={[]}
        onQueryChange={vi.fn()}
        onRefresh={vi.fn()}
        onToggleSkill={vi.fn()}
        onToggleToolset={vi.fn()}
        onOpenSkill={async (skill) => ({
          name: skill.name,
          relativePath: `${skill.name}/SKILL.md`,
          content: "# Editing skill\n\nDo the work.",
        })}
        onSaveSkill={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /editing-skill/i }));
    const editor = await screen.findByRole("textbox", {
      name: "editing-skill skill Markdown",
    });
    await user.type(editor, "\nAdd more detail.");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Discard skill edits?",
    });
    expect(
      screen.getByRole("textbox", {
        name: "editing-skill skill Markdown",
      }),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Discard skill edits?" })).not.toBeInTheDocument();
    expect(
      screen.getByRole("textbox", {
        name: "editing-skill skill Markdown",
      }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    const confirmDialog = await screen.findByRole("dialog", {
      name: "Discard skill edits?",
    });
    await user.click(within(confirmDialog).getByRole("button", { name: "Discard" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", {
          name: "editing-skill skill Markdown",
        }),
      ).not.toBeInTheDocument(),
    );
  });

  it("honors a pending New Session request instead of selecting existing work", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now() }),
    );

    render(<AgentWorkspace />);

    expect(await screen.findByText(HERO_GREETING)).toBeInTheDocument();
    await waitFor(() => expect(mocks.listHermesSessions).toHaveBeenCalled());
    expect(screen.queryByText("Existing session")).toBeNull();
    expect(screen.queryByText("Existing task")).toBeNull();
    expect(window.sessionStorage.getItem(AGENT_NEW_SESSION_PENDING_KEY)).toBeNull();
  });

  it("keeps retrying startup session loads until the API is ready", async () => {
    mocks.listAgentTasks.mockResolvedValue({ items: [] });
    const startupError = new Error(
      "error sending request for url (http://127.0.0.1:65144/api/sessions?limit=100&offset=0&archived=exclude&min_messages=1&order=recent)",
    );
    mocks.listHermesSessions
      .mockRejectedValueOnce(startupError)
      .mockRejectedValueOnce(startupError)
      .mockRejectedValueOnce(startupError)
      .mockRejectedValueOnce(startupError)
      .mockRejectedValueOnce(startupError)
      .mockResolvedValueOnce([existingSession]);

    vi.useFakeTimers();
    try {
      render(<AgentWorkspace />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(mocks.listHermesSessions).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Getting June ready…")).toBeInTheDocument();
      expect(screen.queryByText(/error sending request for url/i)).toBeNull();

      for (const [delay, callCount] of [
        [250, 2],
        [500, 3],
        [1000, 4],
        [2000, 5],
        [2000, 6],
      ] as const) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(delay);
        });
        expect(mocks.listHermesSessions).toHaveBeenCalledTimes(callCount);
        expect(screen.queryByText(/June is still starting/i)).toBeNull();
        expect(screen.queryByText(/error sending request for url/i)).toBeNull();
      }

      expect(screen.getByText("Existing session")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the session loading state when a new session starts during startup retries", async () => {
    mocks.listAgentTasks.mockResolvedValue({ items: [] });
    const startupError = new Error(
      "error sending request for url (http://127.0.0.1:65144/api/sessions?limit=100&offset=0&archived=exclude&min_messages=1&order=recent)",
    );
    mocks.listHermesSessions
      .mockRejectedValueOnce(startupError)
      .mockRejectedValueOnce(startupError)
      .mockResolvedValueOnce([
        {
          id: "session-2",
          title: "Spin up a project brief",
          preview: "spin up a project brief",
          last_active: "2026-06-05T12:00:00Z",
        },
      ]);

    vi.useFakeTimers();
    try {
      render(<AgentWorkspace />);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(mocks.listHermesSessions).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Getting June ready…")).toBeInTheDocument();

      // Start a new session mid-retry. The composer is now a TipTap
      // contenteditable whose async input handling deadlocks against fake
      // timers, so drive the new-session path directly (the same code the
      // composer submit runs) with the prompt — deterministic and timer-free.
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent(AGENT_NEW_SESSION_EVENT, {
            detail: { prompt: "spin up a project brief" },
          }),
        );
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "spin up a project brief",
      });
      expect(mocks.listHermesSessions).toHaveBeenCalledTimes(2);
      expect(screen.getByText("spin up a project brief")).toBeInTheDocument();
      expect(screen.getByText("Thinking…")).toBeInTheDocument();
      expect(screen.queryByText(/error sending request for url/i)).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });

      expect(mocks.listHermesSessions).toHaveBeenCalledTimes(3);
      expect(screen.queryByText(/error sending request for url/i)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never announces the restored session as selected while a New Session is pending", async () => {
    // Regression: "New session" from inside a project arms the pending marker
    // and remounts the workspace. Initializing from the last-open restore used
    // to dispatch a mount-time sessions-changed event selecting the old
    // session, which App reads as "switched to existing work" — dropping the
    // pending project assignment before the new session exists.
    window.localStorage.setItem("june:agent:last-open-session", "session-1");
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now() }),
    );
    const sessionDetails: AgentSessionsChangedDetail[] = [];
    const onSessionsChanged = (event: Event) =>
      sessionDetails.push((event as CustomEvent<AgentSessionsChangedDetail>).detail);
    window.addEventListener(AGENT_SESSIONS_CHANGED_EVENT, onSessionsChanged);

    try {
      render(<AgentWorkspace />);

      expect(await screen.findByText(HERO_GREETING)).toBeInTheDocument();
      // The broadcast lands a few microtasks after the fetch resolves, so
      // wait for the event itself rather than just the fetch call.
      await waitFor(() => expect(sessionDetails.length).toBeGreaterThan(0));
      expect(sessionDetails.every((detail) => detail.selectedSessionId == null)).toBe(true);
    } finally {
      window.removeEventListener(AGENT_SESSIONS_CHANGED_EVENT, onSessionsChanged);
    }
  });

  it("seeds a bug report chip without submitting", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), category: "bug" }),
    );

    render(<AgentWorkspace />);

    // The composer opens tagged with a Bug report chip instead of
    // auto-submitting; the user types their report after it.
    expect(await screen.findByText("Bug report")).toBeInTheDocument();
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("session.create", expect.anything());
    expect(window.sessionStorage.getItem(AGENT_NEW_SESSION_PENDING_KEY)).toBeNull();
  });

  it("clears a stale new-session draft before seeding a report chip", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now() }),
    );

    render(<AgentWorkspace />);

    expect(await screen.findByText(HERO_GREETING)).toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "stale hero draft");

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_NEW_SESSION_EVENT, {
          detail: { category: "bug" },
        }),
      );
    });

    expect(await screen.findByText("Bug report")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).not.toHaveTextContent("stale hero draft");
  });

  it("seeds a report chip immediately when the composer is already open", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now() }),
    );

    render(<AgentWorkspace />);

    expect(await screen.findByRole("textbox")).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_NEW_SESSION_EVENT, {
          detail: { category: "bug" },
        }),
      );
    });

    expect(screen.getByText("Bug report")).toBeInTheDocument();
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("session.create", expect.anything());
  });

  it("wraps a submitted issue report for June and waits for explicit send", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), category: "bug" }),
    );
    mocks.submitIssueReport.mockResolvedValue({ received: true });

    render(<AgentWorkspace />);

    // Wait for the Bug report chip to seed, then type the report after it.
    expect(await screen.findByText("Bug report")).toBeInTheDocument();
    const composer = await screen.findByRole("textbox");
    await user.type(composer, "The recorder crashes after long meetings");
    const form = document.querySelector(".agent-composer");
    expect(form).not.toBeNull();
    fireEvent.drop(form as HTMLFormElement, {
      dataTransfer: {
        files: [new File(["png"], "screenshot.png", { type: "image/png" })],
      },
    });
    expect(await screen.findByText("screenshot.png")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start session" }));

    // June gets the investigation framing, with the user's words inside it.
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: expect.stringContaining("---USER REPORT---"),
      }),
    );
    const submitted = mocks.gatewayRequest.mock.calls.find(
      ([method]) => method === "prompt.submit",
    )?.[1] as { text: string };
    expect(submitted.text).toContain("The recorder crashes after long meetings");
    expect(submitted.text).toContain("Attached files copied into the June workspace:");
    expect(submitted.text).toContain(
      "Use these file paths when inspecting or operating on the files.",
    );
    expect(submitted.text).not.toContain("June Hermes");
    // The transcript shows the user's words only — the investigation
    // framing is plumbing between June and the runtime, never UI.
    expect(await screen.findByText(/The recorder crashes after long meetings/)).toBeInTheDocument();
    expect(screen.queryByText(/in-app reporting flow/)).toBeNull();
    expect(screen.queryByText(/---USER REPORT---/)).toBeNull();
    // The report waits for June's diagnosis; nothing is filed yet.
    expect(mocks.submitIssueReport).not.toHaveBeenCalled();

    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "user",
        content: submitted.text,
        timestamp: "2026-06-11T10:00:00Z",
      },
      {
        id: "m2",
        role: "assistant",
        content: "The screenshot shows the recorder stuck on saving.",
        timestamp: "2026-06-11T10:00:10Z",
      },
    ]);
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({ type: "turn.completed", session_id: "runtime-session-2" });
      }
    });

    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();
    expect(mocks.submitIssueReport).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Send report" }));
    expect(await screen.findByText("Sending")).toBeInTheDocument();
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(mocks.submitIssueReport).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(mocks.submitIssueReport).toHaveBeenCalledWith({
        category: "bug",
        description: "The recorder crashes after long meetings",
        agentDiagnosis: "The screenshot shows the recorder stuck on saving.",
        attachmentNames: ["screenshot.png"],
        attachmentPaths: [
          "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace/uploads/screenshot.png",
        ],
        sessionId: "session-2",
      }),
    );
    expect(await screen.findByText(/Your report was sent to the June team/)).toBeInTheDocument();
    // Drain the post-terminal refresh timer before the test ends so its
    // session refetch cannot land inside a later test's render.
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
  });

  it("does not use an old assistant reply as an existing-session report diagnosis", async () => {
    const user = userEvent.setup();
    mocks.submitIssueReport.mockResolvedValue({ received: true });
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "user",
        content: "Earlier question",
        timestamp: "2026-06-11T10:00:00Z",
      },
      {
        id: "m2",
        role: "assistant",
        content: "Earlier unrelated diagnosis.",
        timestamp: "2026-06-11T10:00:10Z",
      },
    ]);

    render(<AgentWorkspace initialSession={existingSession} />);

    await user.click(
      await screen.findByRole("button", {
        name: "Attach files or tag this message",
      }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Bug report" }));
    expect(await screen.findByText("Bug report")).toBeInTheDocument();
    await user.type(
      await screen.findByRole("textbox"),
      "The recorder crashes from this existing chat",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: expect.stringContaining("---USER REPORT---"),
      }),
    );
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({ type: "turn.completed", session_id: "runtime-session-1" });
      }
    });

    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send report" }));

    await waitFor(() =>
      expect(mocks.submitIssueReport).toHaveBeenCalledWith({
        category: "bug",
        description: "The recorder crashes from this existing chat",
        agentDiagnosis: undefined,
        attachmentNames: [],
        attachmentPaths: [],
        sessionId: "session-1",
      }),
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
  });

  it("uses created_at for existing-session report diagnosis filtering", async () => {
    const user = userEvent.setup();
    mocks.submitIssueReport.mockResolvedValue({ received: true });
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "assistant",
        content: "Earlier unrelated diagnosis.",
        timestamp: "2026-06-11T10:00:10Z",
      },
    ]);

    render(<AgentWorkspace initialSession={existingSession} />);

    await user.click(
      await screen.findByRole("button", {
        name: "Attach files or tag this message",
      }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Bug report" }));
    await user.type(
      await screen.findByRole("textbox"),
      "The recorder crashes from this existing chat",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: expect.stringContaining("---USER REPORT---"),
      }),
    );
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({ type: "turn.completed", session_id: "runtime-session-1" });
      }
    });

    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "assistant",
        content: "Earlier unrelated diagnosis.",
        timestamp: "2026-06-11T10:00:10Z",
      },
      {
        id: "m2",
        role: "assistant",
        content: "The report turn reproduced the crash.",
        created_at: Math.ceil((Date.now() + 5000) / 1000),
      },
    ]);
    await user.click(screen.getByRole("button", { name: "Send report" }));

    await waitFor(() =>
      expect(mocks.submitIssueReport).toHaveBeenCalledWith({
        category: "bug",
        description: "The recorder crashes from this existing chat",
        agentDiagnosis: "The report turn reproduced the crash.",
        attachmentNames: [],
        attachmentPaths: [],
        sessionId: "session-1",
      }),
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
  });

  it("keeps chunk boundary spaces in issue report agent diagnosis", async () => {
    const user = userEvent.setup();
    mocks.submitIssueReport.mockResolvedValue({ received: true });
    mocks.listHermesSessionMessages.mockResolvedValue([]);

    render(<AgentWorkspace initialSession={existingSession} />);

    await user.click(
      await screen.findByRole("button", {
        name: "Attach files or tag this message",
      }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Bug report" }));
    await user.type(await screen.findByRole("textbox"), "Agent response text is losing spaces");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: expect.stringContaining("---USER REPORT---"),
      }),
    );
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({ type: "turn.completed", session_id: "runtime-session-1" });
      }
    });

    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "assistant",
        content: [
          "Let me get the full",
          " details: ",
          { text: "read releases to get detailed" },
          { text: " information" },
          " more",
          " efficiently.",
        ],
        timestamp: new Date(Date.now() + 1000).toISOString(),
      },
    ]);
    await user.click(screen.getByRole("button", { name: "Send report" }));

    await waitFor(() =>
      expect(mocks.submitIssueReport).toHaveBeenCalledWith({
        category: "bug",
        description: "Agent response text is losing spaces",
        agentDiagnosis:
          "Let me get the full details: read releases to get detailed information more efficiently.",
        attachmentNames: [],
        attachmentPaths: [],
        sessionId: "session-1",
      }),
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
  });

  it("allows second-precision diagnosis timestamps near the report boundary", async () => {
    const user = userEvent.setup();
    mocks.submitIssueReport.mockResolvedValue({ received: true });
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "assistant",
        content: "The same-second diagnosis is relevant.",
        created_at: Date.parse("2026-06-11T10:00:10Z") / 1000,
      },
    ]);

    render(<AgentWorkspace initialSession={existingSession} />);

    await screen.findByRole("textbox");
    act(() => {
      window.dispatchEvent(
        new CustomEvent("june-agent-issue-report-delivery-settled", {
          detail: {
            sessionId: "session-1",
            report: {
              category: "bug",
              description: "The recorder crashes from this existing chat",
              followUps: [],
              attachmentNames: [],
              attachmentPaths: [],
              diagnosisStartedAt: "2026-06-11T10:00:10.750Z",
            },
            result: {
              sent: false,
              errorMessage: "The issue report could not be sent. Network down.",
            },
          },
        }),
      );
    });

    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send report" }));

    await waitFor(() =>
      expect(mocks.submitIssueReport).toHaveBeenCalledWith({
        category: "bug",
        description: "The recorder crashes from this existing chat",
        agentDiagnosis: "The same-second diagnosis is relevant.",
        attachmentNames: [],
        attachmentPaths: [],
        sessionId: "session-1",
      }),
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
  });

  it("sends a report when the diagnosis refresh stalls", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), category: "bug" }),
    );
    mocks.submitIssueReport.mockResolvedValue({ received: true });
    let stalledRefreshStarted = false;

    render(<AgentWorkspace />);

    expect(await screen.findByText("Bug report")).toBeInTheDocument();
    await user.type(await screen.findByRole("textbox"), "The recorder crashes after long meetings");
    await user.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: expect.stringContaining("---USER REPORT---"),
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({ type: "turn.completed", session_id: "runtime-session-2" });
      }
    });

    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "assistant",
        content: "The recorder failed while saving.",
        timestamp: new Date().toISOString(),
      },
    ]);
    mocks.listHermesSessionMessages.mockImplementationOnce(() => {
      stalledRefreshStarted = true;
      return new Promise(() => {});
    });
    await user.click(screen.getByRole("button", { name: "Send report" }));
    expect(await screen.findByText("Sending")).toBeInTheDocument();
    await waitFor(() => expect(stalledRefreshStarted).toBe(true));

    await waitFor(
      () =>
        expect(mocks.submitIssueReport).toHaveBeenCalledWith({
          category: "bug",
          description: "The recorder crashes after long meetings",
          agentDiagnosis: "The recorder failed while saving.",
          attachmentNames: [],
          attachmentPaths: [],
          sessionId: "session-2",
        }),
      { timeout: 3000 },
    );
  });

  it("appends report follow-ups before filing", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), category: "bug" }),
    );
    mocks.submitIssueReport.mockResolvedValue({ received: true });

    render(<AgentWorkspace />);

    expect(await screen.findByText("Bug report")).toBeInTheDocument();
    await user.type(await screen.findByRole("textbox"), "The recorder crashes after long meetings");
    await user.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: expect.stringContaining("---USER REPORT---"),
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({ type: "turn.completed", session_id: "runtime-session-2" });
      }
    });

    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();
    expect(mocks.submitIssueReport).not.toHaveBeenCalled();

    await user.type(await screen.findByRole("textbox"), "It also loses the transcript");
    expect(screen.getByRole("button", { name: "Send message first" })).toBeDisabled();
    expect(mocks.submitIssueReport).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      const promptSubmits = mocks.gatewayRequest.mock.calls.filter(
        ([method]) => method === "prompt.submit",
      );
      const followUpSubmit = promptSubmits[promptSubmits.length - 1]?.[1] as {
        session_id: string;
        text: string;
      };
      expect(followUpSubmit).toEqual({
        session_id: "runtime-session-2",
        text: "It also loses the transcript",
      });
    });

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({ type: "turn.completed", session_id: "runtime-session-2" });
      }
    });

    expect(await screen.findByText(/Follow-up added/)).toBeInTheDocument();
    const followUpDiagnosisAt = new Date(Date.now() + 1000).toISOString();
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "assistant",
        content: "The added note points to transcript persistence.",
        timestamp: followUpDiagnosisAt,
      },
    ]);
    await user.click(screen.getByRole("button", { name: "Send report" }));

    await waitFor(() =>
      expect(mocks.submitIssueReport).toHaveBeenCalledWith({
        category: "bug",
        description:
          "The recorder crashes after long meetings\n\nFollow-up comments:\n1. It also loses the transcript",
        agentDiagnosis: "The added note points to transcript persistence.",
        attachmentNames: [],
        attachmentPaths: [],
        sessionId: "session-2",
      }),
    );
    expect(await screen.findByText(/Your report was sent to the June team/)).toBeInTheDocument();
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
  });

  it("restores a review-ready report after leaving and returning", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), category: "bug" }),
    );
    mocks.submitIssueReport.mockResolvedValue({ received: true });
    const first = render(<AgentWorkspace />);

    expect(await screen.findByText("Bug report")).toBeInTheDocument();
    await user.type(await screen.findByRole("textbox"), "The recorder crashes after long meetings");
    await user.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: expect.stringContaining("---USER REPORT---"),
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({ type: "turn.completed", session_id: "runtime-session-2" });
      }
    });

    first.unmount();
    render(<AgentWorkspace />);

    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "assistant",
        content: "The recorder failed while saving.",
        timestamp: "2026-06-11T10:00:10Z",
      },
    ]);
    await user.click(screen.getByRole("button", { name: "Send report" }));

    await waitFor(() =>
      expect(mocks.submitIssueReport).toHaveBeenCalledWith({
        category: "bug",
        description: "The recorder crashes after long meetings",
        agentDiagnosis: "The recorder failed while saving.",
        attachmentNames: [],
        attachmentPaths: [],
        sessionId: "session-2",
      }),
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
  });

  it("restores a review-ready report after an app restart", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), category: "bug" }),
    );
    mocks.submitIssueReport.mockResolvedValue({ received: true });
    const first = render(<AgentWorkspace />);

    expect(await screen.findByText("Bug report")).toBeInTheDocument();
    await user.type(await screen.findByRole("textbox"), "The recorder crashes after long meetings");
    const form = document.querySelector(".agent-composer");
    expect(form).not.toBeNull();
    fireEvent.drop(form as HTMLFormElement, {
      dataTransfer: {
        files: [new File(["png"], "screenshot.png", { type: "image/png" })],
      },
    });
    expect(await screen.findByText("screenshot.png")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: expect.stringContaining("---USER REPORT---"),
      }),
    );
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({ type: "turn.completed", session_id: "runtime-session-2" });
      }
    });

    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();
    first.unmount();
    resetAgentSessionContinuity();
    mocks.gatewayEventHandlers.clear();

    const restoredSession = {
      id: "session-2",
      title: "Issue report",
      preview: "The recorder crashes after long meetings",
      last_active: "2026-06-11T10:00:10Z",
    };
    mocks.listHermesSessions.mockResolvedValue([restoredSession]);
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "assistant",
        content: "The recorder failed while saving.",
        timestamp: "2026-06-11T10:00:10Z",
      },
    ]);
    render(<AgentWorkspace initialSession={restoredSession} />);

    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send report" }));

    await waitFor(() =>
      expect(mocks.submitIssueReport).toHaveBeenCalledWith({
        category: "bug",
        description: "The recorder crashes after long meetings",
        agentDiagnosis: "The recorder failed while saving.",
        attachmentNames: ["screenshot.png"],
        attachmentPaths: [
          "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace/uploads/screenshot.png",
        ],
        sessionId: "session-2",
      }),
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
  });

  it("restores a pending report follow-up after leaving before June answers", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), category: "bug" }),
    );
    mocks.submitIssueReport.mockResolvedValue({ received: true });
    const first = render(<AgentWorkspace />);

    expect(await screen.findByText("Bug report")).toBeInTheDocument();
    await user.type(await screen.findByRole("textbox"), "The recorder crashes after long meetings");
    await user.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: expect.stringContaining("---USER REPORT---"),
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({ type: "turn.completed", session_id: "runtime-session-2" });
      }
    });

    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    await user.type(await screen.findByRole("textbox"), "It also drops audio");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => {
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "It also drops audio",
      });
    });

    const persistedAt = new Date().toISOString();
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "user",
        content: "The recorder crashes after long meetings",
        timestamp: persistedAt,
      },
      {
        id: "m2",
        role: "user",
        content: "It also drops audio",
        timestamp: persistedAt,
      },
      {
        id: "m3",
        role: "assistant",
        content: "The follow-up points to dropped audio persistence.",
        timestamp: persistedAt,
      },
    ]);
    first.unmount();
    render(<AgentWorkspace />);

    expect(await screen.findByText(/Follow-up added/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send report" }));

    await waitFor(() =>
      expect(mocks.submitIssueReport).toHaveBeenCalledWith({
        category: "bug",
        description:
          "The recorder crashes after long meetings\n\nFollow-up comments:\n1. It also drops audio",
        agentDiagnosis: "The follow-up points to dropped audio persistence.",
        attachmentNames: [],
        attachmentPaths: [],
        sessionId: "session-2",
      }),
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
  });

  it("does not restore a report after leaving during successful delivery", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), category: "bug" }),
    );
    let resolveDelivery: ((value: { received: boolean }) => void) | undefined;
    mocks.submitIssueReport.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDelivery = resolve;
        }),
    );
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "assistant",
        content: "The recorder failed while saving.",
        timestamp: "2026-06-11T10:00:10Z",
      },
    ]);
    const first = render(<AgentWorkspace />);

    expect(await screen.findByText("Bug report")).toBeInTheDocument();
    await user.type(await screen.findByRole("textbox"), "The recorder crashes after long meetings");
    await user.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: expect.stringContaining("---USER REPORT---"),
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({ type: "turn.completed", session_id: "runtime-session-2" });
      }
    });

    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send report" }));
    expect(await screen.findByText("Sending")).toBeInTheDocument();
    await waitFor(() => expect(mocks.submitIssueReport).toHaveBeenCalledTimes(1));

    first.unmount();
    await act(async () => {
      resolveDelivery?.({ received: true });
      await Promise.resolve();
    });
    const sessionLoadsBeforeRemount = mocks.listHermesSessions.mock.calls.length;
    render(<AgentWorkspace />);

    await waitFor(() =>
      expect(mocks.listHermesSessions.mock.calls.length).toBeGreaterThan(sessionLoadsBeforeRemount),
    );
    expect(screen.queryByText(/Report ready/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Send report" })).toBeNull();
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
  });

  it("restores a report after leaving during failed delivery", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), category: "bug" }),
    );
    let rejectDelivery: ((error: Error) => void) | undefined;
    mocks.submitIssueReport.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectDelivery = reject;
        }),
    );
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "assistant",
        content: "The recorder failed while saving.",
        timestamp: "2026-06-11T10:00:10Z",
      },
    ]);
    const first = render(<AgentWorkspace />);

    expect(await screen.findByText("Bug report")).toBeInTheDocument();
    await user.type(await screen.findByRole("textbox"), "The recorder crashes after long meetings");
    await user.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: expect.stringContaining("---USER REPORT---"),
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({ type: "turn.completed", session_id: "runtime-session-2" });
      }
    });

    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send report" }));
    expect(await screen.findByText("Sending")).toBeInTheDocument();
    await waitFor(() => expect(mocks.submitIssueReport).toHaveBeenCalledTimes(1));

    first.unmount();
    await act(async () => {
      rejectDelivery?.(new Error("network down"));
      await Promise.resolve();
    });
    const sessionLoadsBeforeRemount = mocks.listHermesSessions.mock.calls.length;
    render(<AgentWorkspace />);

    await waitFor(() =>
      expect(mocks.listHermesSessions.mock.calls.length).toBeGreaterThan(sessionLoadsBeforeRemount),
    );
    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send report" })).toBeEnabled();
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
  });

  it("keeps a newer follow-up draft when an older report delivery finishes", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), category: "bug" }),
    );
    let resolveFirstDelivery: ((value: { received: boolean }) => void) | undefined;
    mocks.submitIssueReport
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstDelivery = resolve;
          }),
      )
      .mockResolvedValue({ received: true });
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "assistant",
        content: "The recorder failed while saving.",
        timestamp: "2026-06-11T10:00:10Z",
      },
    ]);

    render(<AgentWorkspace />);

    expect(await screen.findByText("Bug report")).toBeInTheDocument();
    await user.type(await screen.findByRole("textbox"), "The recorder crashes after long meetings");
    await user.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: expect.stringContaining("---USER REPORT---"),
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({ type: "turn.completed", session_id: "runtime-session-2" });
      }
    });

    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send report" }));
    expect(await screen.findByText("Sending")).toBeInTheDocument();
    await waitFor(() => expect(mocks.submitIssueReport).toHaveBeenCalledTimes(1));

    await user.type(await screen.findByRole("textbox"), "It also drops audio");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      const promptSubmits = mocks.gatewayRequest.mock.calls.filter(
        ([method]) => method === "prompt.submit",
      );
      const followUpSubmit = promptSubmits[promptSubmits.length - 1]?.[1] as {
        session_id: string;
        text: string;
      };
      expect(followUpSubmit).toEqual({
        session_id: "runtime-session-2",
        text: "It also drops audio",
      });
    });

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({ type: "turn.completed", session_id: "runtime-session-2" });
      }
    });

    expect(await screen.findByText(/Follow-up added/)).toBeInTheDocument();
    await act(async () => {
      resolveFirstDelivery?.({ received: true });
      await Promise.resolve();
    });

    expect(await screen.findByText(/Follow-up added/)).toBeInTheDocument();
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m2",
        role: "assistant",
        content: "The follow-up points to dropped audio persistence.",
        timestamp: new Date(Date.now() + 1000).toISOString(),
      },
    ]);
    await user.click(screen.getByRole("button", { name: "Send report" }));

    await waitFor(() =>
      expect(mocks.submitIssueReport).toHaveBeenLastCalledWith({
        category: "bug",
        description:
          "The recorder crashes after long meetings\n\nFollow-up comments:\n1. It also drops audio",
        agentDiagnosis: "The follow-up points to dropped audio persistence.",
        attachmentNames: [],
        attachmentPaths: [],
        sessionId: "session-2",
      }),
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
  });

  it("does not restore a stale report when an older delivery fails during a follow-up", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), category: "bug" }),
    );
    let rejectFirstDelivery: ((error: Error) => void) | undefined;
    mocks.submitIssueReport
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirstDelivery = reject;
          }),
      )
      .mockResolvedValue({ received: true });
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "assistant",
        content: "The recorder failed while saving.",
        timestamp: "2026-06-11T10:00:10Z",
      },
    ]);

    render(<AgentWorkspace />);

    expect(await screen.findByText("Bug report")).toBeInTheDocument();
    await user.type(await screen.findByRole("textbox"), "The recorder crashes after long meetings");
    await user.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: expect.stringContaining("---USER REPORT---"),
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({ type: "turn.completed", session_id: "runtime-session-2" });
      }
    });

    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send report" }));
    expect(await screen.findByText("Sending")).toBeInTheDocument();
    await waitFor(() => expect(mocks.submitIssueReport).toHaveBeenCalledTimes(1));

    await user.type(await screen.findByRole("textbox"), "It also drops audio");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => {
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "It also drops audio",
      });
    });

    await act(async () => {
      rejectFirstDelivery?.(new Error("network down"));
      await Promise.resolve();
    });

    expect(screen.queryByRole("button", { name: "Send report" })).toBeNull();
    expect(mocks.submitIssueReport).toHaveBeenCalledTimes(1);

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({ type: "turn.completed", session_id: "runtime-session-2" });
      }
    });

    expect(await screen.findByText(/Follow-up added/)).toBeInTheDocument();
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m2",
        role: "assistant",
        content: "The follow-up points to dropped audio persistence.",
        timestamp: new Date(Date.now() + 1000).toISOString(),
      },
    ]);
    await user.click(screen.getByRole("button", { name: "Send report" }));

    await waitFor(() =>
      expect(mocks.submitIssueReport).toHaveBeenLastCalledWith({
        category: "bug",
        description:
          "The recorder crashes after long meetings\n\nFollow-up comments:\n1. It also drops audio",
        agentDiagnosis: "The follow-up points to dropped audio persistence.",
        attachmentNames: [],
        attachmentPaths: [],
        sessionId: "session-2",
      }),
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
  });

  it("does not restore a delivered report when a follow-up submit fails", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), category: "bug" }),
    );
    let resolveFirstDelivery: ((value: { received: boolean }) => void) | undefined;
    let rejectFollowUp: ((error: Error) => void) | undefined;
    mocks.submitIssueReport.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstDelivery = resolve;
        }),
    );
    mocks.gatewayRequest.mockImplementation((method: string, args?: unknown) => {
      if (method === "session.create") {
        return Promise.resolve({
          session_id: "runtime-session-2",
          stored_session_id: "session-2",
        });
      }
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (
        method === "prompt.submit" &&
        typeof args === "object" &&
        args &&
        "text" in args &&
        args.text === "It also drops audio"
      ) {
        return new Promise((_resolve, reject) => {
          rejectFollowUp = reject;
        });
      }
      return Promise.resolve({});
    });
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "assistant",
        content: "The recorder failed while saving.",
        timestamp: "2026-06-11T10:00:10Z",
      },
    ]);

    render(<AgentWorkspace />);

    expect(await screen.findByText("Bug report")).toBeInTheDocument();
    await user.type(await screen.findByRole("textbox"), "The recorder crashes after long meetings");
    await user.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: expect.stringContaining("---USER REPORT---"),
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({ type: "turn.completed", session_id: "runtime-session-2" });
      }
    });

    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send report" }));
    expect(await screen.findByText("Sending")).toBeInTheDocument();
    await waitFor(() => expect(mocks.submitIssueReport).toHaveBeenCalledTimes(1));

    await user.type(await screen.findByRole("textbox"), "It also drops audio");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "It also drops audio",
      });
    });

    await act(async () => {
      resolveFirstDelivery?.({ received: true });
      await Promise.resolve();
    });
    await act(async () => {
      rejectFollowUp?.(new Error("gateway down"));
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.queryByRole("button", { name: "Send report" })).toBeNull());
    expect(mocks.submitIssueReport).toHaveBeenCalledTimes(1);
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
  });

  it("restores a report when delivery and a follow-up submit both fail", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), category: "bug" }),
    );
    let rejectFirstDelivery: ((error: Error) => void) | undefined;
    let rejectFollowUp: ((error: Error) => void) | undefined;
    mocks.submitIssueReport.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirstDelivery = reject;
        }),
    );
    mocks.gatewayRequest.mockImplementation((method: string, args?: unknown) => {
      if (method === "session.create") {
        return Promise.resolve({
          session_id: "runtime-session-2",
          stored_session_id: "session-2",
        });
      }
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (
        method === "prompt.submit" &&
        typeof args === "object" &&
        args &&
        "text" in args &&
        args.text === "It also drops audio"
      ) {
        return new Promise((_resolve, reject) => {
          rejectFollowUp = reject;
        });
      }
      return Promise.resolve({});
    });
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "assistant",
        content: "The recorder failed while saving.",
        timestamp: "2026-06-11T10:00:10Z",
      },
    ]);

    render(<AgentWorkspace />);

    expect(await screen.findByText("Bug report")).toBeInTheDocument();
    await user.type(await screen.findByRole("textbox"), "The recorder crashes after long meetings");
    await user.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: expect.stringContaining("---USER REPORT---"),
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({ type: "turn.completed", session_id: "runtime-session-2" });
      }
    });

    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send report" }));
    expect(await screen.findByText("Sending")).toBeInTheDocument();
    await waitFor(() => expect(mocks.submitIssueReport).toHaveBeenCalledTimes(1));

    await user.type(await screen.findByRole("textbox"), "It also drops audio");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => {
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "It also drops audio",
      });
    });

    await act(async () => {
      rejectFirstDelivery?.(new Error("network down"));
      await Promise.resolve();
    });
    expect(screen.queryByRole("button", { name: "Send report" })).toBeNull();

    await act(async () => {
      rejectFollowUp?.(new Error("gateway down"));
      await Promise.resolve();
    });

    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message first" })).toBeDisabled();
    expect(mocks.submitIssueReport).toHaveBeenCalledTimes(1);
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
  });

  it("restores a report when a follow-up submit fails before delivery starts", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), category: "bug" }),
    );
    mocks.gatewayRequest.mockImplementation((method: string, args?: unknown) => {
      if (method === "session.create") {
        return Promise.resolve({
          session_id: "runtime-session-2",
          stored_session_id: "session-2",
        });
      }
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (
        method === "prompt.submit" &&
        typeof args === "object" &&
        args &&
        "text" in args &&
        args.text === "It also drops audio"
      ) {
        return Promise.reject(new Error("gateway down"));
      }
      return Promise.resolve({});
    });

    render(<AgentWorkspace />);

    expect(await screen.findByText("Bug report")).toBeInTheDocument();
    await user.type(await screen.findByRole("textbox"), "The recorder crashes after long meetings");
    await user.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: expect.stringContaining("---USER REPORT---"),
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({ type: "turn.completed", session_id: "runtime-session-2" });
      }
    });

    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();
    await user.type(await screen.findByRole("textbox"), "It also drops audio");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "It also drops audio",
      });
    });
    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message first" })).toBeDisabled();
    expect(mocks.submitIssueReport).not.toHaveBeenCalled();
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
  });

  it("restores a report after leaving during a failed follow-up submit", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), category: "bug" }),
    );
    let rejectFollowUp: ((error: Error) => void) | undefined;
    mocks.gatewayRequest.mockImplementation((method: string, args?: unknown) => {
      if (method === "session.create") {
        return Promise.resolve({
          session_id: "runtime-session-2",
          stored_session_id: "session-2",
        });
      }
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (
        method === "prompt.submit" &&
        typeof args === "object" &&
        args &&
        "text" in args &&
        args.text === "It also drops audio"
      ) {
        return new Promise((_resolve, reject) => {
          rejectFollowUp = reject;
        });
      }
      return Promise.resolve({});
    });

    const first = render(<AgentWorkspace />);

    expect(await screen.findByText("Bug report")).toBeInTheDocument();
    await user.type(await screen.findByRole("textbox"), "The recorder crashes after long meetings");
    await user.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: expect.stringContaining("---USER REPORT---"),
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({ type: "turn.completed", session_id: "runtime-session-2" });
      }
    });

    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();
    await user.type(await screen.findByRole("textbox"), "It also drops audio");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => {
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "It also drops audio",
      });
      expect(rejectFollowUp).toBeDefined();
    });

    first.unmount();
    await act(async () => {
      rejectFollowUp?.(new Error("gateway down"));
      await Promise.resolve();
    });

    const sessionLoadsBeforeRemount = mocks.listHermesSessions.mock.calls.length;
    render(<AgentWorkspace />);
    await waitFor(() =>
      expect(mocks.listHermesSessions.mock.calls.length).toBeGreaterThan(sessionLoadsBeforeRemount),
    );

    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();
    expect(screen.queryByText(/Follow-up added/)).toBeNull();
    expect(screen.getByRole("button", { name: "Send message first" })).toBeDisabled();
    expect(mocks.submitIssueReport).not.toHaveBeenCalled();
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
  });

  it("does not promote a queued report follow-up after resume fails", async () => {
    const user = userEvent.setup();
    const report = {
      category: "bug" as const,
      description: "The recorder crashes after long meetings",
      followUps: [],
      attachmentNames: [],
      attachmentPaths: [],
    };
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.reject(new Error("runtime mapping lost"));
      }
      return Promise.resolve({});
    });
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "assistant",
        content: "The recorder failed while saving.",
        timestamp: "2026-06-11T10:00:10Z",
      },
    ]);

    const { unmount } = render(<AgentWorkspace initialSession={existingSession} />);

    await screen.findByRole("textbox");
    act(() => {
      window.dispatchEvent(
        new CustomEvent("june-agent-issue-report-delivery-settled", {
          detail: {
            sessionId: "session-1",
            report,
            result: {
              sent: false,
              errorMessage: "The issue report could not be sent. Network down.",
            },
          },
        }),
      );
    });

    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();
    await user.type(await screen.findByRole("textbox"), "It also drops audio");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.resume", {
        session_id: "session-1",
        cols: 96,
      }),
    );
    expect(await screen.findByText("runtime mapping lost")).toBeInTheDocument();
    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();
    expect(screen.queryByText(/Follow-up added/)).toBeNull();

    const messageFetchesBeforeRemount = mocks.listHermesSessionMessages.mock.calls.length;
    unmount();
    render(<AgentWorkspace initialSession={existingSession} />);
    await waitFor(() =>
      expect(mocks.listHermesSessionMessages.mock.calls.length).toBeGreaterThan(
        messageFetchesBeforeRemount,
      ),
    );
    await act(() => Promise.resolve());

    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();
    expect(screen.queryByText(/Follow-up added/)).toBeNull();
    expect(screen.getByRole("button", { name: "Send message first" })).toBeDisabled();
  });

  it("does not show a failed issue report banner after switching away", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), category: "bug" }),
    );
    let rejectIssueReport: ((error: Error) => void) | undefined;
    mocks.submitIssueReport.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectIssueReport = reject;
        }),
    );

    render(<AgentWorkspace />);

    expect(await screen.findByText("Bug report")).toBeInTheDocument();
    await user.type(await screen.findByRole("textbox"), "The recorder crashes after long meetings");
    await user.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: expect.stringContaining("---USER REPORT---"),
      }),
    );

    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "user",
        content: "The recorder crashes after long meetings",
        timestamp: "2026-06-11T10:00:00Z",
      },
      {
        id: "m2",
        role: "assistant",
        content: "The recorder failed while saving.",
        timestamp: "2026-06-11T10:00:10Z",
      },
    ]);
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({ type: "turn.completed", session_id: "runtime-session-2" });
      }
    });
    await user.click(await screen.findByRole("button", { name: "Send report" }));
    await waitFor(() => expect(mocks.submitIssueReport).toHaveBeenCalled());

    act(() => {
      window.dispatchEvent(new CustomEvent(AGENT_NEW_SESSION_EVENT));
    });
    expect(await screen.findByText(HERO_GREETING)).toBeInTheDocument();

    await act(async () => {
      rejectIssueReport?.(new Error("upstream_provider_failed"));
      await Promise.resolve();
    });

    expect(screen.queryByText(/The issue report could not be sent/)).toBeNull();
    expect(screen.queryByText(/upstream_provider_failed/)).toBeNull();
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
  });

  it("clears a failed issue report banner after a successful retry", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), category: "bug" }),
    );
    mocks.submitIssueReport
      .mockRejectedValueOnce(new Error("upstream_provider_failed"))
      .mockResolvedValue({ received: true });
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "assistant",
        content: "The recorder failed while saving.",
        timestamp: "2026-06-11T10:00:10Z",
      },
    ]);

    render(<AgentWorkspace />);

    expect(await screen.findByText("Bug report")).toBeInTheDocument();
    await user.type(await screen.findByRole("textbox"), "The recorder crashes after long meetings");
    await user.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: expect.stringContaining("---USER REPORT---"),
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({ type: "turn.completed", session_id: "runtime-session-2" });
      }
    });

    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send report" }));
    expect(await screen.findByText("Sending")).toBeInTheDocument();
    expect(await screen.findByText(/The issue report could not be sent/)).toBeInTheDocument();
    expect(screen.getByText(/upstream_provider_failed/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send report" }));

    expect(await screen.findByText(/Your report was sent to the June team/)).toBeInTheDocument();
    expect(screen.queryByText(/The issue report could not be sent/)).toBeNull();
    expect(screen.queryByText(/upstream_provider_failed/)).toBeNull();
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
  });

  it("keeps report sending disabled while attachment imports are pending", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), category: "bug" }),
    );
    let resolveImport:
      | ((file: {
          name: string;
          path: string;
          rootLabel: string;
          size: number;
          previewDataUrl: null;
        }) => void)
      | undefined;
    mocks.importHermesBridgeFileBytes.mockImplementationOnce((name: string) =>
      new Promise((resolve) => {
        resolveImport = resolve;
      }).then(() => ({
        name,
        path: `/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace/uploads/${name}`,
        rootLabel: "Workspace",
        size: 5,
        previewDataUrl: null,
      })),
    );
    mocks.submitIssueReport.mockResolvedValue({ received: true });

    render(<AgentWorkspace />);

    expect(await screen.findByText("Bug report")).toBeInTheDocument();
    await user.type(await screen.findByRole("textbox"), "The recorder crashes after long meetings");
    await user.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: expect.stringContaining("---USER REPORT---"),
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({ type: "turn.completed", session_id: "runtime-session-2" });
      }
    });

    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));

    const form = document.querySelector(".agent-composer");
    expect(form).not.toBeNull();
    fireEvent.drop(form as HTMLFormElement, {
      dataTransfer: {
        files: [new File(["logs"], "logs.txt", { type: "text/plain" })],
      },
    });

    await waitFor(() =>
      expect(mocks.importHermesBridgeFileBytes).toHaveBeenCalledWith(
        "logs.txt",
        expect.any(Uint8Array),
      ),
    );
    expect(screen.getByRole("button", { name: "Attaching files" })).toBeDisabled();
    expect(mocks.submitIssueReport).not.toHaveBeenCalled();

    await act(async () => {
      resolveImport?.({
        name: "logs.txt",
        path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace/uploads/logs.txt",
        rootLabel: "Workspace",
        size: 5,
        previewDataUrl: null,
      });
      await Promise.resolve();
    });

    expect(await screen.findByText("logs.txt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message first" })).toBeDisabled();
    expect(mocks.submitIssueReport).not.toHaveBeenCalled();
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
  });

  it("labels anonymous-only agent models as anonymous mode", async () => {
    mocks.providerModelSettings.mockResolvedValue({
      settings: {
        transcriptionProvider: "venice",
        transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
        generationModel: "anonymous-only",
      },
    });
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: "anonymous-only",
      models: [
        {
          provider: "venice",
          id: "anonymous-only",
          name: "Anonymous Only",
          modelType: "text",
          privacy: "anonymous",
          traits: [],
          capabilities: [],
        },
      ],
    });

    render(<AgentWorkspace initialSession={existingSession} />);

    expect(await screen.findByText("Anonymous mode")).toBeInTheDocument();
    // The session bar badge carries the privacy mode alone; the model name
    // lives on the composer's model trigger. The badge's accessible name
    // carries the mode description.
    expect(screen.getByRole("button", { name: "Model: Anonymous Only" })).toBeInTheDocument();
    expect(
      screen.getByLabelText(new RegExp(`^Anonymous mode - ${ANONYMOUS_MODEL_DESCRIPTION}`)),
    ).toBeInTheDocument();
    expect(screen.queryByText("Private mode")).not.toBeInTheDocument();
  });

  it("labels e2ee models over private and explains the mode on hover", async () => {
    mocks.providerModelSettings.mockResolvedValue({
      settings: {
        transcriptionProvider: "venice",
        transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
        generationModel: "e2ee-glm",
      },
    });
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: "e2ee-glm",
      models: [
        {
          provider: "venice",
          id: "e2ee-glm",
          name: "E2EE GLM",
          modelType: "text",
          privacy: "private",
          traits: [],
          capabilities: ["e2ee"],
        },
      ],
    });

    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={existingSession} />);

    const badge = await screen.findByText("E2EE");
    expect(screen.queryByText("Private mode")).not.toBeInTheDocument();

    // The hover callout replaces the native title tooltip.
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.hover(badge);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(E2EE_MODEL_DESCRIPTION);
    await user.unhover(badge);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
  });

  it("opens the model picker from the composer's model trigger", async () => {
    const user = userEvent.setup();

    render(<AgentWorkspace initialSession={existingSession} />);

    // The session composer carries the same model trigger as the hero.
    await user.click(await screen.findByRole("button", { name: "Model: GLM 5.2" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Choose text model",
    });
    expect(within(dialog).getByRole("option", { name: /GLM 5\.2/ })).toBeInTheDocument();
  });

  it("switches the text model only for the active chat", async () => {
    // Tool-capable catalog: the picker refuses tool-less models for the
    // agent, so the switch target must support function calling.
    const catalog = [
      {
        provider: "venice",
        id: "zai-org-glm-5-2",
        name: "GLM 5.2",
        modelType: "text",
        privacy: "private",
        traits: [],
        capabilities: ["functionCalling"],
      },
      {
        provider: "venice",
        id: "kimi-k2-6",
        name: "Kimi K2.6",
        modelType: "text",
        privacy: "private",
        traits: [],
        capabilities: ["functionCalling"],
      },
      {
        provider: "venice",
        id: "anonymous-only",
        name: "Anonymous Only",
        modelType: "text",
        privacy: "anonymous",
        traits: [],
        capabilities: ["functionCalling"],
      },
    ];
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: "zai-org-glm-5-2",
      models: catalog,
    });
    const user = userEvent.setup();

    render(<AgentWorkspace initialSession={existingSession} />);

    await user.click(await screen.findByRole("button", { name: "Model: GLM 5.2" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Choose text model",
    });

    // The popover opens on the suggested picks (GLM 5.2 is curated); the
    // switch target only exists in the full catalog behind All models.
    await user.click(within(dialog).getByRole("button", { name: "All models" }));
    const panel = await screen.findByRole("group", {
      name: "All text models",
    });
    await user.click(within(panel).getByRole("option", { name: /Anonymous Only/ }));

    expect(mocks.setVeniceModel).not.toHaveBeenCalled();
    // The composer trigger reflects the new model and the session bar badge
    // its privacy mode.
    expect(
      await screen.findByRole("button", { name: "Model: Anonymous Only" }),
    ).toBeInTheDocument();
    expect(mocks.ensureHermesBridgeSession).not.toHaveBeenCalledWith({
      sessionId: "session-1",
      model: "anonymous-only",
    });
    expect(await screen.findByText("Anonymous mode")).toBeInTheDocument();
    expect(screen.queryByText("Private mode")).not.toBeInTheDocument();
  });

  it("keeps another active chat on its own model after switching the current chat", async () => {
    const catalog = [
      {
        provider: "venice",
        id: "zai-org-glm-5-2",
        name: "GLM 5.2",
        modelType: "text",
        privacy: "private",
        traits: [],
        capabilities: ["functionCalling"],
      },
      {
        provider: "venice",
        id: "kimi-k2-6",
        name: "Kimi K2.6",
        modelType: "text",
        privacy: "private",
        traits: [],
        capabilities: ["functionCalling"],
      },
      {
        provider: "venice",
        id: "anonymous-only",
        name: "Anonymous Only",
        modelType: "text",
        privacy: "anonymous",
        traits: [],
        capabilities: ["functionCalling"],
      },
    ];
    const secondSession = {
      ...existingSession,
      id: "session-2",
      title: "Second session",
      preview: "Second preview",
      last_active: "2026-06-04T12:05:00Z",
      model: "kimi-k2-6",
    };
    mocks.listHermesSessions.mockResolvedValue([existingSession, secondSession]);
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: "zai-org-glm-5-2",
      models: catalog,
    });
    const user = userEvent.setup();

    const { rerender } = render(<AgentWorkspace initialSession={existingSession} />);

    await user.click(await screen.findByRole("button", { name: "Model: GLM 5.2" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Choose text model",
    });
    await user.click(within(dialog).getByRole("button", { name: "All models" }));
    const panel = await screen.findByRole("group", {
      name: "All text models",
    });
    await user.click(within(panel).getByRole("option", { name: /Anonymous Only/ }));

    expect(
      await screen.findByRole("button", { name: "Model: Anonymous Only" }),
    ).toBeInTheDocument();

    rerender(<AgentWorkspace initialSession={secondSession} />);

    expect(await screen.findByRole("button", { name: "Model: Kimi K2.6" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Model: Anonymous Only" })).not.toBeInTheDocument();
  });

  it("keeps an existing chat model when generation model settings change", async () => {
    render(<AgentWorkspace initialSession={existingSession} />);

    expect(await screen.findByText("Private mode")).toBeInTheDocument();

    mocks.providerModelSettings.mockResolvedValue({
      settings: {
        transcriptionProvider: "venice",
        transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
        generationModel: "anonymous-only",
      },
    });
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: "anonymous-only",
      models: [
        {
          provider: "venice",
          id: "zai-org-glm-5-2",
          name: "GLM 5.2",
          modelType: "text",
          privacy: "private",
          traits: [],
          capabilities: ["functionCalling"],
        },
        {
          provider: "venice",
          id: "anonymous-only",
          name: "Anonymous Only",
          modelType: "text",
          privacy: "anonymous",
          traits: [],
          capabilities: [],
        },
      ],
    });

    act(() => {
      window.dispatchEvent(
        new CustomEvent(PROVIDER_MODEL_SETTINGS_CHANGED_EVENT, {
          detail: { mode: "generation", modelId: "anonymous-only" },
        }),
      );
    });

    expect(await screen.findByText("Private mode")).toBeInTheDocument();
    expect(screen.queryByText("Anonymous mode")).not.toBeInTheDocument();
  });

  it("keeps late-loaded existing chats on the default they first inherited", async () => {
    const catalog = [
      {
        provider: "venice",
        id: "zai-org-glm-5-2",
        name: "GLM 5.2",
        modelType: "text",
        privacy: "private",
        traits: [],
        capabilities: ["functionCalling"],
      },
      {
        provider: "venice",
        id: "anonymous-only",
        name: "Anonymous Only",
        modelType: "text",
        privacy: "anonymous",
        traits: [],
        capabilities: ["functionCalling"],
      },
    ];
    const sessionResolvers: Array<(sessions: (typeof existingSession)[]) => void> = [];
    mocks.listAgentTasks.mockResolvedValue({ items: [] });
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: "zai-org-glm-5-2",
      models: catalog,
    });
    mocks.listHermesSessions.mockImplementation(
      () =>
        new Promise<(typeof existingSession)[]>((resolve) => {
          sessionResolvers.push(resolve);
        }),
    );

    render(<AgentWorkspace />);

    expect(await screen.findByRole("button", { name: "Model: GLM 5.2" })).toBeInTheDocument();
    await waitFor(() => expect(sessionResolvers.length).toBeGreaterThan(0));

    mocks.listHermesSessions.mockResolvedValue([existingSession]);
    await act(async () => {
      for (const resolveSessions of sessionResolvers) {
        resolveSessions([existingSession]);
      }
    });
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    const settingsCalls = mocks.providerModelSettings.mock.calls.length;
    const modelListCalls = mocks.listVeniceModels.mock.calls.length;
    mocks.providerModelSettings.mockResolvedValue({
      settings: {
        transcriptionProvider: "venice",
        transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
        generationModel: "anonymous-only",
      },
    });
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: "anonymous-only",
      models: catalog,
    });
    act(() => {
      window.dispatchEvent(
        new CustomEvent(PROVIDER_MODEL_SETTINGS_CHANGED_EVENT, {
          detail: { mode: "generation", modelId: "anonymous-only" },
        }),
      );
    });

    await waitFor(() =>
      expect(mocks.providerModelSettings.mock.calls.length).toBeGreaterThan(settingsCalls),
    );
    await waitFor(() =>
      expect(mocks.listVeniceModels.mock.calls.length).toBeGreaterThan(modelListCalls),
    );
    expect(screen.getByRole("button", { name: "Model: GLM 5.2" })).toBeInTheDocument();
    expect(screen.queryByText("Anonymous mode")).not.toBeInTheDocument();
  });

  it("keeps an explicit chat model when a refresh returns a stale server model", async () => {
    const catalog = [
      {
        provider: "venice",
        id: "zai-org-glm-5-2",
        name: "GLM 5.2",
        modelType: "text",
        privacy: "private",
        traits: [],
        capabilities: ["functionCalling"],
      },
      {
        provider: "venice",
        id: "anonymous-only",
        name: "Anonymous Only",
        modelType: "text",
        privacy: "anonymous",
        traits: [],
        capabilities: ["functionCalling"],
      },
    ];
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: "zai-org-glm-5-2",
      models: catalog,
    });
    const user = userEvent.setup();

    render(<AgentWorkspace initialSession={existingSession} />);

    await user.click(await screen.findByRole("button", { name: "Model: GLM 5.2" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Choose text model",
    });
    await user.click(within(dialog).getByRole("button", { name: "All models" }));
    const panel = await screen.findByRole("group", {
      name: "All text models",
    });
    await user.click(within(panel).getByRole("option", { name: /Anonymous Only/ }));
    expect(
      await screen.findByRole("button", { name: "Model: Anonymous Only" }),
    ).toBeInTheDocument();

    const sessionListCalls = mocks.listHermesSessions.mock.calls.length;
    mocks.listHermesSessions.mockResolvedValue([{ ...existingSession, model: "zai-org-glm-5-2" }]);

    await user.type(screen.getByRole("textbox"), "continue");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(mocks.listHermesSessions.mock.calls.length).toBeGreaterThan(sessionListCalls),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Model: Anonymous Only" })).toBeInTheDocument(),
    );
    expect(screen.queryByText("Private mode")).not.toBeInTheDocument();
  });

  it("uses the new-chat composer picker to update the default model", async () => {
    const catalog = [
      {
        provider: "venice",
        id: "zai-org-glm-5-2",
        name: "GLM 5.2",
        modelType: "text",
        privacy: "private",
        traits: [],
        capabilities: ["functionCalling"],
      },
      {
        provider: "venice",
        id: "anonymous-only",
        name: "Anonymous Only",
        modelType: "text",
        privacy: "anonymous",
        traits: [],
        capabilities: ["functionCalling"],
      },
    ];
    mocks.listAgentTasks.mockResolvedValue({ items: [] });
    mocks.listHermesSessions.mockResolvedValue([]);
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: "zai-org-glm-5-2",
      models: catalog,
    });
    const user = userEvent.setup();

    render(<AgentWorkspace />);

    await user.click(await screen.findByRole("button", { name: "Model: GLM 5.2" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Choose text model",
    });
    await user.click(within(dialog).getByRole("button", { name: "All models" }));
    const panel = await screen.findByRole("group", {
      name: "All text models",
    });
    await user.click(within(panel).getByRole("option", { name: /Anonymous Only/ }));

    await waitFor(() =>
      expect(mocks.setVeniceModel).toHaveBeenCalledWith("generation", "anonymous-only"),
    );
    expect(mocks.ensureHermesBridgeSession).not.toHaveBeenCalledWith({
      sessionId: expect.any(String),
      model: "anonymous-only",
    });
  });

  it("ignores a stale pending New Session marker left over from a reload", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({
        createdAt: Date.now() - 60_000,
        prompt: "stale prompt from before the reload",
      }),
    );

    render(<AgentWorkspace />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    expect(window.sessionStorage.getItem(AGENT_NEW_SESSION_PENDING_KEY)).toBeNull();
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith(
      "prompt.submit",
      expect.objectContaining({ text: "stale prompt from before the reload" }),
    );
  });

  it("submits a double-delivered New Session prompt only once", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), prompt: "audit the repo" }),
    );

    render(<AgentWorkspace />);

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "audit the repo",
      }),
    );

    // App.tsx marks the pending marker AND fires the window event in a
    // setTimeout — the event lands after the mount already consumed the
    // marker. The echo must not create a second session.
    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_NEW_SESSION_EVENT, {
          detail: { prompt: "audit the repo" },
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const sessionCreates = mocks.gatewayRequest.mock.calls.filter(
      ([method]) => method === "session.create",
    );
    expect(sessionCreates).toHaveLength(1);
  });

  it("restores the last open session after a reload", async () => {
    window.localStorage.setItem("june:agent:last-open-session", "session-1");
    mocks.listHermesSessions.mockResolvedValue([
      {
        id: "session-2",
        title: "Newer session",
        preview: "More recent work",
        last_active: "2026-06-05T12:00:00Z",
      },
      existingSession,
    ]);

    render(<AgentWorkspace />);

    // Without the restore, the workspace would select the newest session
    // (session-2); the persisted id must win — the restored session's title
    // is the one in the session bar and its messages are the ones fetched.
    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await waitFor(() => expect(mocks.listHermesSessionMessages).toHaveBeenCalledWith("session-1"));
    expect(mocks.listHermesSessionMessages).not.toHaveBeenCalledWith("session-2");
    expect(screen.queryByText("Newer session")).toBeNull();
  });

  it("honors an initial session id before session metadata is available", async () => {
    mocks.listHermesSessions.mockResolvedValue([
      {
        id: "session-2",
        title: "Newer session",
        preview: "More recent work",
        last_active: "2026-06-05T12:00:00Z",
      },
      existingSession,
    ]);

    render(<AgentWorkspace initialSessionId="session-1" />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await waitFor(() => expect(mocks.listHermesSessionMessages).toHaveBeenCalledWith("session-1"));
    expect(mocks.listHermesSessionMessages).not.toHaveBeenCalledWith("session-2");
    expect(screen.queryByText("Newer session")).toBeNull();
  });

  it("restores an in-flight new session across a remount (settings round trip)", async () => {
    // Start a brand-new session whose first turn is still running: Hermes has
    // persisted nothing yet (no messages, absent from the server session
    // list), so every trace of the run lives in component state. Navigating
    // to Settings and back unmounts and remounts the workspace — without the
    // continuity snapshot the session came back as an empty "Untitled
    // session" that nothing ever refreshed.
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), prompt: "audit the repo" }),
    );
    const first = render(<AgentWorkspace />);
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "audit the repo",
      }),
    );
    expect(await screen.findByText("audit the repo")).toBeInTheDocument();
    expect(await screen.findByText("Summarize Current Page")).toBeInTheDocument();

    first.unmount();
    render(<AgentWorkspace />);

    // The sent message and the session title survive the round trip.
    expect(await screen.findByText("audit the repo")).toBeInTheDocument();
    expect(await screen.findByText("Summarize Current Page")).toBeInTheDocument();
    expect(screen.queryByText("Untitled session")).toBeNull();
    // The run is still treated as working, so the reconcile poll can pick it
    // up: the composer offers the stop control instead of an idle send.
    expect(await screen.findByRole("button", { name: "Stop June" })).toBeInTheDocument();
  });

  it("renames prompt-like existing session titles after messages load", async () => {
    const rawTitle = "I want you to keep this running inside my CLI";
    mocks.listHermesSessions.mockResolvedValue([
      {
        id: "session-raw",
        title: rawTitle,
        preview: rawTitle,
        last_active: "2026-06-04T12:00:00Z",
      },
    ]);
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "message-1",
        role: "user",
        content: rawTitle,
        timestamp: "2026-06-04T12:00:00Z",
      },
    ]);
    mocks.suggestAgentSessionTitle.mockResolvedValue({
      title: "CLI Run Tracking",
    });

    render(<AgentWorkspace />);

    expect(await screen.findByText("CLI Run Tracking")).toBeInTheDocument();
  });

  it("keeps chunk boundary spaces when suggesting session titles", async () => {
    const rawTitle = "I want you to find the release details";
    mocks.listHermesSessions.mockResolvedValue([
      {
        id: "session-raw",
        title: rawTitle,
        preview: rawTitle,
        last_active: "2026-06-04T12:00:00Z",
      },
    ]);
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "message-1",
        role: "user",
        content: ["Find the full", " details", " more", " efficiently"],
        timestamp: "2026-06-04T12:00:00Z",
      },
    ]);
    mocks.suggestAgentSessionTitle.mockResolvedValue({
      title: "Release Details",
    });

    render(<AgentWorkspace />);

    expect(await screen.findByText("Release Details")).toBeInTheDocument();
    expect(mocks.suggestAgentSessionTitle).toHaveBeenCalledWith(
      "Find the full details more efficiently",
    );
  });

  it("renders June's CLI access request as a card and enables the setting", async () => {
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "u1",
        role: "user",
        content: "use the codex cli to say hi",
        timestamp: "2026-06-12T10:00:00Z",
      },
      {
        id: "a1",
        role: "assistant",
        content: "The sandbox blocks Codex's state folders.\n\n[REQUEST:AGENT_CLI_ACCESS]",
        timestamp: "2026-06-12T10:00:05Z",
      },
    ]);
    mocks.setHermesAgentCliAccess.mockResolvedValue({ enabled: true });
    const user = userEvent.setup();

    render(<AgentWorkspace initialSession={existingSession} />);

    expect(await screen.findByText("Agent CLI access requested")).toBeInTheDocument();
    // The token renders as the card, never as literal text.
    expect(screen.queryByText(/REQUEST:AGENT_CLI_ACCESS/)).toBeNull();
    expect(screen.getByText(/sandbox blocks Codex's state folders/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Enable Agent CLI access" }));

    await waitFor(() => expect(mocks.setHermesAgentCliAccess).toHaveBeenCalledWith(true));
    // June is told the grant is live, so it retries on the restarted runtime.
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: expect.stringContaining("I enabled Agent CLI access"),
      }),
    );
    expect(await screen.findByText("Agent CLI access enabled")).toBeInTheDocument();
  });

  it("shows the CLI access request as already granted when the setting is on", async () => {
    mocks.hermesAgentCliAccess.mockResolvedValue({ enabled: true });
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "a1",
        role: "assistant",
        content: "[REQUEST:AGENT_CLI_ACCESS]",
        timestamp: "2026-06-12T10:00:05Z",
      },
    ]);

    render(<AgentWorkspace initialSession={existingSession} />);

    expect(await screen.findByText("Agent CLI access requested")).toBeInTheDocument();
    expect(await screen.findByText("Agent CLI access enabled")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable Agent CLI access" })).toBeNull();
  });

  it("dismisses the CLI access request without changing the setting", async () => {
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "a1",
        role: "assistant",
        content: "Codex is blocked.\n\n[REQUEST:AGENT_CLI_ACCESS]",
        timestamp: "2026-06-12T10:00:05Z",
      },
    ]);
    const user = userEvent.setup();

    render(<AgentWorkspace initialSession={existingSession} />);

    await user.click(await screen.findByRole("button", { name: "Not now" }));

    expect(mocks.setHermesAgentCliAccess).not.toHaveBeenCalled();
    // The card resolves quietly; nothing is sent into the session.
    expect(await screen.findByText("Not now")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable Agent CLI access" })).toBeNull();
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", expect.anything());
  });

  it("copies visible user and assistant messages", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "u1",
        role: "user",
        content: "Draft the launch plan",
        timestamp: "2026-06-12T10:00:00Z",
      },
      {
        id: "a1",
        role: "assistant",
        content: "Here is the launch plan.",
        timestamp: "2026-06-12T10:00:05Z",
      },
    ]);

    try {
      render(<AgentWorkspace initialSession={existingSession} />);

      const userTurn = (await screen.findByText("Draft the launch plan")).closest("article");
      const assistantTurn = (await screen.findByText("Here is the launch plan.")).closest(
        "article",
      );
      expect(userTurn).not.toBeNull();
      expect(assistantTurn).not.toBeNull();

      await user.click(
        within(assistantTurn as HTMLElement).getByRole("button", {
          name: "Copy message",
        }),
      );
      expect(writeText).toHaveBeenLastCalledWith("Here is the launch plan.");

      await user.click(
        within(userTurn as HTMLElement).getByRole("button", {
          name: "Copy message",
        }),
      );
      expect(writeText).toHaveBeenLastCalledWith("Draft the launch plan");
    } finally {
      writeText.mockRestore();
    }
  });

  it("prefills a user prompt for editing and resubmits the revision", async () => {
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "u1",
        role: "user",
        content: "Draft the launch plan",
        timestamp: "2026-06-12T10:00:00Z",
      },
      {
        id: "a1",
        role: "assistant",
        content: "Here is the launch plan.",
        timestamp: "2026-06-12T10:00:05Z",
      },
    ]);
    const user = userEvent.setup();

    render(<AgentWorkspace initialSession={existingSession} />);

    const userTurn = (await screen.findByText("Draft the launch plan")).closest("article");
    expect(userTurn).not.toBeNull();
    await user.click(
      within(userTurn as HTMLElement).getByRole("button", {
        name: "Edit message",
      }),
    );

    const composer = screen.getByRole("textbox");
    expect(composer).toHaveTextContent("Draft the launch plan");
    await user.type(composer, " for sales");

    const send = screen.getByRole("button", { name: "Send message" });
    await waitFor(() => expect(send).not.toBeDisabled());
    await user.click(send);

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "Draft the launch plan for sales",
      }),
    );
  });

  it("repairs gateway-glued contractions in assistant prose but not code or user text", async () => {
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "u1",
        role: "user",
        content: "what'sthere",
        timestamp: "2026-06-04T12:00:00Z",
      },
      {
        id: "a1",
        role: "assistant",
        content: "Here'swhat I found. Run `git'sstatus` to check.",
        timestamp: "2026-06-04T12:00:01Z",
      },
    ]);

    render(<AgentWorkspace initialSession={existingSession} />);

    // Assistant prose is de-glued…
    expect(await screen.findByText(/Here's what I found/)).toBeInTheDocument();
    // …but an inline code span keeps the agent's literal text…
    expect(screen.getByText("git'sstatus")).toBeInTheDocument();
    // …and the user's own message is never rewritten.
    expect(screen.getByText("what'sthere")).toBeInTheDocument();
  });

  it("keeps generated titles that begin with past-tense request words", async () => {
    const generatedTitle = "I Wanted Outcomes";
    mocks.listHermesSessions.mockResolvedValue([
      {
        id: "session-generated",
        title: generatedTitle,
        preview: "Finished planning outcomes",
        last_active: "2026-06-04T12:00:00Z",
      },
    ]);
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "message-1",
        role: "user",
        content: "plan outcomes",
        timestamp: "2026-06-04T12:00:00Z",
      },
    ]);

    render(<AgentWorkspace />);

    expect(await screen.findByText(generatedTitle)).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.listHermesSessionMessages).toHaveBeenCalledWith("session-generated"),
    );
    expect(mocks.suggestAgentSessionTitle).not.toHaveBeenCalled();
  });

  it("forgets the persisted session when it is deleted", async () => {
    // The Unrestricted record must die with the session too — deletions
    // arriving via the sidebar event included — or a future session that
    // recycled the id would inherit full write access.
    window.localStorage.setItem(
      "june.agent.unrestrictedSessions",
      JSON.stringify({ "session-1": true }),
    );
    render(<AgentWorkspace />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await waitFor(() =>
      expect(window.localStorage.getItem("june:agent:last-open-session")).toBe("session-1"),
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_DELETE_SESSION_EVENT, {
          detail: { sessionId: "session-1" },
        }),
      );
    });

    await waitFor(() =>
      expect(window.localStorage.getItem("june:agent:last-open-session")).toBeNull(),
    );
    expect(window.localStorage.getItem("june.agent.unrestrictedSessions")).toBeNull();
  });

  it("keeps the blank composer after a New Session event during refresh", async () => {
    render(<AgentWorkspace />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    window.dispatchEvent(new CustomEvent(AGENT_NEW_SESSION_EVENT));

    expect(await screen.findByText(HERO_GREETING)).toBeInTheDocument();
    expect(screen.queryByText("Existing session")).toBeNull();
  });

  it("clears an existing draft when starting a blank new session", async () => {
    const user = userEvent.setup();
    render(<AgentWorkspace />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "stale draft");
    expect(screen.getByRole("textbox")).toHaveTextContent("stale draft");

    act(() => {
      window.dispatchEvent(new CustomEvent(AGENT_NEW_SESSION_EVENT));
    });

    expect(await screen.findByText(HERO_GREETING)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("textbox").textContent).toBe(""));
    expect(screen.getByRole("button", { name: "Start session" })).toBeDisabled();
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith(
      "prompt.submit",
      expect.objectContaining({ text: "stale draft" }),
    );
  });

  it("restores a session draft after leaving and returning to agent chat", async () => {
    const user = userEvent.setup();
    const first = render(<AgentWorkspace initialSession={existingSession} />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "carry this thought");
    expect(screen.getByRole("textbox")).toHaveTextContent("carry this thought");

    first.unmount();
    render(<AgentWorkspace initialSession={existingSession} />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("textbox")).toHaveTextContent("carry this thought"),
    );
  });

  it("restores a session draft with attachments after returning to agent chat", async () => {
    const user = userEvent.setup();
    const first = render(<AgentWorkspace initialSession={existingSession} />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );

    mocks.eventHandlers.get("tauri://drag-drop")?.({
      payload: {
        paths: ["/Users/alex/Library/Application Support/CleanShot/media/screenshot.png"],
      },
    });

    expect(await screen.findByText("screenshot.png")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "what is in this image?");

    first.unmount();
    render(<AgentWorkspace initialSession={existingSession} />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    expect(await screen.findByText("screenshot.png")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("textbox")).toHaveTextContent("what is in this image?"),
    );

    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: expect.stringContaining("uploads/screenshot.png"),
      }),
    );
  });

  it("keeps a session draft when starting a blank new session", async () => {
    const user = userEvent.setup();
    const first = render(<AgentWorkspace initialSession={existingSession} />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "come back to this");

    act(() => {
      window.dispatchEvent(new CustomEvent(AGENT_NEW_SESSION_EVENT));
    });

    expect(await screen.findByText(HERO_GREETING)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("textbox").textContent).toBe(""));

    first.unmount();
    render(<AgentWorkspace initialSession={existingSession} />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveTextContent("come back to this"));
  });

  it("restores a new-session draft instead of reopening the last session", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("june:agent:last-open-session", "session-1");
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now() }),
    );

    const first = render(<AgentWorkspace />);

    expect(await screen.findByText(HERO_GREETING)).toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "draft a launch plan");
    expect(screen.getByRole("textbox")).toHaveTextContent("draft a launch plan");

    first.unmount();
    render(<AgentWorkspace />);

    expect(await screen.findByText(HERO_GREETING)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("textbox")).toHaveTextContent("draft a launch plan"),
    );
  });

  it("keeps a new-session draft when a blank New Session event returns to chat", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now() }),
    );

    render(<AgentWorkspace />);

    expect(await screen.findByText(HERO_GREETING)).toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "do not drop this");

    act(() => {
      window.dispatchEvent(new CustomEvent(AGENT_NEW_SESSION_EVENT));
    });

    await waitFor(() => expect(screen.getByRole("textbox")).toHaveTextContent("do not drop this"));
  });

  it("restores a stored new-session draft instead of reopening the last session", async () => {
    window.localStorage.setItem("june:agent:last-open-session", "session-1");
    window.sessionStorage.setItem(
      "june:agent:new-session-draft",
      JSON.stringify({ text: "stored hero draft", category: null }),
    );

    render(<AgentWorkspace />);

    expect(await screen.findByText(HERO_GREETING)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveTextContent("stored hero draft"));
  });

  it("restores drafts when switching sessions without remounting", async () => {
    const user = userEvent.setup();
    const secondSession = {
      ...existingSession,
      id: "session-2",
      title: "Second session",
      preview: "Second preview",
      last_active: "2026-06-04T12:05:00Z",
    };
    mocks.listHermesSessions.mockResolvedValue([existingSession, secondSession]);
    const { rerender } = render(<AgentWorkspace initialSession={existingSession} />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "first session draft");

    rerender(<AgentWorkspace initialSession={secondSession} />);

    expect(await screen.findByText("Second session")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("textbox").textContent).toBe(""));
    await user.type(screen.getByRole("textbox"), "second session draft");

    rerender(<AgentWorkspace initialSession={existingSession} />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("textbox")).toHaveTextContent("first session draft"),
    );
  });

  it("clears a cached session draft after sending it", async () => {
    const user = userEvent.setup();
    const first = render(<AgentWorkspace initialSession={existingSession} />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "ship this");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "ship this",
      }),
    );

    first.unmount();
    render(<AgentWorkspace initialSession={existingSession} />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    // Scope to the composer editor by its label: a still-working restored
    // session also renders the feature 06 steer input (another textbox), so a
    // bare textbox query would be ambiguous here.
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Message June" }).textContent).toBe(""),
    );
  });

  it("submits a pending New Session prompt as a fresh Hermes session", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({
        createdAt: Date.now(),
        prompt: "summarize the current page",
      }),
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
    expect(mocks.ensureHermesBridgeSession).toHaveBeenCalledWith({
      sessionId: "session-2",
      title: "Summarize Current Page",
    });
    expect(await screen.findByText("Summarize Current Page")).toBeInTheDocument();
    expect(screen.queryByText("Untitled session")).toBeNull();
    expect(window.sessionStorage.getItem(AGENT_NEW_SESSION_PENDING_KEY)).toBeNull();
  });

  it("stops a working session from the composer", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      // Markers must carry a fresh createdAt or the TTL check discards them.
      JSON.stringify({
        createdAt: Date.now(),
        prompt: "summarize the current page",
      }),
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

    // The session is now working, so the composer offers a stop control.
    const stop = await screen.findByRole("button", { name: "Stop June" });
    expect(mocks.gatewayEventHandlers.size).toBe(1);
    await userEvent.click(stop);

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.interrupt", {
        session_id: "runtime-session-2",
      }),
    );
    // The working flag clears even before any gateway event arrives, so the
    // stop control goes away and the session no longer reads as thinking.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop June" })).toBeNull());
    // Stopping also tears down the per-session gateway listener, so a
    // straggler "running" event can't flip the session back to working.
    expect(mocks.gatewayEventHandlers.size).toBe(0);
  });

  it("stops instantly even when the interrupt request hasn't resolved", async () => {
    // Immediacy regression: the stopped UI must not wait on the gateway
    // round-trip. Make session.interrupt hang forever and assert the Stop
    // control still gives way to Send right away.
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({
        createdAt: Date.now(),
        prompt: "summarize the current page",
      }),
    );
    mocks.listHermesSessions.mockResolvedValue([
      {
        id: "session-2",
        title: "Untitled session",
        preview: "summarize the current page",
        last_active: "2026-06-04T12:01:00Z",
      },
    ]);
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
      // The interrupt never settles — the UI must still reflect stopped.
      if (method === "session.interrupt") {
        return new Promise(() => {});
      }
      return Promise.resolve({});
    });

    render(<AgentWorkspace />);

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "summarize the current page",
      }),
    );

    const stop = await screen.findByRole("button", { name: "Stop June" });
    await userEvent.click(stop);

    // The interrupt request was fired (and never resolves)...
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.interrupt", {
        session_id: "runtime-session-2",
      }),
    );
    // ...yet the Stop control is already gone and the listener torn down,
    // proving the stop did not block on the RPC.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop June" })).toBeNull());
    expect(mocks.gatewayEventHandlers.size).toBe(0);
  });

  it("keeps an opened thinking disclosure open while reasoning streams", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({
        createdAt: Date.now(),
        prompt: "think out loud",
      }),
    );

    render(<AgentWorkspace />);

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "think out loud",
      }),
    );
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "thinking.delta",
          session_id: "runtime-session-2",
          payload: { delta: "Checking the project state." },
        });
      }
    });

    const label = await screen.findByText("Thinking");
    const details = label.closest("details");
    expect(details).not.toHaveAttribute("open");

    await user.click(label);
    await waitFor(() => expect(details).toHaveAttribute("open"));

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "thinking.delta",
          session_id: "runtime-session-2",
          payload: { delta: " Reading one more file." },
        });
      }
    });

    expect(await screen.findByText(/Reading one more file/)).toBeInTheDocument();
    expect(screen.getByText("Thinking").closest("details")).toHaveAttribute("open");

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "message.complete",
          session_id: "runtime-session-2",
          payload: { text: "Done." },
        });
      }
    });

    expect(await screen.findByText("Thought")).toBeInTheDocument();
    expect(screen.getByText("Thought").closest("details")).toHaveAttribute("open");

    await user.type(screen.getByRole("textbox"), "next request");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "next request",
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "thinking.delta",
          session_id: "runtime-session-2",
          payload: { delta: "Starting the next turn." },
        });
      }
    });
    expect(await screen.findByText("Thinking")).toBeInTheDocument();
    expect(screen.getByText("Thinking").closest("details")).not.toHaveAttribute("open");
  });

  it("keeps tool rows visible outside the thinking disclosure", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({
        createdAt: Date.now(),
        prompt: "inspect the project",
      }),
    );

    render(<AgentWorkspace />);

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "inspect the project",
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "thinking.delta",
          session_id: "runtime-session-2",
          payload: { delta: "Checking the project state." },
        });
        handler({
          type: "tool.start",
          session_id: "runtime-session-2",
          payload: {
            tool_id: "tool-1",
            tool_name: "read_file",
            path: "src/components/agent/AgentWorkspace.tsx",
          },
        });
      }
    });

    const thinkingDetails = (await screen.findByText("Thinking")).closest("details");
    expect(thinkingDetails).toHaveClass("agent-reasoning");
    expect(
      within(thinkingDetails as HTMLElement).getByText("Checking the project state."),
    ).toBeInTheDocument();

    const toolLabel = await screen.findByText("Reading files");
    expect(thinkingDetails).not.toContainElement(toolLabel);
    expect(toolLabel.closest(".agent-tool-stack")).toBeTruthy();

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "message.complete",
          session_id: "runtime-session-2",
          payload: { text: "Done." },
        });
      }
    });

    const thoughtDetails = (await screen.findByText("Thought")).closest("details");
    expect(thoughtDetails).toHaveClass("agent-reasoning");
    expect(thoughtDetails).not.toContainElement(toolLabel);
    expect(await screen.findByText("Done.")).toBeInTheDocument();
  });

  it("does not force the transcript to the bottom while subagent progress streams", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({
        createdAt: Date.now(),
        prompt: "browse the web for recent launch details",
      }),
    );

    render(<AgentWorkspace />);

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "browse the web for recent launch details",
      }),
    );
    expect(await screen.findByText("browse the web for recent launch details")).toBeInTheDocument();

    const scroller = document.querySelector(".agent-scroll") as HTMLElement;
    const scrollTo = vi.fn();
    Object.defineProperty(scroller, "clientHeight", {
      configurable: true,
      value: 320,
    });
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      value: 1600,
    });
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      value: 240,
      writable: true,
    });
    Object.defineProperty(scroller, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    fireEvent.scroll(scroller);

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "subagent.progress",
          session_id: "runtime-session-2",
          payload: {
            subagent_id: "worker-1",
            goal: "Browse source pages",
            text: "Reading search results",
          },
        });
      }
    });

    expect(await screen.findByText("Subagent: Browse source pages")).toBeInTheDocument();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("keeps following new output during programmatic smooth scrolling", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({
        createdAt: Date.now(),
        prompt: "browse the web for release notes",
      }),
    );

    render(<AgentWorkspace />);

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "browse the web for release notes",
      }),
    );

    const scroller = document.querySelector(".agent-scroll") as HTMLElement;
    const scrollTo = vi.fn();
    Object.defineProperty(scroller, "clientHeight", {
      configurable: true,
      value: 320,
    });
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      value: 1600,
    });
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      value: 1280,
      writable: true,
    });
    Object.defineProperty(scroller, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    fireEvent.scroll(scroller);

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "subagent.progress",
          session_id: "runtime-session-2",
          payload: {
            subagent_id: "worker-1",
            goal: "Browse release notes",
            text: "Reading first source",
          },
        });
      }
    });
    await screen.findByText("Reading first source");
    expect(scrollTo).toHaveBeenCalledTimes(1);

    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      value: 2000,
    });
    scroller.scrollTop = 1460;
    fireEvent.scroll(scroller);

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "subagent.progress",
          session_id: "runtime-session-2",
          payload: {
            subagent_id: "worker-1",
            goal: "Browse release notes",
            text: "Reading another source",
          },
        });
      }
    });

    await screen.findByText(/Reading another source/);
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  it("does not pull the transcript back down after scrollbar scrolling", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({
        createdAt: Date.now(),
        prompt: "browse the web for release notes",
      }),
    );

    render(<AgentWorkspace />);

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "browse the web for release notes",
      }),
    );

    const scroller = document.querySelector(".agent-scroll") as HTMLElement;
    const scrollTo = vi.fn();
    Object.defineProperty(scroller, "clientHeight", {
      configurable: true,
      value: 320,
    });
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      value: 1600,
    });
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      value: 1280,
      writable: true,
    });
    Object.defineProperty(scroller, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    fireEvent.scroll(scroller);

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "subagent.progress",
          session_id: "runtime-session-2",
          payload: {
            subagent_id: "worker-1",
            goal: "Browse release notes",
            text: "Reading first source",
          },
        });
      }
    });
    await screen.findByText("Reading first source");
    expect(scrollTo).toHaveBeenCalledTimes(1);

    scroller.scrollTop = 900;
    fireEvent.scroll(scroller);

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "subagent.progress",
          session_id: "runtime-session-2",
          payload: {
            subagent_id: "worker-1",
            goal: "Browse release notes",
            text: "Reading while the user reviews earlier output",
          },
        });
      }
    });

    await screen.findByText(/Reading while the user reviews earlier output/);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("explains a pending approval before the user chooses", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({
        createdAt: Date.now(),
        prompt: "run the build",
      }),
    );

    render(<AgentWorkspace />);

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "run the build",
      }),
    );
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "approval.request",
          session_id: "runtime-session-2",
          payload: {
            request_id: "approval-1",
            description: "Security scan requires approval.",
            command: "npm run build",
            allow_permanent: true,
          },
        });
      }
    });

    expect(await screen.findByText("Approval required")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Explain first" }));

    // The explanation comes from the generation model, scoped to this
    // request — not canned copy.
    expect(mocks.explainAgentApproval).toHaveBeenCalledWith({
      description: "Security scan requires approval.",
      command: "npm run build",
    });
    expect(
      await screen.findByText(
        "This deletes the build folder, then rebuilds the project from scratch.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Approve once allows only this request/)).toBeInTheDocument();
    expect(
      screen.getByText(/Always allows matching requests in future sessions/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide explanation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve once" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Always" })).toBeEnabled();
    // Asking for an explanation never answers the approval.
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("approval.respond", expect.anything());

    // Reopening reuses the cached answer instead of paying for another call.
    await user.click(screen.getByRole("button", { name: "Hide explanation" }));
    await user.click(screen.getByRole("button", { name: "Explain first" }));
    expect(
      await screen.findByText(
        "This deletes the build folder, then rebuilds the project from scratch.",
      ),
    ).toBeInTheDocument();
    expect(mocks.explainAgentApproval).toHaveBeenCalledTimes(1);
  });

  it("retires a pending approval and explains when its runtime session is gone", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), prompt: "run the build" }),
    );
    // The runtime that asked for the approval has ended: answering it makes the
    // gateway reply 404 "Session not found" (the wire error the bridge builds).
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
      if (method === "approval.respond") {
        return Promise.reject(
          new Error('Hermes API returned 404 Not Found: {"detail":"Session not found"}'),
        );
      }
      return Promise.resolve({});
    });

    render(<AgentWorkspace />);

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "run the build",
      }),
    );
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "approval.request",
          session_id: "runtime-session-2",
          payload: {
            request_id: "approval-gone",
            description: "Security scan requires approval.",
            command: "npm run build",
            allow_permanent: true,
          },
        });
      }
    });

    expect(await screen.findByText("Approval required")).toBeInTheDocument();
    // The event registered a "Needs you" row for this request.
    expect(
      pendingActionStore.openRecords().some((record) => record.requestId === "approval-gone"),
    ).toBe(true);

    await user.click(screen.getByRole("button", { name: "Approve once" }));

    // The request can never be answered now, so June retires the dead-end card
    // (the "Needs you" row and the inline prompt) instead of leaving a "Respond"
    // that 404s. Before the fix this record lingered after the failed respond.
    await waitFor(() =>
      expect(
        pendingActionStore.openRecords().some((record) => record.requestId === "approval-gone"),
      ).toBe(false),
    );
    // The raw "Hermes API returned 404 ... Session not found" wire error is
    // never surfaced to the user.
    expect(screen.queryByText(/Hermes API returned 404/)).toBeNull();
  });

  it("resumes the runtime to load usage when the cached session is gone", async () => {
    const user = userEvent.setup();
    let resumeCount = 0;
    mocks.gatewayRequest.mockImplementation((method: string, params?: { session_id?: string }) => {
      if (method === "session.resume") {
        resumeCount += 1;
        // First resume serves the send flow; the second is the usage retry
        // after the cached runtime reports "session not found".
        return Promise.resolve({
          session_id: resumeCount === 1 ? "runtime-stale" : "runtime-fresh",
        });
      }
      if (method === "session.usage") {
        if (params?.session_id === "runtime-fresh") {
          return Promise.resolve({
            model: "zai-org-glm-5-2",
            context_used: 100,
            context_max: 1000,
          });
        }
        return Promise.reject(new Error("session not found"));
      }
      return Promise.resolve({});
    });

    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    // Send into the existing session so it caches a (soon-stale) runtime id.
    await user.type(screen.getByRole("textbox"), "do something long");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith(
        "prompt.submit",
        expect.objectContaining({ session_id: "runtime-stale" }),
      ),
    );

    // Opening Usage hits the stale runtime, gets "session not found", resumes
    // for a fresh runtime, and retries — so the panel renders real metrics.
    await user.click(screen.getByRole("button", { name: "Session actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Usage" }));

    expect(await screen.findByText("zai-org-glm-5-2")).toBeInTheDocument();
    expect(screen.getByText("100 / 1,000 (10%)")).toBeInTheDocument();
    expect(resumeCount).toBe(2);
  });

  it("falls back to static copy when the explanation call fails", async () => {
    const user = userEvent.setup();
    mocks.explainAgentApproval.mockRejectedValue(new Error("offline"));
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({
        createdAt: Date.now(),
        prompt: "run the build",
      }),
    );

    render(<AgentWorkspace />);

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "run the build",
      }),
    );
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "approval.request",
          session_id: "runtime-session-2",
          payload: {
            request_id: "approval-1",
            description: "Security scan requires approval.",
            command: "npm run build",
            allow_permanent: true,
          },
        });
      }
    });

    expect(await screen.findByText("Approval required")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Explain first" }));

    expect(
      await screen.findByText(
        "June is paused because this request needs your explicit permission before it can continue.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Approve once allows only this request/)).toBeInTheDocument();
  });

  it("omits the permanent approval explanation when Always is unavailable", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({
        createdAt: Date.now(),
        prompt: "inspect the repo",
      }),
    );

    render(<AgentWorkspace />);

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "inspect the repo",
      }),
    );
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "approval.request",
          session_id: "runtime-session-2",
          payload: {
            request_id: "approval-2",
            description: "Repository inspection requires approval.",
            command: "git status",
            allow_permanent: false,
          },
        });
      }
    });

    expect(await screen.findByText("Approval required")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Explain first" }));

    expect(screen.getByText(/Approve once allows only this request/)).toBeInTheDocument();
    expect(
      screen.queryByText(/Always allows matching requests in future sessions/),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Always" })).toBeNull();
  });

  it("creates a fresh Hermes session for a New Session prompt when an initial session is selected", async () => {
    render(<AgentWorkspace initialSession={existingSession} />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    window.dispatchEvent(
      new CustomEvent(AGENT_NEW_SESSION_EVENT, {
        detail: { prompt: "write a project update" },
      }),
    );

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.create", {
        title: "Summarize Current Page",
        cols: 96,
        model: "zai-org-glm-5-2",
      }),
    );
    expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
      session_id: "runtime-session-2",
      text: "write a project update",
    });
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", {
      session_id: "runtime-session-1",
      text: "write a project update",
    });
  });

  it("keeps an optimistic Hermes session visible while the persisted list lags", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({
        createdAt: Date.now(),
        prompt: "open the release notes",
      }),
    );
    mocks.listHermesSessions.mockResolvedValue([existingSession]);

    render(<AgentWorkspace />);

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "open the release notes",
      }),
    );

    expect(await screen.findByText("Summarize Current Page")).toBeInTheDocument();
    expect(screen.getByText("open the release notes")).toBeInTheDocument();
  });

  it("clears a working session the runtime is no longer running", async () => {
    // A recent trailing user message with no reply resumes the session as
    // working on mount — the exact state a dead run (provider failure, app
    // quit mid-turn) leaves behind.
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "user",
        content: "still waiting on this",
        timestamp: new Date().toISOString(),
      },
    ]);
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.active_list") {
        return Promise.resolve({ sessions: [] });
      }
      return Promise.resolve({});
    });

    // The whole flow runs under fake timers so the working-gated poll's
    // interval is created on the fake clock and can be advanced.
    vi.useFakeTimers();
    try {
      render(<AgentWorkspace />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(screen.getByText("Thinking…")).toBeInTheDocument();

      // Two reconcile polls: the first miss is tolerated (a fresh submit can
      // race the runtime registering), the second clears the activity.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      expect(screen.getByText("Thinking…")).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });

      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.active_list", {});
      expect(screen.queryByText("Thinking…")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a session working while the runtime reports it live", async () => {
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "user",
        content: "long running task",
        timestamp: new Date().toISOString(),
      },
    ]);
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.active_list") {
        return Promise.resolve({
          sessions: [
            {
              id: "runtime-session-1",
              session_key: "session-1",
              status: "working",
            },
          ],
        });
      }
      return Promise.resolve({});
    });

    vi.useFakeTimers();
    try {
      render(<AgentWorkspace />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(screen.getByText("Thinking…")).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });

      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.active_list", {});
      expect(screen.getByText("Thinking…")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps polling when a follow-up user message is still only pending locally", async () => {
    const user = userEvent.setup();
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "user",
        content: "previous request",
        timestamp: "2026-06-04T12:00:00.000Z",
      },
      {
        id: "m2",
        role: "assistant",
        content: "previous answer",
        timestamp: "2026-06-04T12:00:01.000Z",
      },
    ]);
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      return Promise.resolve({});
    });
    let resolveEnsureSession: (value: unknown) => void = () => {};
    mocks.ensureHermesBridgeSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveEnsureSession = resolve;
        }),
    );

    render(<AgentWorkspace />);

    expect(await screen.findByText("previous answer")).toBeInTheDocument();
    const initialSessionListCalls = mocks.listHermesSessions.mock.calls.length;

    await user.type(screen.getByRole("textbox"), "follow up while pending");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.ensureHermesBridgeSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-1",
        }),
      ),
    );

    vi.useFakeTimers();
    try {
      await act(async () => {
        resolveEnsureSession({});
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "follow up while pending",
      });
      expect(screen.getByText("Thinking…")).toBeInTheDocument();
      expect(mocks.listHermesSessions).toHaveBeenCalledTimes(initialSessionListCalls + 1);
      const sessionListCallsAfterSubmit = mocks.listHermesSessions.mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });

      expect(screen.getByText("follow up while pending")).toBeInTheDocument();
      expect(screen.getByText("Thinking…")).toBeInTheDocument();
      expect(mocks.listHermesSessions).toHaveBeenCalledTimes(sessionListCallsAfterSubmit + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("submits leading skill slash commands as explicit skill context", async () => {
    const user = userEvent.setup();
    mocks.hermesBridgeSkills.mockResolvedValue([
      {
        name: "repo-build-pr",
        description: "Build a branch and open a PR",
        enabled: true,
      },
      {
        name: "os-platform",
        description: "Read live Open Software Issues",
        enabled: true,
      },
    ]);

    render(<AgentWorkspace />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await user.type(
      screen.getByRole("textbox"),
      "/repo-build-pr /os-platform implement issue JUN-46",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(mocks.getHermesBridgeSkill).toHaveBeenCalledWith("repo-build-pr"));
    expect(mocks.getHermesBridgeSkill).toHaveBeenCalledWith("os-platform");

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith(
        "prompt.submit",
        expect.objectContaining({
          session_id: "runtime-session-1",
          text: expect.stringContaining("---EXPLICIT SKILLS---"),
        }),
      ),
    );
    const submitCall = mocks.gatewayRequest.mock.calls.find(
      ([method]) => method === "prompt.submit",
    );
    const submittedText = submitCall?.[1]?.text as string;
    expect(submittedText).toContain("Skill: repo-build-pr");
    expect(submittedText).toContain("Skill: os-platform");
    expect(submittedText).toContain("implement issue JUN-46");
    expect(submittedText).not.toContain("/repo-build-pr /os-platform implement issue JUN-46");
    expect(screen.getByText("implement issue JUN-46")).toBeInTheDocument();
    expect(screen.queryByText("---EXPLICIT SKILLS---")).toBeNull();
  });

  it("fetches qualified skill documents by backend skill id", async () => {
    const user = userEvent.setup();
    mocks.hermesBridgeSkills.mockResolvedValue([
      {
        name: "tools/gh-address-comments",
        description: "Address GitHub review comments",
        enabled: true,
      },
    ]);

    render(<AgentWorkspace />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "/tools/gh-address-comments review PR feedback");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(mocks.getHermesBridgeSkill).toHaveBeenCalledWith("gh-address-comments"),
    );
    const submitCall = mocks.gatewayRequest.mock.calls.find(
      ([method]) => method === "prompt.submit",
    );
    const submittedText = submitCall?.[1]?.text as string;
    expect(submittedText).toContain("Skill: tools/gh-address-comments");
    expect(submittedText).toContain("review PR feedback");
  });

  it("sends path-prefixed prompts normally when no skill matches", async () => {
    const user = userEvent.setup();
    mocks.hermesBridgeSkills.mockResolvedValue([
      {
        name: "repo-build-pr",
        description: "Build a branch and open a PR",
        enabled: true,
      },
    ]);

    render(<AgentWorkspace />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await user.type(
      screen.getByRole("textbox"),
      "/Users/alex/Desktop/report.pdf summarize this file",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith(
        "prompt.submit",
        expect.objectContaining({
          text: "/Users/alex/Desktop/report.pdf summarize this file",
        }),
      ),
    );
    expect(mocks.getHermesBridgeSkill).not.toHaveBeenCalled();
  });

  it("keeps edits made while skill preparation is in flight", async () => {
    const user = userEvent.setup();
    let resolveSkillDocument: (document: {
      name: string;
      relativePath: string;
      content: string;
    }) => void = () => {};
    mocks.hermesBridgeSkills.mockResolvedValue([
      {
        name: "repo-build-pr",
        description: "Build a branch and open a PR",
        enabled: true,
      },
    ]);
    mocks.getHermesBridgeSkill.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSkillDocument = resolve;
      }),
    );

    render(<AgentWorkspace />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    const textbox = screen.getByRole("textbox");
    await user.type(textbox, "/repo-build-pr implement issue JUN-46");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(mocks.getHermesBridgeSkill).toHaveBeenCalledWith("repo-build-pr"));

    await user.click(textbox);
    await user.type(textbox, " and keep this draft edit");
    resolveSkillDocument({
      name: "repo-build-pr",
      relativePath: "repo-build-pr/SKILL.md",
      content: "# Repo build PR\n\nOpen a draft PR.",
    });

    await waitFor(() =>
      expect(mocks.gatewayRequest.mock.calls.some(([method]) => method === "prompt.submit")).toBe(
        true,
      ),
    );
    expect(textbox).toHaveTextContent(
      "/repo-build-pr implement issue JUN-46 and keep this draft edit",
    );
  });

  it("keeps the draft and suggests matches for an unknown skill command", async () => {
    const user = userEvent.setup();
    mocks.hermesBridgeSkills.mockResolvedValue([
      {
        name: "repo-build-pr",
        description: "Build a branch and open a PR",
        enabled: true,
      },
    ]);

    render(<AgentWorkspace />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "/repo-build implement issue JUN-46");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(
      await screen.findByText("Could not find skill /repo-build. Try /repo-build-pr."),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveTextContent("/repo-build implement issue JUN-46");
    expect(mocks.getHermesBridgeSkill).not.toHaveBeenCalled();
    expect(mocks.gatewayRequest.mock.calls.some(([method]) => method === "prompt.submit")).toBe(
      false,
    );
  });

  it("rejects disabled skill slash commands", async () => {
    const user = userEvent.setup();
    mocks.hermesBridgeSkills.mockResolvedValue([
      {
        name: "repo-build-pr",
        description: "Build a branch and open a PR",
        enabled: false,
      },
    ]);

    render(<AgentWorkspace />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "/repo-build-pr implement issue JUN-46");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(
      await screen.findByText("/repo-build-pr is disabled. Enable it in Agent settings to use it."),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveTextContent("/repo-build-pr implement issue JUN-46");
    expect(mocks.getHermesBridgeSkill).not.toHaveBeenCalled();
    expect(mocks.gatewayRequest.mock.calls.some(([method]) => method === "prompt.submit")).toBe(
      false,
    );
  });

  it("retries skill loading on submit after a silent slash-prefetch failure", async () => {
    const user = userEvent.setup();
    mocks.hermesBridgeSkills
      .mockRejectedValueOnce(new Error("Hermes bridge is starting."))
      .mockResolvedValue([
        {
          name: "repo-build-pr",
          description: "Build a branch and open a PR",
          enabled: true,
        },
      ]);

    render(<AgentWorkspace />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "/");
    await waitFor(() => expect(mocks.hermesBridgeSkills).toHaveBeenCalled());

    await user.type(screen.getByRole("textbox"), "repo-build-pr implement issue JUN-46");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(mocks.getHermesBridgeSkill).toHaveBeenCalledWith("repo-build-pr"));
    expect(
      mocks.gatewayRequest.mock.calls.some(
        ([method, params]) =>
          method === "prompt.submit" &&
          typeof params?.text === "string" &&
          params.text.includes("implement issue JUN-46"),
      ),
    ).toBe(true);
  });

  it("shares an in-flight slash-prefetch with submit", async () => {
    const user = userEvent.setup();
    let resolveSkills: (
      skills: Array<{
        name: string;
        description: string;
        enabled: boolean;
      }>,
    ) => void = () => {};
    mocks.hermesBridgeSkills.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSkills = resolve;
      }),
    );

    render(<AgentWorkspace />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "/");
    await waitFor(() => expect(mocks.hermesBridgeSkills).toHaveBeenCalledTimes(1));

    await user.type(screen.getByRole("textbox"), "repo-build-pr implement issue JUN-46");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(mocks.hermesBridgeSkills).toHaveBeenCalledTimes(1);

    resolveSkills([
      {
        name: "repo-build-pr",
        description: "Build a branch and open a PR",
        enabled: true,
      },
    ]);

    await waitFor(() => expect(mocks.getHermesBridgeSkill).toHaveBeenCalledWith("repo-build-pr"));
    expect(mocks.hermesBridgeSkills).toHaveBeenCalledTimes(1);
  });

  it("renders generated workspace files mentioned by Hermes as downloadable artifacts", async () => {
    const user = userEvent.setup();
    const samplePath =
      "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace/sample.pdf";
    mocks.hermesBridgeFilesystemSnapshot.mockResolvedValue({
      roots: [
        {
          id: "workspace",
          label: "Workspace",
          path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace",
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

    await user.click(screen.getByRole("button", { name: "Download sample.pdf" }));

    expect(mocks.downloadHermesBridgeFile).toHaveBeenCalledWith(samplePath);
  });

  it("renders a workspace file's download card only on the first response that mentions it", async () => {
    mocks.hermesBridgeFilesystemSnapshot.mockResolvedValue({
      roots: [
        {
          id: "workspace",
          label: "Workspace",
          path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace",
          description: "Hermes scratch files and generated outputs.",
          entries: [
            {
              name: "report.md",
              path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace/report.md",
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
        content: "Done — I saved the summary as `report.md`.",
        timestamp: "2026-06-04T18:39:00Z",
      },
      {
        id: "message-2",
        role: "user",
        content: "Add a conclusion section.",
        timestamp: "2026-06-04T18:40:00Z",
      },
      {
        id: "message-3",
        role: "assistant",
        content: "I added a conclusion to report.md.",
        timestamp: "2026-06-04T18:41:00Z",
      },
    ]);

    render(<AgentWorkspace />);

    expect(await screen.findByLabelText("Generated files")).toBeInTheDocument();
    expect(screen.getAllByLabelText("Generated files")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Download report.md" })).toHaveLength(1);
  });

  it("opens a markdown artifact in the viewer panel with rendered content", async () => {
    const user = userEvent.setup();
    const reportPath =
      "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace/report.md";
    mocks.hermesBridgeFilesystemSnapshot.mockResolvedValue({
      roots: [
        {
          id: "workspace",
          label: "Workspace",
          path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace",
          description: "Hermes scratch files and generated outputs.",
          entries: [
            {
              name: "report.md",
              path: reportPath,
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
        content: "Done — I saved the summary as `report.md`.",
        timestamp: "2026-06-04T18:39:00Z",
      },
    ]);
    mocks.hermesBridgeFileText.mockResolvedValue("# Quarterly summary\n\nRevenue grew.");

    render(<AgentWorkspace />);

    await user.click(await screen.findByRole("button", { name: "Open report.md" }));

    const panel = await screen.findByRole("complementary", { name: "Files" });
    expect(mocks.hermesBridgeFileText).toHaveBeenCalledWith(reportPath);
    expect(
      await within(panel).findByRole("heading", { name: "Quarterly summary" }),
    ).toBeInTheDocument();
    expect(within(panel).getByText("Revenue grew.")).toBeInTheDocument();

    // Find-in-file highlights matches inside the rendered document.
    await user.click(within(panel).getByRole("button", { name: "Find in file" }));
    await user.type(within(panel).getByLabelText("Find in file"), "revenue");
    // Highlighting trails typing by a short debounce.
    await waitFor(() => expect(panel.querySelectorAll("mark").length).toBeGreaterThan(0));
    expect(panel.querySelectorAll("mark")[0]).toHaveTextContent(/revenue/i);
    await user.keyboard("{Escape}"); // clear
    await user.keyboard("{Escape}"); // collapse
    expect(panel.querySelectorAll("mark")).toHaveLength(0);

    // The source toggle swaps the rendered document for the raw markdown.
    await user.click(within(panel).getByRole("button", { name: "Source" }));
    expect(within(panel).getByText(/# Quarterly summary/)).toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: "Close files" }));
    expect(screen.queryByRole("complementary", { name: "Files" })).not.toBeInTheDocument();
  });

  // SKIPPED while the Agent activity drawer's entry point is hidden
  // (ACTIVITY_DRAWER_ENABLED=false in AgentWorkspace, parking the open-wrong-
  // session bug). These two reach feature 14's artifacts timeline THROUGH the
  // drawer toggle, which no longer renders. The artifacts section itself stays
  // covered by agent-artifacts-section.test.tsx; un-skip when the flag flips back.
  it.skip("shows a tool-touched file in the activity drawer's artifacts timeline and opens it in the preview flow", async () => {
    const user = userEvent.setup();
    const reportPath =
      "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace/timeline.md";
    mocks.hermesBridgeFileText.mockResolvedValue("# Timeline\n\nBody.");

    render(<AgentWorkspace />);
    // Wait for the workspace (and the auto-selected existing session) to settle.
    await screen.findByRole("button", { name: "Show agent activity" });

    // Feed the SAME singleton store the live classify site feeds: a
    // tool.complete that wrote a file under the selected session (session-1).
    act(() => {
      const event = classifyHermesEvent({
        type: "tool.complete",
        session_id: "session-1",
        payload: { name: "write_file", path: reportPath },
      });
      hermesArtifactStore.record(event, "sandboxed");
    });

    // Open the activity drawer; its Artifacts section lists the file.
    await user.click(screen.getByRole("button", { name: "Show agent activity" }));
    const artifacts = await screen.findByRole("region", { name: "Artifacts" });
    expect(within(artifacts).getByText("timeline.md")).toBeInTheDocument();
    // Sandboxed session => the path-safety label reads "sandboxed".
    expect(within(artifacts).getByText(/sandbox/i)).toBeInTheDocument();

    // Clicking the artifact routes into the EXISTING preview flow, which
    // fetches the file text via the bridge command.
    await user.click(within(artifacts).getByRole("button", { name: /timeline\.md/i }));
    await waitFor(() => expect(mocks.hermesBridgeFileText).toHaveBeenCalledWith(reportPath));
  });

  // SKIPPED: see the note above. Reaches the artifacts timeline through the
  // hidden activity drawer toggle; un-skip when ACTIVITY_DRAWER_ENABLED is true.
  it.skip("marks a failed file access as failed in the artifacts timeline", async () => {
    const user = userEvent.setup();
    render(<AgentWorkspace />);
    await screen.findByRole("button", { name: "Show agent activity" });

    act(() => {
      const event = classifyHermesEvent({
        type: "tool.complete",
        session_id: "session-1",
        payload: {
          name: "read_file",
          path: "/root/secret.txt",
          error: "permission denied",
        },
      });
      hermesArtifactStore.record(event, "unrestricted");
    });

    await user.click(screen.getByRole("button", { name: "Show agent activity" }));
    const artifacts = await screen.findByRole("region", { name: "Artifacts" });
    const row = within(artifacts).getByRole("listitem");
    expect(row).toHaveAttribute("data-action", "failed");
    expect(within(row).getByText(/failed/i)).toBeInTheDocument();
    // An unrestricted session's real path is labeled as such.
    expect(within(row).getByText(/unrestricted/i)).toBeInTheDocument();
  });

  it("lists every surfaced file behind the session bar files button", async () => {
    const user = userEvent.setup();
    const workspaceRoot =
      "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace";
    mocks.hermesBridgeFilesystemSnapshot.mockResolvedValue({
      roots: [
        {
          id: "workspace",
          label: "Workspace",
          path: workspaceRoot,
          description: "Hermes scratch files and generated outputs.",
          entries: [
            {
              name: "report.md",
              path: `${workspaceRoot}/report.md`,
              kind: "file",
              size: 1768,
              modifiedAt: "2026-06-04T18:39:00Z",
            },
            {
              name: "notes.txt",
              path: `${workspaceRoot}/notes.txt`,
              kind: "file",
              size: 420,
              modifiedAt: "2026-06-04T18:40:00Z",
            },
          ],
        },
      ],
    });
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "message-1",
        role: "assistant",
        content: "Saved `report.md` and `notes.txt`.",
        timestamp: "2026-06-04T18:39:00Z",
      },
    ]);
    mocks.hermesBridgeFileText.mockResolvedValue("plain text body");

    render(<AgentWorkspace />);

    await user.click(await screen.findByRole("button", { name: "View files (2)" }));

    const panel = await screen.findByRole("complementary", { name: "Files" });
    expect(within(panel).getByText("report.md")).toBeInTheDocument();

    // Opening a non-markdown file from the list shows its raw text.
    await user.click(within(panel).getByText("notes.txt"));
    expect(await within(panel).findByText("plain text body")).toBeInTheDocument();
    expect(mocks.hermesBridgeFileText).toHaveBeenCalledWith(`${workspaceRoot}/notes.txt`);

    // Back returns to the list of every surfaced file.
    await user.click(within(panel).getByRole("button", { name: "All files" }));
    expect(within(panel).getByText("report.md")).toBeInTheDocument();

    // The header magnifier expands into the filter; typing narrows the list.
    await user.click(within(panel).getByRole("button", { name: "Filter files" }));
    const filter = within(panel).getByLabelText("Filter files");
    await user.type(filter, "notes");
    expect(within(panel).queryByText("report.md")).not.toBeInTheDocument();
    expect(within(panel).getByText("notes.txt")).toBeInTheDocument();

    // Esc walks back one step at a time: clear, collapse, close.
    await user.keyboard("{Escape}");
    expect(within(panel).getByText("report.md")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(within(panel).queryByRole("searchbox")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("complementary", { name: "Files" })).not.toBeInTheDocument();
  });

  it("does not surface files only mentioned inside tool output", async () => {
    const user = userEvent.setup();
    const workspaceRoot =
      "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace";
    mocks.hermesBridgeFilesystemSnapshot.mockResolvedValue({
      roots: [
        {
          id: "workspace",
          label: "Workspace",
          path: workspaceRoot,
          description: "Hermes scratch files and generated outputs.",
          entries: [
            {
              name: "sample.pdf",
              path: `${workspaceRoot}/sample.pdf`,
              kind: "file",
              size: 1768,
              modifiedAt: "2026-06-04T18:39:00Z",
            },
            {
              name: "screenshot.png",
              path: `${workspaceRoot}/screenshot.png`,
              kind: "file",
              size: 2048,
              modifiedAt: "2026-06-04T18:39:00Z",
            },
            {
              name: "generate_pdf.py",
              path: `${workspaceRoot}/generate_pdf.py`,
              kind: "file",
              size: 512,
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
        tool_calls: JSON.stringify([
          {
            id: "call-1",
            function: {
              name: "list_files",
              arguments: "{}",
            },
          },
        ]),
      },
      {
        id: "tool-1",
        role: "tool",
        content: "sample.pdf\nscreenshot.png\ngenerate_pdf.py",
        timestamp: "2026-06-04T18:39:01Z",
        tool_call_id: "call-1",
        tool_name: "list_files",
      },
    ]);

    render(<AgentWorkspace />);

    expect(await screen.findByLabelText("Generated files")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download sample.pdf" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Download screenshot.png" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Download generate_pdf.py" }),
    ).not.toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "View files (1)" }));

    const panel = await screen.findByRole("complementary", { name: "Files" });
    expect(within(panel).getByText("sample.pdf")).toBeInTheDocument();
    expect(within(panel).queryByText("screenshot.png")).not.toBeInTheDocument();
    expect(within(panel).queryByText("generate_pdf.py")).not.toBeInTheDocument();
  });

  it("does not render download cards for files the user attached", async () => {
    const attachedPath =
      "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace/june-context.md";
    mocks.hermesBridgeFilesystemSnapshot.mockResolvedValue({
      roots: [
        {
          id: "workspace",
          label: "Workspace",
          path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace",
          description: "Hermes scratch files and generated outputs.",
          entries: [
            {
              name: "june-context.md",
              path: attachedPath,
              kind: "file",
              size: 14336,
              modifiedAt: "2026-06-04T18:39:00Z",
            },
          ],
        },
      ],
    });
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "message-1",
        role: "user",
        content: [
          "Summarize this.",
          "",
          "Attached files copied into the June workspace:",
          "- june-context.md (Workspace): june-context.md",
          "",
          "Use these file paths when inspecting or operating on the files.",
        ].join("\n"),
        timestamp: "2026-06-04T18:38:00Z",
      },
      {
        id: "message-2",
        role: "assistant",
        content: "Here's a summary of june-context.md: it covers the plan.",
        timestamp: "2026-06-04T18:39:00Z",
      },
    ]);

    render(<AgentWorkspace />);

    expect(await screen.findByText(/Here's a summary/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Generated files")).not.toBeInTheDocument();
  });

  it("renders one download card when two workspace copies share a file name", async () => {
    mocks.hermesBridgeFilesystemSnapshot.mockResolvedValue({
      roots: [
        {
          id: "workspace",
          label: "Workspace",
          path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace",
          description: "Hermes scratch files and generated outputs.",
          entries: [
            {
              name: "notes.md",
              path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace/notes.md",
              kind: "file",
              size: 512,
              modifiedAt: "2026-06-04T18:39:00Z",
            },
            {
              name: "archive",
              path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace/archive",
              kind: "directory",
              children: [
                {
                  name: "notes.md",
                  path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace/archive/notes.md",
                  kind: "file",
                  size: 512,
                  modifiedAt: "2026-06-04T18:39:00Z",
                },
              ],
            },
          ],
        },
      ],
    });
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "message-1",
        role: "assistant",
        content: "I wrote everything up in notes.md.",
        timestamp: "2026-06-04T18:39:00Z",
      },
    ]);

    render(<AgentWorkspace />);

    expect(await screen.findByLabelText("Generated files")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Download notes.md" })).toHaveLength(1);
  });

  it("renders generated workspace images as file cards without previews", async () => {
    const screenshotPath =
      "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace/screenshot.png";
    mocks.hermesBridgeFilesystemSnapshot.mockResolvedValue({
      roots: [
        {
          id: "workspace",
          label: "Workspace",
          path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace",
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

    // Images get the same icon · name · size card as every other file type —
    // no thumbnail, so no preview round-trip to the bridge.
    expect(
      await screen.findByRole("button", { name: "Download screenshot.png" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "screenshot.png" })).not.toBeInTheDocument();
    expect(mocks.hermesBridgeFilePreview).not.toHaveBeenCalledWith(screenshotPath);
  });

  it("imports dropped files into the Hermes workspace before submitting", async () => {
    const user = userEvent.setup();
    render(<AgentWorkspace />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );

    mocks.eventHandlers.get("tauri://drag-drop")?.({
      payload: {
        paths: ["/Users/alex/Library/Application Support/CleanShot/media/screenshot.png"],
      },
    });

    expect(await screen.findByText("screenshot.png")).toBeInTheDocument();
    expect(document.querySelector(".agent-attachment-chip img")).toHaveAttribute(
      "src",
      "data:image/png;base64,preview",
    );
    await user.type(screen.getByRole("textbox"), "what is in this image?");
    const sendButton = screen.getByRole("button", { name: "Send message" });
    await waitFor(() => expect(sendButton).not.toBeDisabled());
    await user.click(sendButton);

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: expect.stringContaining("uploads/screenshot.png"),
      }),
    );
    const submitted = mocks.gatewayRequest.mock.calls.find(
      ([method]) => method === "prompt.submit",
    )?.[1] as { text: string };
    expect(submitted.text).toContain("Attached files copied into the June workspace:");
    expect(submitted.text).toContain(
      "Use these file paths when inspecting or operating on the files.",
    );
    expect(submitted.text).not.toContain("co.opensoftware.june");
    expect(submitted.text).not.toContain("June Hermes");
    expect(mocks.importHermesBridgeFile).toHaveBeenCalledWith(
      "/Users/alex/Library/Application Support/CleanShot/media/screenshot.png",
    );
  });

  it("imports typed file paths from the /file slash command", async () => {
    const user = userEvent.setup();
    render(<AgentWorkspace />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    const composer = screen.getByRole("textbox");
    await user.type(composer, '/file "/Users/alex/Desktop/Q2 report.pdf"');
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(mocks.importHermesBridgeFile).toHaveBeenCalledWith(
        "/Users/alex/Desktop/Q2 report.pdf",
      ),
    );
    expect(await screen.findByText("Q2 report.pdf")).toBeInTheDocument();
    expect(composer.textContent).toBe("");
    expect(mocks.gatewayRequest.mock.calls.some(([method]) => method === "prompt.submit")).toBe(
      false,
    );
  });

  it("uses a text fallback when the selected model cannot read image attachments", async () => {
    const user = userEvent.setup();
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );

    mocks.eventHandlers.get("tauri://drag-drop")?.({
      payload: {
        paths: ["/Users/alex/Library/Application Support/CleanShot/media/screenshot.png"],
      },
    });

    expect(await screen.findByText("screenshot.png")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "what is in this image?");
    const sendButton = screen.getByRole("button", { name: "Send message" });
    await waitFor(() => expect(sendButton).not.toBeDisabled());
    await user.click(sendButton);

    await waitFor(() =>
      expect(mocks.gatewayRequest.mock.calls.some(([method]) => method === "prompt.submit")).toBe(
        true,
      ),
    );
    expect(
      mocks.gatewayRequest.mock.calls.some(([method]) => method === "image.attach_bytes"),
    ).toBe(false);

    const submitted = mocks.gatewayRequest.mock.calls.find(
      ([method]) => method === "prompt.submit",
    )?.[1] as { text: string };
    expect(submitted.text).toContain("Attached files copied into the June workspace:");
    expect(submitted.text).toContain("--- Attached Context ---");
    expect(submitted.text).toContain("GLM 5.2 does not support image input in June.");
    expect(submitted.text).toContain("Do not call vision_analyze");
    expect(submitted.text).toContain(
      "ask the user to describe the image or paste the relevant text",
    );
  });

  it("warns and offers a one-tap switch when an image is attached to a non-vision model", async () => {
    // Hero mode (no open session) so the switch writes the global text-model
    // default through setVeniceModel rather than a per-chat gateway dispatch.
    mocks.listAgentTasks.mockResolvedValue({ items: [] });
    mocks.listHermesSessions.mockResolvedValue([]);
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: "zai-org-glm-5-2",
      models: [
        {
          provider: "venice",
          id: "zai-org-glm-5-2",
          name: "GLM 5.2",
          modelType: "text",
          privacy: "private",
          traits: [],
          capabilities: ["functionCalling"],
        },
        {
          provider: "venice",
          id: "qwen-vl",
          name: "Qwen VL",
          modelType: "text",
          privacy: "private",
          traits: [],
          capabilities: ["functionCalling", "supportsVision"],
        },
      ],
    });
    mocks.setVeniceModel.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<AgentWorkspace />);
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );

    mocks.eventHandlers.get("tauri://drag-drop")?.({
      payload: {
        paths: ["/Users/alex/Library/Application Support/CleanShot/media/screenshot.png"],
      },
    });

    expect(await screen.findByText("screenshot.png")).toBeInTheDocument();
    expect(await screen.findByText("GLM 5.2 can't read images.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Switch to Qwen VL" }));

    await waitFor(() => expect(mocks.setVeniceModel).toHaveBeenCalledWith("generation", "qwen-vl"));
    // The switch picks the image-capable model and keeps the dropped image.
    expect(screen.getByText("screenshot.png")).toBeInTheDocument();
  });

  it("prefers the suggested vision model over the first eligible one (JUN-165)", async () => {
    // The banner action is a one-tap fix, and with several image-capable models
    // it prefers a curated suggested pick (Kimi K2.6) rather than the
    // alphabetically-first vision model — otherwise it lands on an arbitrary
    // model like Claude Fable 5. Qwen VL is listed first here to prove the
    // preference overrides list order; no non-vision-scoped picker is opened.
    mocks.listAgentTasks.mockResolvedValue({ items: [] });
    mocks.listHermesSessions.mockResolvedValue([]);
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: "zai-org-glm-5-2",
      models: [
        {
          provider: "venice",
          id: "zai-org-glm-5-2",
          name: "GLM 5.2",
          modelType: "text",
          privacy: "private",
          traits: [],
          capabilities: ["functionCalling"],
        },
        {
          provider: "venice",
          id: "qwen-vl",
          name: "Qwen VL",
          modelType: "text",
          privacy: "private",
          traits: [],
          capabilities: ["functionCalling", "supportsVision"],
        },
        {
          provider: "venice",
          id: "kimi-k2-6",
          name: "Kimi K2.6",
          modelType: "text",
          privacy: "private",
          traits: [],
          capabilities: ["functionCalling", "supportsVision"],
        },
      ],
    });
    mocks.setVeniceModel.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<AgentWorkspace />);
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );
    mocks.eventHandlers.get("tauri://drag-drop")?.({
      payload: {
        paths: ["/Users/alex/Library/Application Support/CleanShot/media/screenshot.png"],
      },
    });
    expect(await screen.findByText("screenshot.png")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Switch to Kimi K2.6" }));
    // Lands on the suggested vision model (Kimi), not first-listed Qwen VL, and
    // no picker dialog opens.
    await waitFor(() =>
      expect(mocks.setVeniceModel).toHaveBeenCalledWith("generation", "kimi-k2-6"),
    );
    expect(screen.queryByRole("dialog", { name: "Choose text model" })).not.toBeInTheDocument();
  });

  it("attaches the image when the active model id is unresolved", async () => {
    // Regression: a stale or not-yet-loaded model id must not be assumed
    // non-vision. The image still attaches via image.attach_bytes rather than
    // silently downgrading to the text-only fallback.
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: "model-not-in-catalog",
      models: [
        {
          provider: "venice",
          id: "kimi-k2-6",
          name: "Kimi K2.6",
          modelType: "text",
          privacy: "private",
          traits: [],
          capabilities: ["functionCalling"],
        },
      ],
    });
    const user = userEvent.setup();
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );

    mocks.eventHandlers.get("tauri://drag-drop")?.({
      payload: {
        paths: ["/Users/alex/Library/Application Support/CleanShot/media/screenshot.png"],
      },
    });

    expect(await screen.findByText("screenshot.png")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "what is in this image?");
    const sendButton = screen.getByRole("button", { name: "Send message" });
    await waitFor(() => expect(sendButton).not.toBeDisabled());
    await user.click(sendButton);

    await waitFor(() =>
      expect(
        mocks.gatewayRequest.mock.calls.some(([method]) => method === "image.attach_bytes"),
      ).toBe(true),
    );
    const submitted = mocks.gatewayRequest.mock.calls.find(
      ([method]) => method === "prompt.submit",
    )?.[1] as { text: string };
    expect(submitted.text).not.toContain("does not support image input");
  });

  it("shows no image-input warning when the selected model reads images", async () => {
    mockGlmCapabilities(["functionCalling", "supportsVision"]);
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );

    mocks.eventHandlers.get("tauri://drag-drop")?.({
      payload: {
        paths: ["/Users/alex/Library/Application Support/CleanShot/media/screenshot.png"],
      },
    });

    expect(await screen.findByText("screenshot.png")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Switch to / })).not.toBeInTheDocument();
  });

  it("attaches a dropped image to the session via image.attach_bytes and marks it attached", async () => {
    // Feature 19: on submit, an imported image is sent to the session through
    // the structured image.attach_bytes RPC, the chip flips to "Attached", and the
    // attachment lands in the artifact timeline — without the base64 ever
    // reaching the sanitized trace export.
    mockGlmCapabilities(["functionCalling", "supportsVision"]);
    const user = userEvent.setup();
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );

    mocks.eventHandlers.get("tauri://drag-drop")?.({
      payload: {
        paths: ["/Users/alex/Library/Application Support/CleanShot/media/screenshot.png"],
      },
    });

    expect(await screen.findByText("screenshot.png")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "what is in this image?");
    const sendButton = screen.getByRole("button", { name: "Send message" });
    await waitFor(() => expect(sendButton).not.toBeDisabled());
    await user.click(sendButton);

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("image.attach_bytes", {
        session_id: "runtime-session-1",
        mime_type: "image/png",
        content_base64: "cHJldmlldw==",
        filename: "screenshot.png",
      }),
    );
    // image.attach_bytes precedes prompt.submit for the same turn.
    const attachIndex = mocks.gatewayRequest.mock.calls.findIndex(
      ([method]) => method === "image.attach_bytes",
    );
    const submitIndex = mocks.gatewayRequest.mock.calls.findIndex(
      ([method]) => method === "prompt.submit",
    );
    expect(attachIndex).toBeGreaterThanOrEqual(0);
    expect(submitIndex).toBeGreaterThan(attachIndex);

    // The artifact timeline gets an "attached" image, keyed to the session.
    await waitFor(() => {
      const records = hermesArtifactStore.getRecordsForSession("session-1");
      expect(
        records.some((record) => record.action === "attached" && record.kind === "image"),
      ).toBe(true);
    });

    // The sanitized trace export records the attach but NEVER the base64.
    const trace = JSON.stringify(hermesTraceBuffer.exportSanitizedTrace("session-1"));
    expect(trace).toContain("image.attach_bytes");
    expect(trace).not.toContain("cHJldmlldw==");
    expect(trace).not.toContain("content_base64");
  });

  it("blocks the prompt and warns when an image attach fails", async () => {
    // A failed image.attach_bytes must not silently send the prompt with a missing
    // image: the send is blocked, the chip surfaces the failure, and the
    // composer text is restored for a retry.
    mockGlmCapabilities(["functionCalling", "supportsVision"]);
    const user = userEvent.setup();
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
      if (method === "image.attach_bytes") {
        return Promise.reject(new Error("attach exploded"));
      }
      return Promise.resolve({});
    });
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );

    mocks.eventHandlers.get("tauri://drag-drop")?.({
      payload: {
        paths: ["/Users/alex/Library/Application Support/CleanShot/media/screenshot.png"],
      },
    });

    expect(await screen.findByText("screenshot.png")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "edit this image");
    const sendButton = screen.getByRole("button", { name: "Send message" });
    await waitFor(() => expect(sendButton).not.toBeDisabled());
    await user.click(sendButton);

    // The attach was attempted and rejected; prompt.submit must NOT have run.
    await waitFor(() =>
      expect(
        mocks.gatewayRequest.mock.calls.some(([method]) => method === "image.attach_bytes"),
      ).toBe(true),
    );
    expect(mocks.gatewayRequest.mock.calls.some(([method]) => method === "prompt.submit")).toBe(
      false,
    );
    // The chip is restored with the failure visible.
    expect(await screen.findByText("Couldn't attach")).toBeInTheDocument();
  });

  it("imports DOM-dropped files by uploading their bytes", async () => {
    // WKWebView never exposes filesystem paths on dropped Files, and Tauri's
    // drag-drop interception is disabled — DOM drops must go through the
    // bytes-based import.
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    const form = document.querySelector(".agent-composer");
    expect(form).not.toBeNull();
    fireEvent.drop(form as HTMLFormElement, {
      dataTransfer: {
        files: [new File(["hello"], "notes.txt", { type: "text/plain" })],
      },
    });

    expect(await screen.findByText("notes.txt")).toBeInTheDocument();
    expect(mocks.importHermesBridgeFileBytes).toHaveBeenCalledWith(
      "notes.txt",
      expect.any(Uint8Array),
    );
    expect(mocks.importHermesBridgeFile).not.toHaveBeenCalled();
  });

  it("imports pasted images by uploading clipboard bytes", async () => {
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    mocks.importHermesBridgeFileBytes.mockResolvedValueOnce({
      name: "pasted-image.png",
      path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace/uploads/pasted-image.png",
      rootLabel: "Workspace",
      size: 5,
      previewDataUrl: "data:image/png;base64,preview",
    });

    const image = new File(["image"], "", { type: "image/png" });
    const form = document.querySelector(".agent-composer");
    expect(form).not.toBeNull();
    fireEvent.paste(form as HTMLFormElement, {
      clipboardData: {
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => image,
          },
        ],
        files: [],
      },
    });

    expect(await screen.findByText("pasted-image.png")).toBeInTheDocument();
    expect(document.querySelector(".agent-attachment-chip img")).toHaveAttribute(
      "src",
      "data:image/png;base64,preview",
    );
    expect(mocks.importHermesBridgeFileBytes).toHaveBeenCalledWith(
      "pasted-image.png",
      expect.any(Uint8Array),
    );
    expect(mocks.importHermesBridgeFile).not.toHaveBeenCalled();
  });

  it("does not intercept /image while image generation is hidden", async () => {
    const user = userEvent.setup();
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    const composer = await screen.findByRole("textbox");
    await user.type(composer, "/image a red bicycle");
    const form = document.querySelector(".agent-composer");
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Image generation is not available.",
    );
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", expect.anything());
    expect(mocks.generateImage).not.toHaveBeenCalled();
    expect(mocks.importHermesBridgeFileBytes).not.toHaveBeenCalled();
  });

  it("chooses one preferred image when paste exposes multiple representations", async () => {
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    mocks.importHermesBridgeFileBytes.mockResolvedValueOnce({
      name: "image.png",
      path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace/uploads/image.png",
      rootLabel: "Workspace",
      size: 3,
      previewDataUrl: "data:image/png;base64,preview",
    });

    const tiff = new File(["tiff"], "image.tiff", { type: "image/tiff" });
    const png = new File(["png"], "image.png", { type: "image/png" });
    const form = document.querySelector(".agent-composer");
    expect(form).not.toBeNull();
    fireEvent.paste(form as HTMLFormElement, {
      clipboardData: {
        items: [
          {
            kind: "file",
            type: "image/tiff",
            getAsFile: () => tiff,
          },
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => png,
          },
        ],
        files: [],
      },
    });

    expect(await screen.findByText("image.png")).toBeInTheDocument();
    expect(mocks.importHermesBridgeFileBytes).toHaveBeenCalledTimes(1);
    expect(mocks.importHermesBridgeFileBytes).toHaveBeenCalledWith(
      "image.png",
      expect.any(Uint8Array),
    );
  });

  it("ignores pasted image formats that cannot preview as attachments", async () => {
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    const svg = new File(["<svg />"], "diagram.svg", {
      type: "image/svg+xml",
    });
    const form = document.querySelector(".agent-composer");
    expect(form).not.toBeNull();
    fireEvent.paste(form as HTMLFormElement, {
      clipboardData: {
        items: [
          {
            kind: "file",
            type: "image/svg+xml",
            getAsFile: () => svg,
          },
        ],
        files: [],
      },
    });

    expect(mocks.importHermesBridgeFileBytes).not.toHaveBeenCalled();
    expect(screen.queryByText("diagram.svg")).not.toBeInTheDocument();
  });

  it("keeps a re-sent duplicate message and the running state against older identical history", async () => {
    const user = userEvent.setup();
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "user",
        content: "continue",
        timestamp: "2026-06-04T12:00:00.000Z",
      },
      {
        id: "m2",
        role: "assistant",
        content: "older answer",
        timestamp: "2026-06-04T12:00:01.000Z",
      },
    ]);

    render(<AgentWorkspace />);

    expect(await screen.findByText("older answer")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox"), "continue");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "continue",
      }),
    );

    // The just-sent message must not be swallowed by the older identical one.
    expect(screen.getAllByText("continue")).toHaveLength(2);
    expect(screen.getByText("Thinking…")).toBeInTheDocument();

    // Let the working-gated poll (2.5s) refresh against the same old
    // history: the new pending "continue" must survive and the run must not
    // be marked finished against the old answer.
    const refreshCallsBefore = mocks.listHermesSessionMessages.mock.calls.length;
    await waitFor(
      () =>
        expect(mocks.listHermesSessionMessages.mock.calls.length).toBeGreaterThan(
          refreshCallsBefore,
        ),
      { timeout: 4000 },
    );
    // Give the refresh's state updates time to land before asserting.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(screen.getAllByText("continue")).toHaveLength(2);
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
  });

  it("resumes working state when the latest persisted message is a recent user prompt", async () => {
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "user",
        content: "long running task",
        timestamp: new Date(Date.now() - 60_000).toISOString(),
      },
    ]);

    render(<AgentWorkspace />);

    // A remount mid-run (navigation away and back) re-arms the working state
    // and poll instead of leaving the conversation frozen.
    expect(await screen.findByText("long running task")).toBeInTheDocument();
    expect(await screen.findByText("Thinking…")).toBeInTheDocument();
  });

  it("does not resume working state for a stale session that ended on a user message", async () => {
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "user",
        content: "thanks!",
        timestamp: "2026-06-01T12:00:00.000Z",
      },
    ]);

    render(<AgentWorkspace />);

    expect(await screen.findByText("thanks!")).toBeInTheDocument();
    expect(screen.queryByText("Thinking…")).toBeNull();
  });

  it("refreshes the session list after an event-driven new session run", async () => {
    render(<AgentWorkspace />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    const callsBefore = mocks.listHermesSessions.mock.calls.length;

    window.dispatchEvent(
      new CustomEvent(AGENT_NEW_SESSION_EVENT, {
        detail: { prompt: "write a project update" },
      }),
    );

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "write a project update",
      }),
    );
    // The mount-time listener must call through to the latest handlers — a
    // first-render closure would no-op loadHermesSessions (bridge not yet
    // running) and the sidebar would never refresh.
    await waitFor(() =>
      expect(mocks.listHermesSessions.mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });

  it("holds session broadcasts until the first fetch lands", async () => {
    const sessionDetails: AgentSessionsChangedDetail[] = [];
    const onSessionsChanged = (event: Event) =>
      sessionDetails.push((event as CustomEvent<AgentSessionsChangedDetail>).detail);
    window.addEventListener(AGENT_SESSIONS_CHANGED_EVENT, onSessionsChanged);

    // First click after app launch: the workspace mounts seeded with only the
    // clicked session while listHermesSessions is still in flight. The sidebar
    // replaces its list wholesale with each broadcast, so a pre-fetch
    // broadcast would collapse it to one row and flicker it back.
    let resolveSessions: (sessions: (typeof existingSession)[]) => void = () => undefined;
    mocks.listHermesSessions.mockImplementation(
      () =>
        new Promise<(typeof existingSession)[]>((resolve) => {
          resolveSessions = resolve;
        }),
    );
    const clickedSession = {
      id: "session-2",
      title: "Clicked session",
      preview: "Clicked preview",
      last_active: "2026-06-05T12:00:00Z",
    };

    try {
      render(<AgentWorkspace initialSession={clickedSession} />);

      await waitFor(() => expect(mocks.listHermesSessions).toHaveBeenCalled());
      expect(sessionDetails).toEqual([]);

      await act(async () => {
        resolveSessions([clickedSession, existingSession]);
      });

      await waitFor(() => expect(sessionDetails.length).toBeGreaterThan(0));
      expect(sessionDetails[0].sessions.map((session) => session.id)).toEqual([
        "session-2",
        "session-1",
      ]);
      expect(sessionDetails[0].selectedSessionId).toBe("session-2");
    } finally {
      window.removeEventListener(AGENT_SESSIONS_CHANGED_EVENT, onSessionsChanged);
    }
  });

  it("scrubs working state when deleting the selected session from the session bar", async () => {
    const user = userEvent.setup();
    const sessionDetails: AgentSessionsChangedDetail[] = [];
    const onSessionsChanged = (event: Event) =>
      sessionDetails.push((event as CustomEvent<AgentSessionsChangedDetail>).detail);
    window.addEventListener(AGENT_SESSIONS_CHANGED_EVENT, onSessionsChanged);

    try {
      render(<AgentWorkspace />);
      expect(await screen.findByText("Existing session")).toBeInTheDocument();

      await user.type(screen.getByRole("textbox"), "do something long");
      await user.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() => expect(sessionDetails.at(-1)?.workingSessionIds).toContain("session-1"));

      mocks.listHermesSessions.mockResolvedValue([]);
      await user.click(screen.getByRole("button", { name: "Session actions" }));
      await user.click(screen.getByRole("menuitem", { name: "Delete session" }));

      await waitFor(() => expect(mocks.deleteHermesSession).toHaveBeenCalledWith("session-1"));
      await waitFor(() => {
        const last = sessionDetails.at(-1);
        expect(last?.workingSessionIds).toEqual([]);
        expect(last?.sessions.map((session) => session.id)).not.toContain("session-1");
      });
    } finally {
      window.removeEventListener(AGENT_SESSIONS_CHANGED_EVENT, onSessionsChanged);
    }
  });

  it("launches a session immediately from a run shortcut", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now() }),
    );
    // rand() of 0 keeps the rotating hero suggestions in curated pool order,
    // so the leading window (incl. "Catch up on recent files") is what renders.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      render(<AgentWorkspace />);
      const user = userEvent.setup();

      await user.click(await screen.findByRole("button", { name: /Catch up on recent files/ }));

      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith(
          "prompt.submit",
          expect.objectContaining({
            text: expect.stringContaining("changed in the last week"),
          }),
        ),
      );
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("opens the conversation while a typed submit creates the session", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now() }),
    );
    // Hold session.create open so the optimistic handoff is observable: the
    // user should land in the conversation immediately instead of waiting for
    // the runtime session to be created.
    let releaseCreate: (() => void) | undefined;
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.create") {
        return new Promise((resolve) => {
          releaseCreate = () =>
            resolve({
              session_id: "runtime-session-2",
              stored_session_id: "session-2",
            });
        });
      }
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    render(<AgentWorkspace />);

    await user.type(await screen.findByRole("textbox"), "first task");
    await user.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() => expect(releaseCreate).toBeDefined());
    await waitFor(() => expect(screen.queryByText(HERO_GREETING)).not.toBeInTheDocument());
    expect(screen.getAllByText("first task").length).toBeGreaterThan(0);
    expect(mocks.listHermesSessionMessages).not.toHaveBeenCalledWith(
      expect.stringMatching(/^pending:new-session:/),
    );

    act(() => releaseCreate?.());

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith(
        "prompt.submit",
        expect.objectContaining({
          session_id: "runtime-session-2",
          text: "first task",
        }),
      ),
    );
    expect(screen.getAllByText("first task").length).toBeGreaterThan(0);
  });

  it("waits for the bridge session before selecting a new persisted Hermes session", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now() }),
    );
    let bridgeSessionPersisted = false;
    let releaseEnsure: (() => void) | undefined;
    mocks.ensureHermesBridgeSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseEnsure = () => {
            bridgeSessionPersisted = true;
            resolve({});
          };
        }),
    );
    mocks.listHermesSessionMessages.mockImplementation(async (sessionId: string) => {
      if (sessionId === "session-2" && !bridgeSessionPersisted) {
        throw new Error('Hermes API returned 404 Not Found: {"detail":"Session not found"}');
      }
      return [];
    });

    const user = userEvent.setup();
    render(<AgentWorkspace />);

    await user.type(await screen.findByRole("textbox"), "first task");
    await user.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() =>
      expect(mocks.ensureHermesBridgeSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "session-2" }),
      ),
    );
    expect(releaseEnsure).toBeDefined();

    vi.useFakeTimers();
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
        await Promise.resolve();
      });

      expect(mocks.listHermesSessionMessages).not.toHaveBeenCalledWith("session-2");
      expect(screen.queryByText(/Hermes API returned 404/)).toBeNull();

      act(() => releaseEnsure?.());
    } finally {
      vi.useRealTimers();
    }

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "first task",
      }),
    );
    await waitFor(() => expect(mocks.listHermesSessionMessages).toHaveBeenCalledWith("session-2"));
    expect(screen.queryByText(/Hermes API returned 404/)).toBeNull();
  });

  it("restores the hero when optimistic session creation fails", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now() }),
    );
    const sessionDetails: AgentSessionsChangedDetail[] = [];
    const onSessionsChanged = (event: Event) =>
      sessionDetails.push((event as CustomEvent<AgentSessionsChangedDetail>).detail);
    window.addEventListener(AGENT_SESSIONS_CHANGED_EVENT, onSessionsChanged);

    let rejectCreate: (() => void) | undefined;
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.create") {
        return new Promise((_, reject) => {
          rejectCreate = () => reject(new Error("create failed"));
        });
      }
      return Promise.resolve({});
    });

    try {
      const user = userEvent.setup();
      render(<AgentWorkspace />);

      await user.type(await screen.findByRole("textbox"), "first task");
      await user.click(screen.getByRole("button", { name: "Start session" }));

      await waitFor(() => expect(rejectCreate).toBeDefined());
      await waitFor(() => expect(screen.queryByText(HERO_GREETING)).not.toBeInTheDocument());
      expect(screen.getAllByText("first task").length).toBeGreaterThan(0);

      act(() => rejectCreate?.());

      expect(await screen.findByText(HERO_GREETING)).toBeInTheDocument();
      expect(screen.getByText(/create failed/)).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.getByRole("textbox").textContent ?? "").toContain("first task"),
      );
      expect(mocks.listHermesSessionMessages).not.toHaveBeenCalledWith(
        expect.stringMatching(/^pending:new-session:/),
      );
      expect(
        sessionDetails.some(
          (detail) =>
            detail.selectedSessionId?.startsWith("pending:new-session:") ||
            detail.sessions.some((session) => session.id.startsWith("pending:new-session:")),
        ),
      ).toBe(false);
    } finally {
      window.removeEventListener(AGENT_SESSIONS_CHANGED_EVENT, onSessionsChanged);
    }
  });

  it("prefills the composer from a prefill shortcut without submitting", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now() }),
    );
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      render(<AgentWorkspace />);
      const user = userEvent.setup();

      await user.click(await screen.findByRole("button", { name: /Research a topic/ }));

      const composer = screen.getByRole("textbox");
      await waitFor(() => expect(composer.textContent ?? "").toContain("Research <topic>"));
      expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", expect.anything());
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("opens the hero model catalog in a contained second-layer surface", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now() }),
    );
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: "zai-org-glm-5-2",
      models: [
        {
          provider: "venice",
          id: "zai-org-glm-5-2",
          name: "GLM 5.2",
          modelType: "text",
          privacy: "private",
          traits: [],
          capabilities: ["functionCalling"],
        },
        {
          provider: "venice",
          id: "kimi-k2-6",
          name: "Kimi K2.6",
          modelType: "text",
          privacy: "private",
          traits: [],
          capabilities: ["functionCalling"],
        },
        {
          provider: "venice",
          id: "zai-org-glm-5-1",
          name: "GLM 5.1",
          modelType: "text",
          privacy: "private",
          traits: [],
          capabilities: ["functionCalling"],
        },
        {
          provider: "venice",
          id: "tool-less",
          name: "Tool-less model",
          modelType: "text",
          privacy: "private",
          traits: [],
          capabilities: [],
        },
      ],
    });
    const user = userEvent.setup();
    render(<AgentWorkspace />);

    await user.click(await screen.findByRole("button", { name: "Model: GLM 5.2" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Choose text model",
    });
    await user.click(within(dialog).getByRole("button", { name: "All models" }));

    const panel = await screen.findByRole("group", { name: "All text models" });
    expect(panel.firstElementChild).toHaveClass("agent-composer-model-surface");
    expect(within(panel).getByRole("textbox", { name: "Search models" })).toBeInTheDocument();
    expect(within(panel).getByRole("option", { name: /GLM 5.1/ })).toBeInTheDocument();
    expect(
      within(panel).queryByRole("option", { name: /Tool-less model/ }),
    ).not.toBeInTheDocument();
  });

  it("starts a new session unrestricted only after the explicit opt-in", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now() }),
    );
    const user = userEvent.setup();
    render(<AgentWorkspace />);

    // The picker rests on Sandboxed for a fresh hero.
    const trigger = await screen.findByRole("button", { name: "Sandboxed" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    // Submitting without the opt-in must not touch the runtime's mode — the
    // running sandboxed bridge is reused as-is.
    await user.type(screen.getByRole("textbox"), "first task");
    await user.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith(
        "prompt.submit",
        expect.objectContaining({ text: "first task" }),
      ),
    );
    expect(mocks.startHermesBridge).not.toHaveBeenCalled();

    // Re-entering the hero re-arms the picker to Sandboxed. Choosing
    // Unrestricted from the menu routes through the confirm dialog before
    // arming; submitting then restarts the runtime unsandboxed.
    act(() => {
      window.dispatchEvent(new CustomEvent(AGENT_NEW_SESSION_EVENT));
    });
    const rearmed = await screen.findByRole("button", { name: "Sandboxed" });
    await user.click(rearmed);
    await user.click(screen.getByRole("menuitemradio", { name: /^Unrestricted/ }));
    expect(screen.queryByRole("menu", { name: "What can June change?" })).not.toBeInTheDocument();
    // Not armed until the dialog confirms.
    expect(screen.getByRole("button", { name: "Sandboxed" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Turn on Unrestricted" }));
    expect(screen.getByRole("button", { name: "Unrestricted" })).toBeInTheDocument();

    await user.type(screen.getByRole("textbox"), "risky task");
    await user.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() => expect(mocks.startHermesBridge).toHaveBeenCalledWith(undefined, true));

    // The confirm is once per app session: with the acknowledgment stored,
    // the next arm goes straight through without the dialog.
    act(() => {
      window.dispatchEvent(new CustomEvent(AGENT_NEW_SESSION_EVENT));
    });
    await user.click(await screen.findByRole("button", { name: "Sandboxed" }));
    await user.click(screen.getByRole("menuitemradio", { name: /^Unrestricted/ }));
    expect(screen.queryByRole("button", { name: "Turn on Unrestricted" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unrestricted" })).toBeInTheDocument();
  });

  it("moves focus into the sandbox menu and restores it on close", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now() }),
    );
    const user = userEvent.setup();
    render(<AgentWorkspace />);

    const trigger = await screen.findByRole("button", { name: "Sandboxed" });
    await user.click(trigger);

    const firstOption = screen.getByRole("menuitemradio", {
      name: /^Sandboxed/,
    });
    expect(firstOption).toHaveFocus();

    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByRole("menu", { name: "What can June change?" })).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });

  it("shows the unrestricted badge only on sessions that opted in", async () => {
    window.localStorage.setItem(
      "june.agent.unrestrictedSessions",
      JSON.stringify({ "session-1": true }),
    );

    render(<AgentWorkspace initialSession={existingSession} />);

    expect(await screen.findByText("Unrestricted")).toBeInTheDocument();
    expect(screen.getByLabelText(/Unrestricted - This session runs without/)).toBeInTheDocument();
  });

  it("keeps the badge off a sandboxed session even while the runtime is unsandboxed", async () => {
    // Another session's opt-in has the unrestricted runtime up; this session
    // never opted in, and its sends route to the sandboxed process — no badge.
    mocks.hermesBridgeStatus.mockResolvedValue({
      running: true,
      connection: {
        port: 61234,
        wsUrl: "ws://127.0.0.1:61234",
        fullMode: true,
      },
    });

    render(<AgentWorkspace initialSession={existingSession} />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    expect(screen.queryByText("Unrestricted")).not.toBeInTheDocument();
  });

  it("restores the sandbox before a follow-up to a session that never opted in", async () => {
    const user = userEvent.setup();
    // The runtime is still unsandboxed from another session's opt-in.
    mocks.hermesBridgeStatus.mockResolvedValue({
      running: true,
      connection: {
        port: 61234,
        wsUrl: "ws://127.0.0.1:61234",
        fullMode: true,
      },
    });

    render(<AgentWorkspace initialSession={existingSession} />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox"), "hello");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    // The send brings up the sandboxed process for this session — the
    // unrestricted one (and its in-flight work) is left alone.
    await waitFor(() => expect(mocks.startHermesBridge).toHaveBeenCalledWith(undefined, false));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith(
        "prompt.submit",
        expect.objectContaining({ text: "hello" }),
      ),
    );
  });

  it("keeps an opted-in session unrestricted across follow-ups", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "june.agent.unrestrictedSessions",
      JSON.stringify({ "session-1": true }),
    );
    // The runtime has since dropped back to the sandbox (relaunch, or a
    // sandboxed session ran in between).
    mocks.hermesBridgeStatus.mockResolvedValue({
      running: true,
      connection: { port: 61234, wsUrl: "ws://127.0.0.1:61234" },
    });

    render(<AgentWorkspace initialSession={existingSession} />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox"), "continue");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(mocks.startHermesBridge).toHaveBeenCalledWith(undefined, true));
  });

  it("serves both modes concurrently — neither runtime is torn down", async () => {
    const user = userEvent.setup();
    // session-1 opted into Unrestricted; both runtime processes are up.
    window.localStorage.setItem(
      "june.agent.unrestrictedSessions",
      JSON.stringify({ "session-1": true }),
    );
    const sandboxedConnection = {
      port: 61234,
      wsUrl: "ws://127.0.0.1:61234",
      fullMode: false,
    };
    const unrestrictedConnection = {
      port: 61235,
      wsUrl: "ws://127.0.0.1:61235",
      fullMode: true,
    };
    mocks.hermesBridgeStatus.mockResolvedValue({
      running: true,
      connection: sandboxedConnection,
      connections: [sandboxedConnection, unrestrictedConnection],
    });

    render(<AgentWorkspace initialSession={existingSession} />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    // Follow-up to the unrestricted session rides its own gateway.
    await user.type(screen.getByRole("textbox"), "continue");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith(
        "prompt.submit",
        expect.objectContaining({ text: "continue" }),
      ),
    );

    // A fresh sandboxed session starts alongside it on the other gateway.
    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_NEW_SESSION_EVENT, {
          detail: { prompt: "new sandboxed work" },
        }),
      );
    });
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith(
        "prompt.submit",
        expect.objectContaining({ text: "new sandboxed work" }),
      ),
    );

    // Both processes were already up: no start call, one socket per mode,
    // and crucially nothing closed the other mode's gateway mid-flight.
    expect(mocks.startHermesBridge).not.toHaveBeenCalled();
    const connectedUrls = mocks.gatewayInstances.flatMap((instance) =>
      instance.connect.mock.calls.map((call) => call[0]),
    );
    expect(connectedUrls).toContain("ws://127.0.0.1:61235");
    expect(connectedUrls).toContain("ws://127.0.0.1:61234");
    for (const instance of mocks.gatewayInstances) {
      expect(instance.close).not.toHaveBeenCalled();
    }
  });

  it("explains a busy rejection and removes the ghost bubble", async () => {
    const user = userEvent.setup();
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "prompt.submit") {
        return Promise.reject(new HermesGatewayError("session busy", 4009));
      }
      return Promise.resolve({});
    });

    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    const composer = screen.getByRole("textbox");
    await user.type(composer, "are the subagents using my CLI?");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "are the subagents using my CLI?",
      }),
    );
    // The user learns what's happening in plain language, not "session busy".
    expect(
      await screen.findByText(/June is still working on the previous message/),
    ).toBeInTheDocument();
    // The rejected prompt never entered the session: no optimistic bubble
    // lingers in the transcript (it would render below later persisted
    // messages as a send the agent ignored), and the draft comes back.
    expect(document.querySelector(".agent-user-turn")).toBeNull();
    expect(composer).toHaveTextContent("are the subagents using my CLI?");
    // The previous turn is still running, so the live listener stays attached.
    expect(mocks.gatewayEventHandlers.size).toBe(1);
  });

  it("offers retry and dismiss on a connection-shaped error banner", async () => {
    const user = userEvent.setup();
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "prompt.submit") {
        return Promise.reject(new Error("Hermes gateway is not connected."));
      }
      return Promise.resolve({});
    });

    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox"), "hello");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("Hermes gateway is not connected.")).toBeInTheDocument();
    // Connection-shaped failures are the retryable ones — reconnecting can fix
    // them, unlike one-off action failures which only offer dismiss.
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Hermes gateway is not connected.")).toBeNull();
  });

  it("renders an out-of-credits notice with an upgrade action instead of the raw 402 error", async () => {
    const user = userEvent.setup();
    mocks.osAccountsUpgrade.mockResolvedValue(undefined);
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "user",
        content: "How are the subagents doing",
        timestamp: "2026-06-10T10:00:00Z",
      },
      {
        id: "m2",
        role: "assistant",
        content:
          "Error: Error code: 402 - {'data': None, 'success': False, 'error_code': 4301, 'message': 'insufficient_credits'}",
        timestamp: "2026-06-10T10:00:01Z",
      },
    ]);

    render(<AgentWorkspace />);

    expect(
      await screen.findByText(/June stopped because your balance ran out/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Error code: 402/)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Upgrade" }));
    expect(mocks.osAccountsUpgrade).toHaveBeenCalledOnce();
  });

  it("renders an out-of-credits notice with a top-up action for subscribed users", async () => {
    const user = userEvent.setup();
    const onTopUp = vi.fn();
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "user",
        content: "How are the subagents doing",
        timestamp: "2026-06-10T10:00:00Z",
      },
      {
        id: "m2",
        role: "assistant",
        content:
          "Error: Error code: 402 - {'data': None, 'success': False, 'error_code': 4301, 'message': 'insufficient_credits'}",
        timestamp: "2026-06-10T10:00:01Z",
      },
    ]);

    render(<AgentWorkspace onTopUp={onTopUp} topUpLabel="Top up credits" />);

    expect(
      await screen.findByText(/June stopped because your balance ran out/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Top up credits" }));
    expect(onTopUp).toHaveBeenCalledOnce();
    expect(mocks.osAccountsUpgrade).not.toHaveBeenCalled();
  });

  it("shows every error surface via the __agentErrors() dev handle", async () => {
    const agentErrors = (window as unknown as { __agentErrors: (show?: boolean) => string })
      .__agentErrors;
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    act(() => void agentErrors());

    try {
      expect(await screen.findByText("Agent error gallery")).toBeInTheDocument();
      // Turn-level samples from the catalog (section label + the card itself)…
      expect(screen.getAllByText("Out of credits").length).toBeGreaterThan(0);
      expect(screen.getByRole("button", { name: "Upgrade" })).toBeInTheDocument();
      // …plus the forced chrome samples the turn gallery can't represent.
      expect(screen.getByText("Could not connect to Hermes gateway.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
      expect(screen.getByText(/June is still working on the previous message/)).toBeInTheDocument();
    } finally {
      // Always reset the module-level desired state — a failure here must not
      // leave the gallery on and cascade into later workspace mounts.
      act(() => void agentErrors(false));
    }
    await waitFor(() => expect(screen.queryByText("Agent error gallery")).toBeNull());
  });

  it("does not let a stale message fetch erase a newer follow-up", async () => {
    // The selection effect, working poll, and terminal-event refresh all
    // fetch session messages without awaiting each other. A slow fetch that
    // started first can resolve last; applying it as a whole-list overwrite
    // used to erase the follow-up the newer fetch had just persisted (and
    // whose optimistic bubble was dropped at that point) — the user's
    // message visibly vanished until a later refresh restored it.
    const user = userEvent.setup();
    const oldHistory = [
      {
        id: "m1",
        role: "user",
        content: "previous request",
        timestamp: "2026-06-04T12:00:00.000Z",
      },
      {
        id: "m2",
        role: "assistant",
        content: "previous answer",
        timestamp: "2026-06-04T12:00:01.000Z",
      },
    ];
    let resolveStale: (value: unknown) => void = () => {};
    const stale = new Promise((resolve) => {
      resolveStale = resolve;
    });
    mocks.listHermesSessionMessages
      .mockImplementationOnce(() => stale) // the mount-selection fetch hangs
      .mockImplementation(async () => [
        ...oldHistory,
        {
          id: "m3",
          role: "user",
          content: "follow up while racing",
          timestamp: new Date().toISOString(),
        },
        {
          id: "m4",
          role: "assistant",
          content: "raced reply",
          timestamp: new Date().toISOString(),
        },
      ]);
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      return Promise.resolve({});
    });
    // Hold the submit just before completion so the working poll's interval
    // is created on the fake clock (a real-clock interval can't be advanced).
    let resolveEnsureSession: (value: unknown) => void = () => {};
    mocks.ensureHermesBridgeSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveEnsureSession = resolve;
        }),
    );

    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox"), "follow up while racing");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(mocks.ensureHermesBridgeSession).toHaveBeenCalled());

    vi.useFakeTimers();
    try {
      await act(async () => {
        resolveEnsureSession({});
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "follow up while racing",
      });

      // The working poll's refresh applies the newer history (follow-up +
      // reply persisted; the optimistic bubble is dropped against it).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      expect(screen.getByText("raced reply")).toBeInTheDocument();

      // The stale mount-time fetch finally resolves — without per-session
      // fetch ordering this overwrote the list and the follow-up vanished.
      await act(async () => {
        resolveStale(oldHistory);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByText("follow up while racing")).toBeInTheDocument();
      expect(screen.getByText("raced reply")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  // Last in the suite: mounting the workspace kicks off bridge/session
  // bootstrap promises that can leak into a later test's pending-session
  // flow, so nothing runs after this one.
  it("renders origin crumbs and back arrow in the sticky session bar", async () => {
    const onBack = vi.fn();
    const onOpenProjects = vi.fn();
    render(
      <AgentWorkspace
        initialSession={existingSession}
        origin={{
          backLabel: "Back to June",
          onBack,
          crumbs: [
            { label: "Projects", onClick: onOpenProjects },
            { label: "June", onClick: onBack },
          ],
        }}
      />,
    );

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("June")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to June" }));
    expect(onBack).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    expect(onOpenProjects).toHaveBeenCalled();
  });

  // Feature 10: a model change must reach the LIVE session through Hermes
  // command.dispatch (/model …), not just rewrite the default — and the UI must
  // never claim the running session switched unless Hermes accepted it.
  describe("active-session model switching (feature 10)", () => {
    const toolCapableCatalog = [
      {
        provider: "venice",
        id: "zai-org-glm-5-2",
        name: "GLM 5.2",
        modelType: "text",
        privacy: "private",
        traits: [],
        capabilities: ["functionCalling"],
      },
      {
        provider: "venice",
        id: "kimi-k2-6",
        name: "Kimi K2.6",
        modelType: "text",
        privacy: "private",
        traits: [],
        capabilities: ["functionCalling"],
      },
    ];

    it("dispatches /model to the open session and confirms the switch", async () => {
      mocks.listVeniceModels.mockResolvedValue({
        mode: "generation",
        modelType: "text",
        selectedModel: "zai-org-glm-5-2",
        models: toolCapableCatalog,
      });
      mocks.setVeniceModel.mockResolvedValue(undefined);
      const user = userEvent.setup();

      render(<AgentWorkspace initialSession={existingSession} />);

      await user.click(await screen.findByRole("button", { name: "Model: GLM 5.2" }));
      const dialog = await screen.findByRole("dialog", {
        name: "Choose text model",
      });
      await user.click(within(dialog).getByRole("option", { name: /Kimi K2\.6/ }));

      // The model is overridden for this chat only. The bridge session ensure
      // path is title-only, so model changes are not persisted through REST.
      expect(mocks.ensureHermesBridgeSession).not.toHaveBeenCalledWith({
        sessionId: "session-1",
        model: "kimi-k2-6",
      });
      // The global default is left untouched.
      expect(mocks.setVeniceModel).not.toHaveBeenCalled();
      // …AND the live session is switched via command.dispatch (/model …).
      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("command.dispatch", {
          session_id: "session-1",
          command: "/model kimi-k2-6",
        }),
      );
      expect(await screen.findByText("Switched this session to Kimi K2.6.")).toBeInTheDocument();
    });

    it("dispatches /model from the composer slash command", async () => {
      mocks.listVeniceModels.mockResolvedValue({
        mode: "generation",
        modelType: "text",
        selectedModel: "zai-org-glm-5-2",
        models: toolCapableCatalog,
      });
      const user = userEvent.setup();

      render(<AgentWorkspace initialSession={existingSession} />);

      const composer = await screen.findByRole("textbox", {
        name: "Message June",
      });
      await user.type(composer, "/model kimi");
      await user.click(screen.getByRole("button", { name: "Send message" }));

      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("command.dispatch", {
          session_id: "session-1",
          command: "/model kimi-k2-6",
        }),
      );
      expect(mocks.ensureHermesBridgeSession).not.toHaveBeenCalledWith({
        sessionId: "session-1",
        model: "kimi-k2-6",
      });
      expect(mocks.gatewayRequest.mock.calls.some(([method]) => method === "prompt.submit")).toBe(
        false,
      );
      expect(composer.textContent).toBe("");
      expect(await screen.findByText("Switched this session to Kimi K2.6.")).toBeInTheDocument();
    });

    it("changes only the default when no session is active and does not dispatch", async () => {
      // Hero with a pending-new-session marker: no session is open, so the
      // composer shows the model trigger without auto-creating a session.
      window.sessionStorage.setItem(
        AGENT_NEW_SESSION_PENDING_KEY,
        JSON.stringify({ createdAt: Date.now() }),
      );
      mocks.listVeniceModels.mockResolvedValue({
        mode: "generation",
        modelType: "text",
        selectedModel: "zai-org-glm-5-2",
        models: toolCapableCatalog,
      });
      mocks.setVeniceModel.mockResolvedValue(undefined);
      const user = userEvent.setup();

      render(<AgentWorkspace />);

      // Hero (no open session): the composer still carries the model trigger.
      await user.click(await screen.findByRole("button", { name: "Model: GLM 5.2" }));
      const dialog = await screen.findByRole("dialog", {
        name: "Choose text model",
      });
      await user.click(within(dialog).getByRole("option", { name: /Kimi K2\.6/ }));

      await waitFor(() =>
        expect(mocks.setVeniceModel).toHaveBeenCalledWith("generation", "kimi-k2-6"),
      );
      expect(
        await screen.findByText("Default model updated. It applies to new sessions."),
      ).toBeInTheDocument();
      // No live session, so nothing is dispatched to the gateway.
      expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("command.dispatch", expect.anything());
    });

    it("shows a failure notice and does not claim success when the dispatch is rejected", async () => {
      mocks.listVeniceModels.mockResolvedValue({
        mode: "generation",
        modelType: "text",
        selectedModel: "zai-org-glm-5-2",
        models: toolCapableCatalog,
      });
      mocks.setVeniceModel.mockResolvedValue(undefined);
      mocks.gatewayRequest.mockImplementation((method: string) => {
        if (method === "command.dispatch") {
          return Promise.reject(new Error("model switch refused"));
        }
        if (method === "session.resume") {
          return Promise.resolve({ session_id: "runtime-session-1" });
        }
        return Promise.resolve({});
      });
      const user = userEvent.setup();

      render(<AgentWorkspace initialSession={existingSession} />);

      await user.click(await screen.findByRole("button", { name: "Model: GLM 5.2" }));
      const dialog = await screen.findByRole("dialog", {
        name: "Choose text model",
      });
      await user.click(within(dialog).getByRole("option", { name: /Kimi K2\.6/ }));

      expect(
        await screen.findByText(
          "Could not switch the running session. This chat will use the new model next time.",
        ),
      ).toBeInTheDocument();
      // Never the success copy when Hermes rejected the switch.
      expect(screen.queryByText("Switched this session to Kimi K2.6.")).not.toBeInTheDocument();
    });

    it("keeps tool-incapable models out of the picker for the agent", async () => {
      mocks.listVeniceModels.mockResolvedValue({
        mode: "generation",
        modelType: "text",
        selectedModel: "zai-org-glm-5-2",
        models: [
          ...toolCapableCatalog,
          {
            provider: "venice",
            id: "e2ee-no-tools",
            name: "Enclave Mini",
            modelType: "text",
            privacy: "e2ee",
            traits: ["e2ee"],
            capabilities: [],
          },
        ],
      });
      const user = userEvent.setup();

      render(<AgentWorkspace initialSession={existingSession} />);

      await user.click(await screen.findByRole("button", { name: "Model: GLM 5.2" }));
      const dialog = await screen.findByRole("dialog", {
        name: "Choose text model",
      });
      // The tool-less model is filtered out everywhere, including the full
      // catalog behind All models — the agent can never pick it.
      await user.click(within(dialog).getByRole("button", { name: "All models" }));
      const panel = await screen.findByRole("group", {
        name: "All text models",
      });
      expect(within(panel).queryByRole("option", { name: /Enclave Mini/ })).not.toBeInTheDocument();
    });
  });
});
