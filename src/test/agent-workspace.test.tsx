import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_DELETE_SESSION_EVENT,
  AGENT_NEW_SESSION_EVENT,
  AGENT_NEW_SESSION_PENDING_KEY,
  AGENT_SESSIONS_CHANGED_EVENT,
  AgentWorkspace,
  HERO_GREETINGS,
  resetAgentSessionContinuity,
  type AgentSessionsChangedDetail,
} from "../components/agent/AgentWorkspace";
import {
  ANONYMOUS_MODEL_DESCRIPTION,
  E2EE_MODEL_DESCRIPTION,
  PROVIDER_MODEL_SETTINGS_CHANGED_EVENT,
} from "../lib/model-privacy";
import { HermesGatewayError } from "../lib/hermes-gateway";

// The hero greeting cycles per visit, so tests match any entry in the pool.
const HERO_GREETING = new RegExp(
  `^(?:${HERO_GREETINGS.map((greeting) => greeting.replace("?", "\\?")).join("|")})$`,
);

const mocks = vi.hoisted(() => ({
  cancelAgentTask: vi.fn(),
  createAgentTask: vi.fn(),
  ensureHermesBridgeSession: vi.fn(),
  getAgentTask: vi.fn(),
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
  osAccountsTopUp: vi.fn(),
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
  ensureHermesBridgeSession: mocks.ensureHermesBridgeSession,
  getAgentTask: mocks.getAgentTask,
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
  osAccountsTopUp: mocks.osAccountsTopUp,
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
  updateHermesBridgeMessagingPlatform:
    mocks.updateHermesBridgeMessagingPlatform,
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
      mocks.gatewayInstances.push(
        this as unknown as (typeof mocks.gatewayInstances)[number],
      );
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

describe("AgentWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gatewayEventHandlers.clear();
    mocks.gatewayInstances.length = 0;
    // Auto-cleanup unmounts the workspace after each test, which snapshots
    // any still-working session for the next mount — across tests that would
    // leak one test's mid-run session into the next.
    resetAgentSessionContinuity();
    window.sessionStorage.clear();
    window.localStorage.clear();
    mocks.listAgentTasks.mockResolvedValue({ items: [existingTask] });
    mocks.providerModelSettings.mockResolvedValue({
      settings: {
        transcriptionProvider: "venice",
        transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
        generationModel: "zai-org-glm-5-1",
      },
    });
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: "zai-org-glm-5-1",
      models: [
        {
          provider: "venice",
          id: "zai-org-glm-5-1",
          name: "GLM 5.1",
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
    mocks.startHermesBridge.mockImplementation(
      async (_cwd?: string, fullMode?: boolean) => {
        const connection = {
          port: 61234,
          wsUrl: "ws://127.0.0.1:61234",
          fullMode: Boolean(fullMode),
        };
        return { running: true, connection, connections: [connection] };
      },
    );
    mocks.listHermesSessions.mockResolvedValue([existingSession]);
    mocks.listHermesSessionMessages.mockResolvedValue([]);
    mocks.hermesAgentCliAccess.mockResolvedValue({ enabled: false });
    mocks.hermesBridgeFilesystemSnapshot.mockResolvedValue({ roots: [] });
    mocks.hermesBridgeFilePreview.mockResolvedValue(null);
    mocks.hermesBridgeFileText.mockResolvedValue(null);
    mocks.importHermesBridgeFile.mockImplementation(async (path: string) => ({
      name: path.split("/").pop() ?? "attachment",
      path: `/Users/junho/Library/Application Support/co.opensoftware.scribe/hermes/workspace/uploads/${path.split("/").pop() ?? "attachment"}`,
      rootLabel: "Workspace",
      size: 1234,
      previewDataUrl: path.endsWith(".png")
        ? "data:image/png;base64,preview"
        : null,
    }));
    mocks.importHermesBridgeFileBytes.mockImplementation(
      async (name: string) => ({
        name,
        path: `/Users/junho/Library/Application Support/co.opensoftware.scribe/hermes/workspace/uploads/${name}`,
        rootLabel: "Workspace",
        size: 5,
        previewDataUrl: null,
      }),
    );
    mocks.downloadHermesBridgeFile.mockResolvedValue(
      "/Users/junho/Downloads/sample.pdf",
    );
    mocks.ensureHermesBridgeSession.mockResolvedValue({});
    mocks.deleteHermesSession.mockResolvedValue(undefined);
    mocks.suggestAgentSessionTitle.mockResolvedValue({
      title: "Summarize Current Page",
    });
    mocks.explainAgentApproval.mockResolvedValue({
      explanation:
        "This deletes the build folder, then rebuilds the project from scratch.",
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
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now() }),
    );

    render(<AgentWorkspace />);

    expect(await screen.findByText(HERO_GREETING)).toBeInTheDocument();
    await waitFor(() => expect(mocks.listHermesSessions).toHaveBeenCalled());
    expect(screen.queryByText("Existing session")).toBeNull();
    expect(screen.queryByText("Existing task")).toBeNull();
    expect(
      window.sessionStorage.getItem(AGENT_NEW_SESSION_PENDING_KEY),
    ).toBeNull();
  });

  it("never announces the restored session as selected while a New Session is pending", async () => {
    // Regression: "New session" from inside a project arms the pending marker
    // and remounts the workspace. Initializing from the last-open restore used
    // to dispatch a mount-time sessions-changed event selecting the old
    // session, which App reads as "switched to existing work" — dropping the
    // pending project assignment before the new session exists.
    window.localStorage.setItem("scribe:agent:last-open-session", "session-1");
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now() }),
    );
    const sessionDetails: AgentSessionsChangedDetail[] = [];
    const onSessionsChanged = (event: Event) =>
      sessionDetails.push(
        (event as CustomEvent<AgentSessionsChangedDetail>).detail,
      );
    window.addEventListener(AGENT_SESSIONS_CHANGED_EVENT, onSessionsChanged);

    try {
      render(<AgentWorkspace />);

      expect(await screen.findByText(HERO_GREETING)).toBeInTheDocument();
      // The broadcast lands a few microtasks after the fetch resolves, so
      // wait for the event itself rather than just the fetch call.
      await waitFor(() => expect(sessionDetails.length).toBeGreaterThan(0));
      expect(
        sessionDetails.every((detail) => detail.selectedSessionId == null),
      ).toBe(true);
    } finally {
      window.removeEventListener(
        AGENT_SESSIONS_CHANGED_EVENT,
        onSessionsChanged,
      );
    }
  });

  it("prefills the issue report template without submitting", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), kind: "issue-report" }),
    );

    render(<AgentWorkspace />);

    const composer = (await screen.findByPlaceholderText(
      "Describe a task for June…",
    )) as HTMLTextAreaElement;
    await waitFor(() =>
      expect(composer.value).toContain("I want to report an issue with June."),
    );
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith(
      "session.create",
      expect.anything(),
    );
    expect(
      window.sessionStorage.getItem(AGENT_NEW_SESSION_PENDING_KEY),
    ).toBeNull();
  });

  it("wraps a submitted issue report for June and files it after the turn", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), kind: "issue-report" }),
    );
    mocks.submitIssueReport.mockResolvedValue({ received: true });

    render(<AgentWorkspace />);

    const composer = (await screen.findByPlaceholderText(
      "Describe a task for June…",
    )) as HTMLTextAreaElement;
    await waitFor(() =>
      expect(composer.value).toContain("I want to report an issue with June."),
    );
    await user.clear(composer);
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
    expect(submitted.text).toContain(
      "The recorder crashes after long meetings",
    );
    // The transcript shows the user's words only — the investigation
    // framing is plumbing between June and the runtime, never UI.
    expect(
      await screen.findByText(/The recorder crashes after long meetings/),
    ).toBeInTheDocument();
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

    await waitFor(() =>
      expect(mocks.submitIssueReport).toHaveBeenCalledWith({
        description: "The recorder crashes after long meetings",
        agentDiagnosis: "The screenshot shows the recorder stuck on saving.",
        attachmentNames: ["screenshot.png"],
        attachmentPaths: [
          "/Users/junho/Library/Application Support/co.opensoftware.scribe/hermes/workspace/uploads/screenshot.png",
        ],
        sessionId: "session-2",
      }),
    );
    expect(
      await screen.findByText(/Your report was sent to the June team/),
    ).toBeInTheDocument();
    // Drain the post-terminal refresh timer before the test ends so its
    // session refetch cannot land inside a later test's render.
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
    expect(
      screen.getByRole("button", { name: "Model: Anonymous Only" }),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(
        new RegExp(`^Anonymous mode - ${ANONYMOUS_MODEL_DESCRIPTION}`),
      ),
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
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      E2EE_MODEL_DESCRIPTION,
    );
    await user.unhover(badge);
    await waitFor(() =>
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
    );
  });

  it("opens the model picker from the composer's model trigger", async () => {
    const user = userEvent.setup();

    render(<AgentWorkspace initialSession={existingSession} />);

    // The session composer carries the same model trigger as the hero.
    await user.click(
      await screen.findByRole("button", { name: "Model: GLM 5.1" }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Choose text model",
    });
    expect(
      within(dialog).getByRole("option", { name: /GLM 5.1/ }),
    ).toBeInTheDocument();
  });

  it("switches the text model from the composer's picker", async () => {
    // Tool-capable catalog: the picker refuses tool-less models for the
    // agent, so the switch target must support function calling.
    const catalog = [
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
        id: "kimi-k2",
        name: "Kimi K2",
        modelType: "text",
        privacy: "anonymous",
        traits: [],
        capabilities: ["functionCalling"],
      },
    ];
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: "zai-org-glm-5-1",
      models: catalog,
    });
    mocks.setVeniceModel.mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(<AgentWorkspace initialSession={existingSession} />);

    await user.click(
      await screen.findByRole("button", { name: "Model: GLM 5.1" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Choose text model",
    });

    // The reload after the switch reads the updated setting.
    mocks.providerModelSettings.mockResolvedValue({
      settings: {
        transcriptionProvider: "venice",
        transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
        generationModel: "kimi-k2",
      },
    });
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: "kimi-k2",
      models: catalog,
    });
    // The popover opens on the suggested picks (GLM 5.1 is curated); the
    // switch target only exists in the full catalog behind All models.
    await user.click(
      within(dialog).getByRole("button", { name: "All models" }),
    );
    const panel = await screen.findByRole("group", {
      name: "All text models",
    });
    await user.click(within(panel).getByRole("option", { name: /Kimi K2/ }));

    await waitFor(() =>
      expect(mocks.setVeniceModel).toHaveBeenCalledWith(
        "generation",
        "kimi-k2",
      ),
    );
    // The composer trigger reflects the new model and the session bar badge
    // its privacy mode.
    expect(
      await screen.findByRole("button", { name: "Model: Kimi K2" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Anonymous mode")).toBeInTheDocument();
    expect(screen.queryByText("Private mode")).not.toBeInTheDocument();
  });

  it("refreshes the model privacy label when generation model settings change", async () => {
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

    expect(await screen.findByText("Anonymous mode")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("Private mode")).not.toBeInTheDocument(),
    );
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
    expect(
      window.sessionStorage.getItem(AGENT_NEW_SESSION_PENDING_KEY),
    ).toBeNull();
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
    window.localStorage.setItem("scribe:agent:last-open-session", "session-1");
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
    await waitFor(() =>
      expect(mocks.listHermesSessionMessages).toHaveBeenCalledWith("session-1"),
    );
    expect(mocks.listHermesSessionMessages).not.toHaveBeenCalledWith(
      "session-2",
    );
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
    expect(
      await screen.findByText("Summarize Current Page"),
    ).toBeInTheDocument();

    first.unmount();
    render(<AgentWorkspace />);

    // The sent message and the session title survive the round trip.
    expect(await screen.findByText("audit the repo")).toBeInTheDocument();
    expect(
      await screen.findByText("Summarize Current Page"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Untitled session")).toBeNull();
    // The run is still treated as working, so the reconcile poll can pick it
    // up: the composer offers the stop control instead of an idle send.
    expect(
      await screen.findByRole("button", { name: "Stop June" }),
    ).toBeInTheDocument();
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
        content:
          "The sandbox blocks Codex's state folders.\n\n[REQUEST:AGENT_CLI_ACCESS]",
        timestamp: "2026-06-12T10:00:05Z",
      },
    ]);
    mocks.setHermesAgentCliAccess.mockResolvedValue({ enabled: true });
    const user = userEvent.setup();

    render(<AgentWorkspace initialSession={existingSession} />);

    expect(
      await screen.findByText("Agent CLI access requested"),
    ).toBeInTheDocument();
    // The token renders as the card, never as literal text.
    expect(screen.queryByText(/REQUEST:AGENT_CLI_ACCESS/)).toBeNull();
    expect(
      screen.getByText(/sandbox blocks Codex's state folders/),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Enable Agent CLI access" }),
    );

    await waitFor(() =>
      expect(mocks.setHermesAgentCliAccess).toHaveBeenCalledWith(true),
    );
    // June is told the grant is live, so it retries on the restarted runtime.
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: expect.stringContaining("I enabled Agent CLI access"),
      }),
    );
    expect(
      await screen.findByText("Agent CLI access enabled"),
    ).toBeInTheDocument();
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

    expect(
      await screen.findByText("Agent CLI access requested"),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Agent CLI access enabled"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Enable Agent CLI access" }),
    ).toBeNull();
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
    expect(
      screen.queryByRole("button", { name: "Enable Agent CLI access" }),
    ).toBeNull();
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith(
      "prompt.submit",
      expect.anything(),
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
      expect(mocks.listHermesSessionMessages).toHaveBeenCalledWith(
        "session-generated",
      ),
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
      expect(
        window.localStorage.getItem("scribe:agent:last-open-session"),
      ).toBe("session-1"),
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_DELETE_SESSION_EVENT, {
          detail: { sessionId: "session-1" },
        }),
      );
    });

    await waitFor(() =>
      expect(
        window.localStorage.getItem("scribe:agent:last-open-session"),
      ).toBeNull(),
    );
    expect(
      window.localStorage.getItem("june.agent.unrestrictedSessions"),
    ).toBeNull();
  });

  it("keeps the blank composer after a New Session event during refresh", async () => {
    render(<AgentWorkspace />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    window.dispatchEvent(new CustomEvent(AGENT_NEW_SESSION_EVENT));

    expect(await screen.findByText(HERO_GREETING)).toBeInTheDocument();
    expect(screen.queryByText("Existing session")).toBeNull();
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
    expect(
      await screen.findByText("Summarize Current Page"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Untitled session")).toBeNull();
    expect(
      window.sessionStorage.getItem(AGENT_NEW_SESSION_PENDING_KEY),
    ).toBeNull();
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
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop June" })).toBeNull(),
    );
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
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop June" })).toBeNull(),
    );
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

    expect(
      await screen.findByText(/Reading one more file/),
    ).toBeInTheDocument();
    expect(screen.getByText("Thinking").closest("details")).toHaveAttribute(
      "open",
    );

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
    expect(screen.getByText("Thought").closest("details")).toHaveAttribute(
      "open",
    );

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
    expect(screen.getByText("Thinking").closest("details")).not.toHaveAttribute(
      "open",
    );
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
    expect(
      screen.getByText(/Approve once allows only this request/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Always allows matching requests in future sessions/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Hide explanation" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve once" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Always" })).toBeEnabled();
    // Asking for an explanation never answers the approval.
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith(
      "approval.respond",
      expect.anything(),
    );

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
    expect(
      screen.getByText(/Approve once allows only this request/),
    ).toBeInTheDocument();
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

    expect(
      screen.getByText(/Approve once allows only this request/),
    ).toBeInTheDocument();
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

    expect(
      await screen.findByText("Summarize Current Page"),
    ).toBeInTheDocument();
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

      expect(mocks.gatewayRequest).toHaveBeenCalledWith(
        "session.active_list",
        {},
      );
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

      expect(mocks.gatewayRequest).toHaveBeenCalledWith(
        "session.active_list",
        {},
      );
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
      expect(mocks.listHermesSessions).toHaveBeenCalledTimes(
        initialSessionListCalls + 1,
      );
      const sessionListCallsAfterSubmit =
        mocks.listHermesSessions.mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });

      expect(screen.getByText("follow up while pending")).toBeInTheDocument();
      expect(screen.getByText("Thinking…")).toBeInTheDocument();
      expect(mocks.listHermesSessions).toHaveBeenCalledTimes(
        sessionListCallsAfterSubmit + 1,
      );
    } finally {
      vi.useRealTimers();
    }
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

  it("renders a workspace file's download card only on the first response that mentions it", async () => {
    mocks.hermesBridgeFilesystemSnapshot.mockResolvedValue({
      roots: [
        {
          id: "workspace",
          label: "Workspace",
          path: "/Users/junho/Library/Application Support/co.opensoftware.scribe/hermes/workspace",
          description: "Hermes scratch files and generated outputs.",
          entries: [
            {
              name: "report.md",
              path: "/Users/junho/Library/Application Support/co.opensoftware.scribe/hermes/workspace/report.md",
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
    expect(
      screen.getAllByRole("button", { name: "Download report.md" }),
    ).toHaveLength(1);
  });

  it("opens a markdown artifact in the viewer panel with rendered content", async () => {
    const user = userEvent.setup();
    const reportPath =
      "/Users/junho/Library/Application Support/co.opensoftware.scribe/hermes/workspace/report.md";
    mocks.hermesBridgeFilesystemSnapshot.mockResolvedValue({
      roots: [
        {
          id: "workspace",
          label: "Workspace",
          path: "/Users/junho/Library/Application Support/co.opensoftware.scribe/hermes/workspace",
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
    mocks.hermesBridgeFileText.mockResolvedValue(
      "# Quarterly summary\n\nRevenue grew.",
    );

    render(<AgentWorkspace />);

    await user.click(
      await screen.findByRole("button", { name: "Open report.md" }),
    );

    const panel = await screen.findByRole("complementary", { name: "Files" });
    expect(mocks.hermesBridgeFileText).toHaveBeenCalledWith(reportPath);
    expect(
      await within(panel).findByRole("heading", { name: "Quarterly summary" }),
    ).toBeInTheDocument();
    expect(within(panel).getByText("Revenue grew.")).toBeInTheDocument();

    // Find-in-file highlights matches inside the rendered document.
    await user.click(
      within(panel).getByRole("button", { name: "Find in file" }),
    );
    await user.type(within(panel).getByLabelText("Find in file"), "revenue");
    // Highlighting trails typing by a short debounce.
    await waitFor(() =>
      expect(panel.querySelectorAll("mark").length).toBeGreaterThan(0),
    );
    expect(panel.querySelectorAll("mark")[0]).toHaveTextContent(/revenue/i);
    await user.keyboard("{Escape}"); // clear
    await user.keyboard("{Escape}"); // collapse
    expect(panel.querySelectorAll("mark")).toHaveLength(0);

    // The source toggle swaps the rendered document for the raw markdown.
    await user.click(within(panel).getByRole("button", { name: "Source" }));
    expect(within(panel).getByText(/# Quarterly summary/)).toBeInTheDocument();

    await user.click(
      within(panel).getByRole("button", { name: "Close files" }),
    );
    expect(
      screen.queryByRole("complementary", { name: "Files" }),
    ).not.toBeInTheDocument();
  });

  it("lists every surfaced file behind the session bar files button", async () => {
    const user = userEvent.setup();
    const workspaceRoot =
      "/Users/junho/Library/Application Support/co.opensoftware.scribe/hermes/workspace";
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

    await user.click(
      await screen.findByRole("button", { name: "View files (2)" }),
    );

    const panel = await screen.findByRole("complementary", { name: "Files" });
    expect(within(panel).getByText("report.md")).toBeInTheDocument();

    // Opening a non-markdown file from the list shows its raw text.
    await user.click(within(panel).getByText("notes.txt"));
    expect(
      await within(panel).findByText("plain text body"),
    ).toBeInTheDocument();
    expect(mocks.hermesBridgeFileText).toHaveBeenCalledWith(
      `${workspaceRoot}/notes.txt`,
    );

    // Back returns to the list of every surfaced file.
    await user.click(within(panel).getByRole("button", { name: "All files" }));
    expect(within(panel).getByText("report.md")).toBeInTheDocument();

    // The header magnifier expands into the filter; typing narrows the list.
    await user.click(
      within(panel).getByRole("button", { name: "Filter files" }),
    );
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
    expect(
      screen.queryByRole("complementary", { name: "Files" }),
    ).not.toBeInTheDocument();
  });

  it("does not render download cards for files the user attached", async () => {
    const attachedPath =
      "/Users/junho/Library/Application Support/co.opensoftware.scribe/hermes/workspace/june-context.md";
    mocks.hermesBridgeFilesystemSnapshot.mockResolvedValue({
      roots: [
        {
          id: "workspace",
          label: "Workspace",
          path: "/Users/junho/Library/Application Support/co.opensoftware.scribe/hermes/workspace",
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
          "Attached files copied into the Scribe Hermes workspace:",
          `- june-context.md (Workspace): ${attachedPath}`,
          "",
          "Use these workspace paths when inspecting or operating on the files.",
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
          path: "/Users/junho/Library/Application Support/co.opensoftware.scribe/hermes/workspace",
          description: "Hermes scratch files and generated outputs.",
          entries: [
            {
              name: "notes.md",
              path: "/Users/junho/Library/Application Support/co.opensoftware.scribe/hermes/workspace/notes.md",
              kind: "file",
              size: 512,
              modifiedAt: "2026-06-04T18:39:00Z",
            },
            {
              name: "archive",
              path: "/Users/junho/Library/Application Support/co.opensoftware.scribe/hermes/workspace/archive",
              kind: "directory",
              children: [
                {
                  name: "notes.md",
                  path: "/Users/junho/Library/Application Support/co.opensoftware.scribe/hermes/workspace/archive/notes.md",
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
    expect(
      screen.getAllByRole("button", { name: "Download notes.md" }),
    ).toHaveLength(1);
  });

  it("renders generated workspace images as file cards without previews", async () => {
    const screenshotPath =
      "/Users/junho/Library/Application Support/co.opensoftware.scribe/hermes/workspace/screenshot.png";
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

    // Images get the same icon · name · size card as every other file type —
    // no thumbnail, so no preview round-trip to the bridge.
    expect(
      await screen.findByRole("button", { name: "Download screenshot.png" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("img", { name: "screenshot.png" }),
    ).not.toBeInTheDocument();
    expect(mocks.hermesBridgeFilePreview).not.toHaveBeenCalledWith(
      screenshotPath,
    );
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
      screen.getByPlaceholderText("Send a message"),
      "what is in this image?",
    );
    const sendButton = screen.getByRole("button", { name: "Send message" });
    await waitFor(() => expect(sendButton).not.toBeDisabled());
    await user.click(sendButton);

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
    const refreshCallsBefore =
      mocks.listHermesSessionMessages.mock.calls.length;
    await waitFor(
      () =>
        expect(
          mocks.listHermesSessionMessages.mock.calls.length,
        ).toBeGreaterThan(refreshCallsBefore),
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
      expect(mocks.listHermesSessions.mock.calls.length).toBeGreaterThan(
        callsBefore,
      ),
    );
  });

  it("holds session broadcasts until the first fetch lands", async () => {
    const sessionDetails: AgentSessionsChangedDetail[] = [];
    const onSessionsChanged = (event: Event) =>
      sessionDetails.push(
        (event as CustomEvent<AgentSessionsChangedDetail>).detail,
      );
    window.addEventListener(AGENT_SESSIONS_CHANGED_EVENT, onSessionsChanged);

    // First click after app launch: the workspace mounts seeded with only the
    // clicked session while listHermesSessions is still in flight. The sidebar
    // replaces its list wholesale with each broadcast, so a pre-fetch
    // broadcast would collapse it to one row and flicker it back.
    let resolveSessions: (sessions: (typeof existingSession)[]) => void = () =>
      undefined;
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
      window.removeEventListener(
        AGENT_SESSIONS_CHANGED_EVENT,
        onSessionsChanged,
      );
    }
  });

  it("scrubs working state when deleting the selected session from the session bar", async () => {
    const user = userEvent.setup();
    const sessionDetails: AgentSessionsChangedDetail[] = [];
    const onSessionsChanged = (event: Event) =>
      sessionDetails.push(
        (event as CustomEvent<AgentSessionsChangedDetail>).detail,
      );
    window.addEventListener(AGENT_SESSIONS_CHANGED_EVENT, onSessionsChanged);

    try {
      render(<AgentWorkspace />);
      expect(await screen.findByText("Existing session")).toBeInTheDocument();

      await user.type(screen.getByRole("textbox"), "do something long");
      await user.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() =>
        expect(sessionDetails.at(-1)?.workingSessionIds).toContain("session-1"),
      );

      mocks.listHermesSessions.mockResolvedValue([]);
      await user.click(screen.getByRole("button", { name: "Session actions" }));
      await user.click(
        screen.getByRole("menuitem", { name: "Delete session" }),
      );

      await waitFor(() =>
        expect(mocks.deleteHermesSession).toHaveBeenCalledWith("session-1"),
      );
      await waitFor(() => {
        const last = sessionDetails.at(-1);
        expect(last?.workingSessionIds).toEqual([]);
        expect(last?.sessions.map((session) => session.id)).not.toContain(
          "session-1",
        );
      });
    } finally {
      window.removeEventListener(
        AGENT_SESSIONS_CHANGED_EVENT,
        onSessionsChanged,
      );
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

      await user.click(
        await screen.findByRole("button", { name: /Catch up on recent files/ }),
      );

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

  it("plays the hero teardown while a typed submit creates the session", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now() }),
    );
    // Hold session.create open so the in-flight teardown is observable —
    // without it the greeting and chips sat frozen through the create
    // latency and vanished in a single frame at the handoff.
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

    await user.type(
      await screen.findByPlaceholderText("Describe a task for June…"),
      "first task",
    );
    await user.click(screen.getByRole("button", { name: "Start session" }));

    // Mid-flight: still the hero, but tearing down.
    const hero = screen.getByRole("region", { name: "Agent task details" });
    await waitFor(() =>
      expect(hero).toHaveAttribute("data-hero-leaving", "true"),
    );
    expect(screen.getByText(HERO_GREETING)).toBeInTheDocument();

    await waitFor(() => expect(releaseCreate).toBeDefined());
    act(() => releaseCreate?.());

    // The handoff lands in the conversation with the pending message.
    await waitFor(() =>
      expect(screen.queryByText(HERO_GREETING)).not.toBeInTheDocument(),
    );
    expect(await screen.findByText("first task")).toBeInTheDocument();
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

      await user.click(
        await screen.findByRole("button", { name: /Research a topic/ }),
      );

      const composer = screen.getByPlaceholderText(
        "Describe a task for June…",
      ) as HTMLTextAreaElement;
      await waitFor(() => expect(composer.value).toContain("Research <topic>"));
      expect(mocks.gatewayRequest).not.toHaveBeenCalledWith(
        "prompt.submit",
        expect.anything(),
      );
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
      selectedModel: "zai-org-glm-5-1",
      models: [
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
          id: "kimi-k2",
          name: "Kimi K2",
          modelType: "text",
          privacy: "anonymous",
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

    await user.click(
      await screen.findByRole("button", { name: "Model: GLM 5.1" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Choose text model",
    });
    await user.click(
      within(dialog).getByRole("button", { name: "All models" }),
    );

    const panel = await screen.findByRole("group", { name: "All text models" });
    expect(panel.firstElementChild).toHaveClass("agent-composer-model-surface");
    expect(
      within(panel).getByRole("textbox", { name: "Search models" }),
    ).toBeInTheDocument();
    expect(
      within(panel).getByRole("option", { name: /Kimi K2/ }),
    ).toBeInTheDocument();
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
    await user.type(
      screen.getByPlaceholderText("Describe a task for June…"),
      "first task",
    );
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
    await user.click(
      screen.getByRole("menuitemradio", { name: /^Unrestricted/ }),
    );
    expect(
      screen.queryByRole("menu", { name: "What can June change?" }),
    ).not.toBeInTheDocument();
    // Not armed until the dialog confirms.
    expect(
      screen.getByRole("button", { name: "Sandboxed" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Turn on Unrestricted" }),
    );
    expect(
      screen.getByRole("button", { name: "Unrestricted" }),
    ).toBeInTheDocument();

    await user.type(
      screen.getByPlaceholderText("Describe a task for June…"),
      "risky task",
    );
    await user.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() =>
      expect(mocks.startHermesBridge).toHaveBeenCalledWith(undefined, true),
    );

    // The confirm is once per app session: with the acknowledgment stored,
    // the next arm goes straight through without the dialog.
    act(() => {
      window.dispatchEvent(new CustomEvent(AGENT_NEW_SESSION_EVENT));
    });
    await user.click(await screen.findByRole("button", { name: "Sandboxed" }));
    await user.click(
      screen.getByRole("menuitemradio", { name: /^Unrestricted/ }),
    );
    expect(
      screen.queryByRole("button", { name: "Turn on Unrestricted" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Unrestricted" }),
    ).toBeInTheDocument();
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
      expect(
        screen.queryByRole("menu", { name: "What can June change?" }),
      ).not.toBeInTheDocument(),
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
    expect(
      screen.getByLabelText(/Unrestricted - This session runs without/),
    ).toBeInTheDocument();
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

    await user.type(screen.getByPlaceholderText("Send a message"), "hello");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    // The send brings up the sandboxed process for this session — the
    // unrestricted one (and its in-flight work) is left alone.
    await waitFor(() =>
      expect(mocks.startHermesBridge).toHaveBeenCalledWith(undefined, false),
    );
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

    await user.type(screen.getByPlaceholderText("Send a message"), "continue");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(mocks.startHermesBridge).toHaveBeenCalledWith(undefined, true),
    );
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
    await user.type(screen.getByPlaceholderText("Send a message"), "continue");
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

    const composer = screen.getByPlaceholderText("Send a message");
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
    expect(composer).toHaveValue("are the subagents using my CLI?");
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

    await user.type(screen.getByPlaceholderText("Send a message"), "hello");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(
      await screen.findByText("Hermes gateway is not connected."),
    ).toBeInTheDocument();
    // Connection-shaped failures are the retryable ones — reconnecting can fix
    // them, unlike one-off action failures which only offer dismiss.
    expect(
      screen.getByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Hermes gateway is not connected.")).toBeNull();
  });

  it("renders an out-of-credits notice with a top-up action instead of the raw 402 error", async () => {
    const user = userEvent.setup();
    mocks.osAccountsTopUp.mockResolvedValue(undefined);
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

    await user.click(screen.getByRole("button", { name: "Add funds" }));
    expect(mocks.osAccountsTopUp).toHaveBeenCalledOnce();
  });

  it("shows every error surface via the __agentErrors() dev handle", async () => {
    const agentErrors = (
      window as unknown as { __agentErrors: (show?: boolean) => string }
    ).__agentErrors;
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    act(() => void agentErrors());

    try {
      expect(
        await screen.findByText("Agent error gallery"),
      ).toBeInTheDocument();
      // Turn-level samples from the catalog (section label + the card itself)…
      expect(screen.getAllByText("Out of credits").length).toBeGreaterThan(0);
      expect(
        screen.getByRole("button", { name: "Add funds" }),
      ).toBeInTheDocument();
      // …plus the forced chrome samples the turn gallery can't represent.
      expect(
        screen.getByText("Could not connect to Hermes gateway."),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Try again" }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/June is still working on the previous message/),
      ).toBeInTheDocument();
    } finally {
      // Always reset the module-level desired state — a failure here must not
      // leave the gallery on and cascade into later workspace mounts.
      act(() => void agentErrors(false));
    }
    await waitFor(() =>
      expect(screen.queryByText("Agent error gallery")).toBeNull(),
    );
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
    await waitFor(() =>
      expect(mocks.ensureHermesBridgeSession).toHaveBeenCalled(),
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
          backLabel: "Back to Scribe",
          onBack,
          crumbs: [
            { label: "Projects", onClick: onOpenProjects },
            { label: "Scribe", onClick: onBack },
          ],
        }}
      />,
    );

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("Scribe")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to Scribe" }));
    expect(onBack).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    expect(onOpenProjects).toHaveBeenCalled();
  });
});
