import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_DELETE_SESSION_EVENT,
  AGENT_NEW_SESSION_EVENT,
  AGENT_NEW_SESSION_PENDING_KEY,
  AGENT_SESSION_RENAMED_EVENT,
  AGENT_SESSIONS_CHANGED_EVENT,
  AgentWorkspace,
  HERO_GREETINGS,
  SkillsToolsPanel,
  composerInSteerStateFor,
  dispatchIssueReportDeliverySettledForTest,
  dispatchIssueReportFollowUpSubmitFailedForTest,
  dispatchIssueReportPromotedForTest,
  generatedImagePathAliases,
  projectAgentActivityLevels,
  resetAgentSessionContinuity,
  seedAgentComposerDraftForTest,
  type AgentSessionsChangedDetail,
} from "../components/agent/AgentWorkspace";
import {
  ANONYMOUS_MODEL_DESCRIPTION,
  E2EE_MODEL_DESCRIPTION,
  PROVIDER_MODEL_SETTINGS_CHANGED_EVENT,
} from "../lib/model-privacy";
import { HermesGatewayError } from "../lib/hermes-gateway";
import {
  AGENT_RUN_SETTLED_EVENT,
  AGENT_RUN_STARTED_EVENT,
  AGENT_SESSION_STATUS_EVENT,
  type AgentSessionStatusDetail,
} from "../lib/agent-events";
import { classifyHermesEvent } from "../lib/hermes-control-plane";
import { hermesActivityStore, type AgentActivityRecord } from "../lib/hermes-activity-store";
import { hermesArtifactStore } from "../lib/hermes-artifact-store";
import {
  isAgentSessionTitleCandidate,
  rememberSessionTitleRejected,
  resetAgentSessionTitleVolatileStoreForTest,
  sessionSettledTitleKind,
} from "../lib/agent-session-titles";
import { hermesTraceBuffer } from "../lib/hermes-trace-buffer";
import { PENDING_ACTIONS_CAP, pendingActionStore } from "../lib/hermes-pending-actions";
import { unsupportedEventStore } from "../lib/hermes-unsupported-events";
import { readSessionModelSelections } from "../lib/hermes-session-model-selection";
import {
  reserveHermesSessionDispatch,
  resetHermesSessionDispatchForTests,
} from "../lib/hermes-session-dispatch-mutex";

// The hero greeting cycles per visit, so tests match any entry in the pool.
const HERO_GREETING = new RegExp(
  `^(?:${HERO_GREETINGS.map((greeting) => greeting.replace("?", "\\?")).join("|")})$`,
);

const mocks = vi.hoisted(() => ({
  agentRunMonitorSnapshot: vi.fn(),
  cancelAgentRunMonitoring: vi.fn(),
  cancelAgentTask: vi.fn(),
  createAgentTask: vi.fn(),
  editImage: vi.fn(),
  ensureHermesBridgeSession: vi.fn(),
  finalizeHermesBridgeBranch: vi.fn(),
  generateImage: vi.fn(),
  localVideoFileSrc: vi.fn((path: string) => `asset://${path}`),
  primeGeneratedVideoDir: vi.fn().mockResolvedValue(undefined),
  getAgentTask: vi.fn(),
  getHermesBridgeSkill: vi.fn(),
  hermesBridgeFilesystemSnapshot: vi.fn(),
  hermesBridgeFilePreview: vi.fn(),
  hermesBridgeImageDataUrl: vi.fn(),
  hermesBridgeFileText: vi.fn(),
  hermesBridgeMessagingPlatforms: vi.fn(),
  hermesBridgeSkills: vi.fn(),
  hermesBridgeStatus: vi.fn(),
  hermesBridgeToolsets: vi.fn(),
  imagePromptMayBeExplicit: vi.fn(),
  importHermesBridgeFile: vi.fn(),
  importHermesBridgeFileBytes: vi.fn(),
  listVeniceModels: vi.fn(),
  listAgentTasks: vi.fn(),
  downloadHermesBridgeFile: vi.fn(),
  osAccountsUpgrade: vi.fn(),
  openFileDialog: vi.fn(),
  setImageSafeMode: vi.fn(),
  setImageSafeModePromptDismissed: vi.fn(),
  setCostQuality: vi.fn(),
  setVeniceModel: vi.fn(),
  setLocalGenerationEnabled: vi.fn(),
  providerModelSettings: vi.fn(),
  videoGenerate: vi.fn(),
  videoStatus: vi.fn(),
  retryAgentTask: vi.fn(),
  saveAgentAssistantMessage: vi.fn(),
  saveAgentHermesSession: vi.fn(),
  sendAgentMessage: vi.fn(),
  startHermesBridge: vi.fn(),
  submitIssueReport: vi.fn(),
  suggestAgentSessionTitle: vi.fn(),
  titleFromPrompt: vi.fn((prompt: string) => prompt.trim() || "Untitled session"),
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
  hasPendingAgentRunTerminalEvidence: vi.fn(() => false),
  stopAgentRunMonitoring: vi.fn(
    (_storedSessionId: string, _generation: number, onStopped?: () => void) => {
      queueMicrotask(() => onStopped?.());
      return true;
    },
  ),
  isAgentRunMonitorGenerationCurrent: vi.fn(() => true),
  markAgentRunSucceeded: vi.fn(),
  preserveAgentRunTerminalEvidence: vi.fn(),
  releaseAgentRunSettlement: vi.fn(),
  startAgentRunMonitoring: vi.fn(),
  gatewayEventHandlers: new Set<(event: Record<string, unknown>) => void>(),
  gatewayCloseHandlers: new Set<() => void>(),
  gatewayInstances: [] as Array<{
    connect: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }>,
  eventHandlers: new Map<string, (event: { payload?: unknown }) => unknown>(),
  listen: vi.fn(async (eventName: string, handler: (event: { payload?: unknown }) => unknown) => {
    mocks.eventHandlers.set(eventName, handler);
    return () => mocks.eventHandlers.delete(eventName);
  }),
}));

vi.mock("../lib/agent-run-monitor", () => ({
  agentRunMonitorSnapshot: mocks.agentRunMonitorSnapshot,
  cancelAgentRunMonitoring: mocks.cancelAgentRunMonitoring,
  hasPendingAgentRunTerminalEvidence: mocks.hasPendingAgentRunTerminalEvidence,
  stopAgentRunMonitoring: mocks.stopAgentRunMonitoring,
  isAgentRunMonitorGenerationCurrent: mocks.isAgentRunMonitorGenerationCurrent,
  markAgentRunSucceeded: mocks.markAgentRunSucceeded,
  preserveAgentRunTerminalEvidence: mocks.preserveAgentRunTerminalEvidence,
  releaseAgentRunSettlement: mocks.releaseAgentRunSettlement,
  startAgentRunMonitoring: mocks.startAgentRunMonitoring,
}));

vi.mock("../lib/tauri", () => ({
  dictationCapabilities: vi.fn().mockResolvedValue({
    capabilities: {
      available: true,
      platform: "macos",
      shortcuts: true,
      paste: true,
      microphoneSelection: true,
      accessibilityPermission: true,
      systemAudio: true,
    },
  }),
  // The pending skill-writes tray loads through the Rust bridge via this named
  // `invoke`. A quiet stub keeps these workspace tests off that path.
  invoke: vi.fn(async () => []),
  cancelAgentTask: mocks.cancelAgentTask,
  createAgentTask: mocks.createAgentTask,
  editImage: mocks.editImage,
  ensureHermesBridgeSession: mocks.ensureHermesBridgeSession,
  finalizeHermesBridgeBranch: mocks.finalizeHermesBridgeBranch,
  generateImage: mocks.generateImage,
  localVideoFileSrc: mocks.localVideoFileSrc,
  primeGeneratedVideoDir: mocks.primeGeneratedVideoDir,
  getAgentTask: mocks.getAgentTask,
  getHermesBridgeSkill: mocks.getHermesBridgeSkill,
  hermesBridgeFilesystemSnapshot: mocks.hermesBridgeFilesystemSnapshot,
  hermesBridgeFilePreview: mocks.hermesBridgeFilePreview,
  hermesBridgeImageDataUrl: mocks.hermesBridgeImageDataUrl,
  hermesBridgeFileText: mocks.hermesBridgeFileText,
  hermesBridgeMessagingPlatforms: mocks.hermesBridgeMessagingPlatforms,
  hermesAgentCliAccess: mocks.hermesAgentCliAccess,
  hermesBridgeSkills: mocks.hermesBridgeSkills,
  hermesBridgeStatus: mocks.hermesBridgeStatus,
  hermesBridgeToolsets: mocks.hermesBridgeToolsets,
  imagePromptMayBeExplicit: mocks.imagePromptMayBeExplicit,
  importHermesBridgeFile: mocks.importHermesBridgeFile,
  importHermesBridgeFileBytes: mocks.importHermesBridgeFileBytes,
  listVeniceModels: mocks.listVeniceModels,
  listAgentTasks: mocks.listAgentTasks,
  downloadHermesBridgeFile: mocks.downloadHermesBridgeFile,
  osAccountsUpgrade: mocks.osAccountsUpgrade,
  providerModelSettings: mocks.providerModelSettings,
  videoGenerate: mocks.videoGenerate,
  videoStatus: mocks.videoStatus,
  retryAgentTask: mocks.retryAgentTask,
  setHermesAgentCliAccess: mocks.setHermesAgentCliAccess,
  setImageSafeMode: mocks.setImageSafeMode,
  setImageSafeModePromptDismissed: mocks.setImageSafeModePromptDismissed,
  setCostQuality: mocks.setCostQuality,
  setLocalGenerationEnabled: mocks.setLocalGenerationEnabled,
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

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.openFileDialog,
}));

// Pin VIDEO_GENERATION_ENABLED on so the /video surfaces stay testable
// regardless of the committed flag value.
vi.mock("../lib/feature-flags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/feature-flags")>()),
  VIDEO_GENERATION_ENABLED: true,
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
  titleFromPrompt: mocks.titleFromPrompt,
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
    onClose = vi.fn((handler: () => void) => {
      mocks.gatewayCloseHandlers.add(handler);
      return () => mocks.gatewayCloseHandlers.delete(handler);
    });
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

function getCurrentModelLabel(name: string) {
  const text = screen.getByText(name, {
    selector: ".agent-composer-model-label span, .agent-composer-model-trigger span",
  });
  return text.closest(".agent-composer-model-label, .agent-composer-model-trigger") as HTMLElement;
}

async function findCurrentModelLabel(name: string) {
  const text = await screen.findByText(name, {
    selector: ".agent-composer-model-label span, .agent-composer-model-trigger span",
  });
  return text.closest(".agent-composer-model-label, .agent-composer-model-trigger") as HTMLElement;
}

function seedLegacyNewSessionReportDraft() {
  seedAgentComposerDraftForTest("new-session", {
    text: "",
    category: "bug",
  });
}

function seedLegacyExistingSessionReportDraft() {
  seedAgentComposerDraftForTest("session:session-1", {
    text: "",
    category: "bug",
  });
}

function PublishIssueReportTransitionInLayout({
  children,
  publish,
}: {
  children: ReactNode;
  publish: () => void;
}) {
  useLayoutEffect(() => publish(), [publish]);
  return children;
}

function mockImageSettings({
  imageSafeMode,
  imageSafeModePromptDismissed,
  imageModel = "venice-sd35",
}: {
  imageSafeMode: boolean;
  imageSafeModePromptDismissed: boolean;
  imageModel?: string;
}) {
  mocks.providerModelSettings.mockResolvedValue({
    settings: {
      transcriptionProvider: "venice",
      transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
      generationModel: "zai-org-glm-5-2",
      imageModel,
      imageSafeMode,
      imageSafeModePromptDismissed,
    },
  });
}

function mockImageGenerationSuccess() {
  mocks.generateImage.mockResolvedValueOnce({
    imageBase64: "aGVsbG8=",
    mimeType: "image/png",
    model: "venice-sd35",
    provider: "venice",
  });
  mocks.importHermesBridgeFileBytes.mockResolvedValueOnce({
    name: "generated-image.png",
    path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace/uploads/generated-image.png",
    rootLabel: "Workspace",
    size: 5,
    previewDataUrl: "data:image/png;base64,preview",
  });
}

function mockVideoSettings({
  imageSafeMode,
  imageSafeModePromptDismissed,
}: {
  imageSafeMode: boolean;
  imageSafeModePromptDismissed: boolean;
}) {
  mocks.providerModelSettings.mockResolvedValue({
    settings: {
      transcriptionProvider: "venice",
      transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
      generationModel: "zai-org-glm-5-2",
      videoModel: "wan-2.2-a14b-text-to-video",
      imageSafeMode,
      imageSafeModePromptDismissed,
    },
  });
}

function mockVideoGenerationSuccess() {
  mocks.videoGenerate.mockResolvedValueOnce({ jobId: "video-job-1" });
  mocks.videoStatus.mockResolvedValue({
    status: "completed",
    path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/videos/generated-video-1.mp4",
    mimeType: "video/mp4",
    sizeBytes: 5,
    model: "wan-2.2-a14b-text-to-video",
  });
}

type StoredVideoSlashTurnForTest = {
  id: string;
  pending?: boolean;
  jobId?: string;
};

function storedVideoSlashTurnsForTest(): StoredVideoSlashTurnForTest[] {
  const raw = window.localStorage.getItem("june:agent:video-slash-turns");
  if (!raw) return [];
  const parsed = JSON.parse(raw) as Record<string, StoredVideoSlashTurnForTest[]>;
  return Object.values(parsed).flat();
}

async function emitImageSafeModeConsent(prompt = "paint a nude portrait") {
  const handler = mocks.eventHandlers.get("image-safe-mode-consent");
  expect(handler).toBeDefined();
  await act(async () => {
    await handler?.({ payload: { source: "agent", prompt } });
  });
}

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

/**
 * Poll under fake timers until `assertion` passes: flush microtasks and run
 * short (<=1ms) timers each step, so async session hydration that needs a few
 * extra cycles settles instead of racing a single fixed `advanceTimersByTimeAsync(50)`
 * (the root of this suite's CI-load flakes — the initial "Thinking…" render only
 * lost under the loaded CI runner). Capped at 500ms, well under the 2500ms
 * working-session poll, so it never advances into a reconcile tick.
 */
async function settleUnderFakeTimers(
  assertion: () => void,
  { stepMs = 1, maxMs = 500 }: { stepMs?: number; maxMs?: number } = {},
): Promise<void> {
  for (let elapsed = 0; elapsed <= maxMs; elapsed += stepMs) {
    let settled = true;
    try {
      assertion();
    } catch {
      settled = false;
    }
    if (settled) return;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(stepMs);
    });
  }
  assertion();
}

describe("AgentWorkspace", () => {
  it("accepts concise topic titles without treating their first word as dialogue", () => {
    expect(isAgentSessionTitleCandidate("How to deploy June")).toBe(true);
    expect(isAgentSessionTitleCandidate("Surefire recovery plan")).toBe(true);
    expect(isAgentSessionTitleCandidate("May release planning")).toBe(true);
    expect(isAgentSessionTitleCandidate("Will migration review")).toBe(true);
    expect(isAgentSessionTitleCandidate("Can bus diagnostics")).toBe(true);
    expect(isAgentSessionTitleCandidate("I'm sorry, but I can't help with that")).toBe(false);
    expect(isAgentSessionTitleCandidate("What should I update")).toBe(false);
    expect(isAgentSessionTitleCandidate("What, exactly should I update")).toBe(false);
    expect(isAgentSessionTitleCandidate("What,exactly should I update")).toBe(false);
    expect(isAgentSessionTitleCandidate("Would/you clarify")).toBe(false);
    expect(isAgentSessionTitleCandidate("Can June access the note")).toBe(false);
    expect(isAgentSessionTitleCandidate("Will June rename this")).toBe(false);
    expect(isAgentSessionTitleCandidate("Which email service should I use")).toBe(false);
    expect(isAgentSessionTitleCandidate("Would it be okay to rename this")).toBe(false);
    expect(isAgentSessionTitleCandidate("Should this use Gmail")).toBe(false);
    expect(isAgentSessionTitleCandidate("Are there archived notes")).toBe(false);
    expect(isAgentSessionTitleCandidate("Was this already deployed")).toBe(false);
    expect(isAgentSessionTitleCandidate("Were there archived notes")).toBe(false);
    expect(isAgentSessionTitleCandidate("Had this failed before")).toBe(false);
    expect(isAgentSessionTitleCandidate("Must I choose a project")).toBe(false);
    expect(isAgentSessionTitleCandidate("Shall I continue")).toBe(false);
    expect(isAgentSessionTitleCandidate("Wouldn't this overwrite the note")).toBe(false);
    expect(isAgentSessionTitleCandidate("I don't have email access")).toBe(false);
  });

  it("keeps a rejected title decision in memory when local storage fails", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    rememberSessionTitleRejected("storage-failure-session");

    expect(sessionSettledTitleKind("storage-failure-session")).toBe("rejected");
    setItem.mockRestore();
    resetAgentSessionTitleVolatileStoreForTest();
  });

  beforeEach(() => {
    resetHermesSessionDispatchForTests();
    vi.clearAllMocks();
    mocks.suggestAgentSessionTitle.mockReset();
    mocks.gatewayEventHandlers.clear();
    mocks.gatewayCloseHandlers.clear();
    mocks.gatewayInstances.length = 0;
    // Auto-cleanup unmounts the workspace after each test, which snapshots
    // any still-working session for the next mount — across tests that would
    // leak one test's mid-run session into the next.
    resetAgentSessionContinuity();
    // Feature 14: the artifact store is a process-wide singleton; drop the
    // session rows these tests touch so one test's artifacts don't leak into
    // the next.
    for (const id of ["session-1", "session-2", "runtime-session-1", "runtime-session-2"]) {
      hermesArtifactStore.clearSession(id);
    }
    // Feature 04: the pending-action store is the same kind of process-wide
    // singleton. Clear these tests' session ids so a prior test's "Needs you"
    // rows (now keyed by the durable stored id) don't leak into the next.
    for (const id of ["session-1", "session-2", "runtime-session-1", "runtime-session-2"]) {
      pendingActionStore.resolveSession(id);
    }
    window.sessionStorage.clear();
    window.localStorage.clear();
    resetAgentSessionTitleVolatileStoreForTest();
    mocks.openFileDialog.mockResolvedValue(null);
    mocks.listAgentTasks.mockResolvedValue({ items: [existingTask] });
    mocks.providerModelSettings.mockResolvedValue({
      settings: {
        transcriptionProvider: "venice",
        transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
        generationModel: "zai-org-glm-5-2",
        costQuality: 100,
      },
    });
    mocks.imagePromptMayBeExplicit.mockResolvedValue(false);
    mocks.stopAgentRunMonitoring.mockImplementation(
      (_storedSessionId: string, _generation: number, onStopped?: () => void) => {
        queueMicrotask(() => onStopped?.());
        return true;
      },
    );
    mocks.setImageSafeMode.mockResolvedValue({
      transcriptionProvider: "venice",
      transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
      generationModel: "zai-org-glm-5-2",
      imageSafeMode: false,
      imageSafeModePromptDismissed: false,
    });
    mocks.setImageSafeModePromptDismissed.mockResolvedValue({
      transcriptionProvider: "venice",
      transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
      generationModel: "zai-org-glm-5-2",
      imageSafeMode: true,
      imageSafeModePromptDismissed: true,
    });
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: "zai-org-glm-5-2",
      models: [
        {
          provider: "open-software",
          id: "open-software/auto",
          name: "Automatic private model",
          modelType: "text",
          privacy: "private",
          traits: [],
          capabilities: ["functionCalling"],
        },
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
    mocks.setCostQuality.mockImplementation(async (costQuality: number) => ({
      transcriptionProvider: "venice",
      transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
      generationModel: "open-software/auto",
      costQuality,
    }));
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
    // thumbnail data url, anything else null.
    mocks.hermesBridgeFilePreview.mockImplementation(async (path: string) =>
      /\.(png|jpe?g|gif|webp|tiff?)$/i.test(path) ? "data:image/png;base64,cHJldmlldw==" : null,
    );
    // Feature 19's structured image attach reads full image bytes through the
    // image-source capped command at attach time.
    mocks.hermesBridgeImageDataUrl.mockImplementation(async (path: string) =>
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
    mocks.finalizeHermesBridgeBranch.mockResolvedValue({
      branchSessionId: "session-fork",
      keptMessageCount: 2,
      removedMessageCount: 0,
    });
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
      if (method === "approval.respond") {
        return Promise.resolve({ resolved: 1 });
      }
      return Promise.resolve({});
    });
    mocks.hasPendingAgentRunTerminalEvidence.mockReturnValue(false);
    mocks.agentRunMonitorSnapshot.mockReturnValue(undefined);
    mocks.isAgentRunMonitorGenerationCurrent.mockReturnValue(true);
    mocks.preserveAgentRunTerminalEvidence.mockReturnValue(true);
    mocks.startAgentRunMonitoring.mockReturnValue(1);
  });

  it("reuses activity projection set identities when membership is unchanged", () => {
    const record: AgentActivityRecord = {
      id: "session-1",
      mode: "sandboxed",
      sessionId: "session-1",
      phase: "running",
      pendingActionCount: 0,
      subagentCount: 0,
      subagents: [],
      lastEventAt: 1,
    };
    const first = projectAgentActivityLevels([record]);

    const second = projectAgentActivityLevels([{ ...record, lastEventAt: 2 }], first);

    expect(second.workingSessionIds).toBe(first.workingSessionIds);
    expect(second.waitingSessionIds).toBe(first.waitingSessionIds);
    expect(second.toolCallSessionIds).toBe(first.toolCallSessionIds);
  });

  it("keeps a session waiting while any distinct pending action remains", () => {
    const projection = projectAgentActivityLevels([
      {
        id: "session-1",
        mode: "sandboxed",
        sessionId: "session-1",
        phase: "running",
        pendingActionCount: 1,
        subagentCount: 0,
        subagents: [],
        lastEventAt: 1,
      },
    ]);

    expect(projection.waitingSessionIds).toEqual(new Set(["session-1"]));
    expect(projection.workingSessionIds).toEqual(new Set());
  });

  it("scopes an in-flight submit's steer state to its owning session", () => {
    const base = {
      provisional: false,
      working: false,
      submitting: true,
      submittingSessionId: "session-1",
      demo: false,
    };

    expect(composerInSteerStateFor({ ...base, selectedSessionId: "session-1" })).toBe(true);
    expect(composerInSteerStateFor({ ...base, selectedSessionId: "session-2" })).toBe(false);
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

    expect(await screen.findByRole("textbox", { name: "Message June" })).toBeInTheDocument();
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

  it("shows project instructions only for a project-filed session", async () => {
    const user = userEvent.setup();
    const view = render(<AgentWorkspace initialSession={existingSession} />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Project instructions" })).toBeNull();

    view.rerender(
      <AgentWorkspace
        initialSession={existingSession}
        sessionInProject
        projectContext={{
          id: "project-1",
          name: "Launch",
          instructions: "Keep launch risks visible.",
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Project instructions" }));
    const dialog = screen.getByRole("dialog", { name: "Launch instructions" });
    expect(within(dialog).getByText("Keep launch risks visible.")).toBeInTheDocument();
  });

  it("opens the issue report dialog without submitting", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), category: "bug" }),
    );

    render(<AgentWorkspace />);

    expect(await screen.findByRole("dialog", { name: "Issue report" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bug report" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("session.create", expect.anything());
    expect(window.sessionStorage.getItem(AGENT_NEW_SESSION_PENDING_KEY)).toBeNull();
  });

  it("submits a large native-picker attachment from its original path", async () => {
    const user = userEvent.setup();
    const originalPath = "/Users/alex/Desktop/recording-over-50mb.mov";
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), category: "bug" }),
    );
    mocks.openFileDialog.mockResolvedValue([originalPath]);
    mocks.submitIssueReport.mockResolvedValue({ received: true });

    render(<AgentWorkspace />);

    const dialog = await screen.findByRole("dialog", { name: "Issue report" });
    mocks.importHermesBridgeFile.mockClear();
    mocks.importHermesBridgeFileBytes.mockClear();
    mocks.hermesBridgeFilePreview.mockClear();
    await user.click(within(dialog).getByRole("button", { name: "Add files" }));
    expect(await within(dialog).findByText("recording-over-50mb.mov")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Send report" }));

    await waitFor(() =>
      expect(mocks.submitIssueReport).toHaveBeenCalledWith({
        category: "bug",
        description: "No description was typed; see the attachments.",
        attachmentNames: ["recording-over-50mb.mov"],
        attachmentPaths: [originalPath],
      }),
    );
    expect(mocks.importHermesBridgeFile).not.toHaveBeenCalled();
    expect(mocks.importHermesBridgeFileBytes).not.toHaveBeenCalled();
    expect(mocks.hermesBridgeFilePreview).not.toHaveBeenCalled();
  });

  it("imports all nine report files from a DOM drop", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), category: "bug" }),
    );
    const files = Array.from(
      { length: 9 },
      (_, index) => new File([`log-${index + 1}`], `report-${index + 1}.txt`),
    );

    render(<AgentWorkspace />);

    const dialog = await screen.findByRole("dialog", { name: "Issue report" });
    mocks.importHermesBridgeFileBytes.mockClear();
    const dropZone = dialog.querySelector(".report-dialog-drop");
    expect(dropZone).not.toBeNull();
    fireEvent.drop(dropZone as HTMLElement, { dataTransfer: { files } });

    await waitFor(() => expect(mocks.importHermesBridgeFileBytes).toHaveBeenCalledTimes(9));
    expect(await within(dialog).findByText("report-9.txt")).toBeInTheDocument();
  });

  it("clears a stale new-session draft before opening a report dialog", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now() }),
    );

    render(<AgentWorkspace />);

    expect(await screen.findByRole("textbox", { name: "Message June" })).toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "stale hero draft");

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_NEW_SESSION_EVENT, {
          detail: { category: "bug" },
        }),
      );
    });

    expect(await screen.findByRole("dialog", { name: "Issue report" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message June" })).not.toHaveTextContent(
      "stale hero draft",
    );
  });

  it("opens a report dialog immediately when the composer is already open", async () => {
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

    expect(await screen.findByRole("dialog", { name: "Issue report" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bug report" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("session.create", expect.anything());
  });

  it("opens a report dialog while the current session is still running", async () => {
    const user = userEvent.setup();
    let resolveSubmit: (() => void) | undefined;
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "prompt.submit") {
        return new Promise((resolve) => {
          resolveSubmit = () => resolve({});
        });
      }
      return Promise.resolve({});
    });

    render(<AgentWorkspace initialSession={existingSession} />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "keep working");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("button", { name: "Stop June" })).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_NEW_SESSION_EVENT, {
          detail: { category: "feedback" },
        }),
      );
    });

    expect(await screen.findByRole("dialog", { name: "Issue report" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Feedback" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Send report" })).toBeDisabled();
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("session.create", expect.anything());

    await act(async () => {
      resolveSubmit?.();
    });
  });

  it("keeps Stop disabled until an existing-session send is actually running", async () => {
    const user = userEvent.setup();
    let resolveResume: (() => void) | undefined;
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return new Promise((resolve) => {
          resolveResume = () => resolve({ session_id: "runtime-session-1" });
        });
      }
      return Promise.resolve({});
    });

    render(<AgentWorkspace initialSession={existingSession} />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Message June" }), "start carefully");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    const stopWhileStarting = await screen.findByRole("button", { name: "Stop June" });
    expect(stopWhileStarting).toBeDisabled();
    expect(stopWhileStarting).toHaveAttribute("title", "June is starting");
    await user.click(stopWhileStarting);
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("session.interrupt", expect.anything());

    await act(async () => resolveResume?.());

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "start carefully",
      }),
    );
    expect(screen.getByRole("button", { name: "Stop June" })).toBeEnabled();
  });

  it("renders submitted steers as read-only while retaining delivery tracking", async () => {
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={existingSession} />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    const composer = screen.getByRole("textbox", { name: "Message June" });
    await user.type(composer, "start the audit");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "start the audit",
      }),
    );

    await user.type(composer, "focus on the API boundary");
    await user.click(screen.getByRole("button", { name: "Send to steer June" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.steer", {
        session_id: "session-1",
        text: "focus on the API boundary",
      }),
    );
    const laterSurfaceReservation = reserveHermesSessionDispatch("session-1");
    expect(laterSurfaceReservation.queuedBehindPrior).toBe(true);
    laterSurfaceReservation.cancel();

    expect(screen.getByRole("region", { name: "Up next" })).toBeInTheDocument();
    expect(screen.queryByText("Steering current turn")).toBeNull();
    expect(screen.queryByText("Queued")).toBeNull();
    expect(screen.getByTitle("focus on the API boundary")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /revise steer/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /dismiss steer/i })).toBeNull();

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "lifecycle.complete",
          session_id: "runtime-session-1",
          payload: { status: "success" },
        });
      }
    });

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "focus on the API boundary",
      }),
    );
  });

  it("combines steering text and waiting attachments in one Up next surface", async () => {
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={existingSession} />);

    const composer = await screen.findByRole("textbox", { name: "Message June" });
    await user.type(composer, "start the audit");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "start the audit",
      }),
    );
    await user.type(composer, "check the API boundary");
    await user.click(screen.getByRole("button", { name: "Send to steer June" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.steer", {
        session_id: "session-1",
        text: "check the API boundary",
      }),
    );
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );
    mocks.eventHandlers.get("tauri://drag-drop")?.({
      payload: { paths: ["/Users/alex/Desktop/brief.pdf"] },
    });
    await user.type(composer, "review the brief next");
    await user.click(screen.getByRole("button", { name: "Queue next message" }));

    const upNext = await screen.findByRole("region", { name: "Up next" });
    // The count numeral only shows while the queue is collapsed.
    expect(within(upNext).queryByText("2")).toBeNull();
    expect(within(upNext).getByText("check the API boundary")).toBeInTheDocument();
    expect(within(upNext).queryByText("Steering current turn")).toBeNull();
    expect(within(upNext).getByText("review the brief next")).toBeInTheDocument();
    expect(within(upNext).getByText("Waiting for June to finish")).toHaveClass(
      "agent-follow-up-announcement",
    );
    expect(within(upNext).getByText("brief.pdf")).toBeInTheDocument();
    expect(screen.getAllByRole("region", { name: "Up next" })).toHaveLength(1);
    expect(screen.queryByText("Queued")).toBeNull();
  });

  it("previews the unified Up next composer state without submitting a message", async () => {
    render(<AgentWorkspace initialSession={existingSession} />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    const upNextDemo = (window as unknown as { __upNextDemo?: (show?: boolean) => string })
      .__upNextDemo;
    expect(upNextDemo).toBeTypeOf("function");
    act(() => {
      upNextDemo?.();
    });

    const upNext = await screen.findByRole("region", { name: "Up next" });
    // The count numeral only shows while the queue is collapsed.
    expect(within(upNext).queryByText("4")).toBeNull();
    expect(within(upNext).getByText("Check the API boundary")).toBeInTheDocument();
    expect(within(upNext).getByText("Keep the migration additive")).toBeInTheDocument();
    expect(within(upNext).queryByText("Steering current turn")).toBeNull();
    expect(within(upNext).getByText("Review this attachment next")).toBeInTheDocument();
    expect(within(upNext).getByText("reference.png")).toBeInTheDocument();
    expect(within(upNext).getByText("Fold these findings into the report")).toBeInTheDocument();
    // A multi-attachment message shows the generic files tile, no filename
    // and no count.
    expect(within(upNext).queryByText("usability-findings.pdf")).toBeNull();
    expect(within(upNext).queryByText("3")).toBeNull();
    expect(screen.getByRole("button", { name: "Stop June" })).toBeInTheDocument();
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("session.steer", expect.anything());
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", expect.anything());

    act(() => {
      upNextDemo?.(false);
    });
    expect(screen.queryByRole("region", { name: "Up next" })).toBeNull();
  });

  it("queues and genuinely removes an attachment follow-up while June is working", async () => {
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={existingSession} />);

    const composer = await screen.findByRole("textbox", { name: "Message June" });
    await user.type(composer, "start the audit");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "start the audit",
      }),
    );
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );
    mocks.eventHandlers.get("tauri://drag-drop")?.({
      payload: { paths: ["/Users/alex/Desktop/brief.pdf"] },
    });
    expect(await screen.findByText("brief.pdf")).toBeInTheDocument();
    await user.type(composer, "review the brief next");
    await user.click(screen.getByRole("button", { name: "Queue next message" }));

    const laterSurfaceReservation = reserveHermesSessionDispatch("session-1");
    expect(laterSurfaceReservation.queuedBehindPrior).toBe(true);
    laterSurfaceReservation.cancel();

    expect(await screen.findByText("Up next")).toBeInTheDocument();
    expect(screen.getByText("review the brief next")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove queued message" })).toBeInTheDocument();
    expect(composer).toHaveTextContent("");
    expect(
      mocks.gatewayRequest.mock.calls.filter(([method]) => method === "prompt.submit"),
    ).toHaveLength(1);
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("session.steer", expect.anything());

    await user.click(screen.getByRole("button", { name: "Edit queued message" }));
    expect(screen.queryByText("Up next")).toBeNull();
    expect(composer).toHaveTextContent("review the brief next");
    expect(screen.getByText("brief.pdf")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Queue next message" }));
    expect(await screen.findByText("Up next")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove queued message" }));
    expect(screen.queryByText("Up next")).toBeNull();
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "lifecycle.complete",
          session_id: "runtime-session-1",
          payload: { status: "success" },
        });
      }
    });
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
    expect(
      mocks.gatewayRequest.mock.calls.filter(([method]) => method === "prompt.submit"),
    ).toHaveLength(1);
  });

  it("keeps queued follow-up identities unique after continuity restores", async () => {
    const user = userEvent.setup();
    const first = render(<AgentWorkspace initialSession={existingSession} />);

    let composer = await screen.findByRole("textbox", { name: "Message June" });
    await user.type(composer, "start the audit");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );
    mocks.eventHandlers.get("tauri://drag-drop")?.({
      payload: { paths: ["/Users/alex/Desktop/first.pdf"] },
    });
    await user.type(composer, "first queued message");
    await user.click(screen.getByRole("button", { name: "Queue next message" }));
    expect(await screen.findByText("first queued message")).toBeInTheDocument();

    first.unmount();
    render(<AgentWorkspace initialSession={existingSession} />);
    composer = await screen.findByRole("textbox", { name: "Message June" });
    expect(await screen.findByText("first queued message")).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );
    mocks.eventHandlers.get("tauri://drag-drop")?.({
      payload: { paths: ["/Users/alex/Desktop/second.pdf"] },
    });
    await user.type(composer, "second queued message");
    await user.click(screen.getByRole("button", { name: "Queue next message" }));

    expect(await screen.findByText("second queued message")).toBeInTheDocument();
    const removeButtons = screen.getAllByRole("button", { name: "Remove queued message" });
    expect(removeButtons).toHaveLength(2);
    await user.click(removeButtons[0]);
    expect(screen.queryByText("first queued message")).toBeNull();
    expect(screen.getByText("second queued message")).toBeInTheDocument();
  });

  it("keeps attachment follow-ups in Send order when later preparation finishes first", async () => {
    const user = userEvent.setup();
    let resolveFirstSkill: (document: {
      name: string;
      relativePath: string;
      content: string;
    }) => void = () => undefined;
    const skillDocument = {
      name: "repo-build-pr",
      relativePath: "repo-build-pr/SKILL.md",
      content: "# Repo build PR\n\nReview the attachment.",
    };
    mocks.hermesBridgeSkills.mockResolvedValue([
      {
        name: "repo-build-pr",
        description: "Build a branch and open a PR",
        enabled: true,
      },
    ]);
    mocks.getHermesBridgeSkill
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirstSkill = resolve;
        }),
      )
      .mockResolvedValue(skillDocument);
    render(<AgentWorkspace initialSession={existingSession} />);

    const composer = await screen.findByRole("textbox", { name: "Message June" });
    await user.type(composer, "start the audit");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "start the audit",
      }),
    );
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );
    mocks.eventHandlers.get("tauri://drag-drop")?.({
      payload: { paths: ["/Users/alex/Desktop/brief.pdf"] },
    });
    await user.type(composer, "/repo-build-pr first accepted message");
    await user.click(screen.getByRole("button", { name: "Queue next message" }));
    await waitFor(() => expect(mocks.getHermesBridgeSkill).toHaveBeenCalledTimes(1));

    await user.clear(composer);
    await user.type(composer, "/repo-build-pr second prepared message");
    await user.click(screen.getByRole("button", { name: "Queue next message" }));
    expect(await screen.findByText("second prepared message")).toBeInTheDocument();

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "lifecycle.complete",
          session_id: "runtime-session-1",
          payload: { status: "success" },
        });
      }
    });
    expect(await screen.findByText("Ready to send")).toBeInTheDocument();
    expect(
      mocks.gatewayRequest.mock.calls.some(
        ([method, params]) =>
          method === "prompt.submit" && params?.text?.includes("second prepared message"),
      ),
    ).toBe(false);

    resolveFirstSkill(skillDocument);
    await waitFor(() =>
      expect(
        mocks.gatewayRequest.mock.calls.some(
          ([method, params]) =>
            method === "prompt.submit" && params?.text?.includes("first accepted message"),
        ),
      ).toBe(true),
    );
    expect(
      mocks.gatewayRequest.mock.calls.some(
        ([method, params]) =>
          method === "prompt.submit" && params?.text?.includes("second prepared message"),
      ),
    ).toBe(false);
  });

  it("releases queued attachment dispatch reservations when a session is deleted", async () => {
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={existingSession} />);

    const composer = await screen.findByRole("textbox", { name: "Message June" });
    await user.type(composer, "start the audit");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "start the audit",
      }),
    );
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );
    mocks.eventHandlers.get("tauri://drag-drop")?.({
      payload: { paths: ["/Users/alex/Desktop/brief.pdf"] },
    });
    await user.type(composer, "queued before deletion");
    await user.click(screen.getByRole("button", { name: "Queue next message" }));
    expect(await screen.findByText("queued before deletion")).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_DELETE_SESSION_EVENT, {
          detail: { sessionId: "session-1" },
        }),
      );
    });

    let laterDispatchRan = false;
    const laterReservation = reserveHermesSessionDispatch("session-1");
    await laterReservation.run(async () => {
      laterDispatchRan = true;
    });
    expect(laterDispatchRan).toBe(true);
    expect(screen.queryByText("queued before deletion")).toBeNull();
  });

  it("invalidates an attachment preparation when its session is deleted", async () => {
    const user = userEvent.setup();
    let resolveSkill: (document: { name: string; relativePath: string; content: string }) => void =
      () => undefined;
    const skillDocument = {
      name: "repo-build-pr",
      relativePath: "repo-build-pr/SKILL.md",
      content: "# Repo build PR\n\nReview the attachment.",
    };
    mocks.hermesBridgeSkills.mockResolvedValue([
      {
        name: "repo-build-pr",
        description: "Build a branch and open a PR",
        enabled: true,
      },
    ]);
    mocks.getHermesBridgeSkill.mockReturnValue(
      new Promise((resolve) => {
        resolveSkill = resolve;
      }),
    );
    render(<AgentWorkspace initialSession={existingSession} />);

    const composer = await screen.findByRole("textbox", { name: "Message June" });
    await user.type(composer, "start the audit");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "start the audit",
      }),
    );
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );
    mocks.eventHandlers.get("tauri://drag-drop")?.({
      payload: { paths: ["/Users/alex/Desktop/brief.pdf"] },
    });
    await user.type(composer, "/repo-build-pr orphan after deletion");
    await user.click(screen.getByRole("button", { name: "Queue next message" }));
    await waitFor(() => expect(mocks.getHermesBridgeSkill).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_DELETE_SESSION_EVENT, {
          detail: { sessionId: "session-1" },
        }),
      );
    });
    let laterDispatchRan = false;
    const laterReservation = reserveHermesSessionDispatch("session-1");
    await laterReservation.run(async () => {
      laterDispatchRan = true;
    });
    expect(laterDispatchRan).toBe(true);

    await act(async () => {
      resolveSkill(skillDocument);
    });
    await waitFor(() =>
      expect(
        mocks.gatewayRequest.mock.calls.some(
          ([method, params]) =>
            method === "prompt.submit" && params?.text?.includes("orphan after deletion"),
        ),
      ).toBe(false),
    );
    expect(screen.queryByText("orphan after deletion")).toBeNull();
  });

  it("releases a pending steer dispatch reservation when a session is deleted", async () => {
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={existingSession} />);

    const composer = await screen.findByRole("textbox", { name: "Message June" });
    await user.type(composer, "start the audit");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "start the audit",
      }),
    );
    await user.type(composer, "steer before deletion");
    await user.click(screen.getByRole("button", { name: "Send to steer June" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.steer", {
        session_id: "session-1",
        text: "steer before deletion",
      }),
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_DELETE_SESSION_EVENT, {
          detail: { sessionId: "session-1" },
        }),
      );
    });
    let laterDispatchRan = false;
    const laterReservation = reserveHermesSessionDispatch("session-1");
    await laterReservation.run(async () => {
      laterDispatchRan = true;
    });
    expect(laterDispatchRan).toBe(true);
    expect(screen.queryByText("steer before deletion")).toBeNull();
  });

  it("invalidates a full composer preparation when its session is deleted", async () => {
    const user = userEvent.setup();
    let resolveSkill: (document: { name: string; relativePath: string; content: string }) => void =
      () => undefined;
    const skillDocument = {
      name: "repo-build-pr",
      relativePath: "repo-build-pr/SKILL.md",
      content: "# Repo build PR\n\nReview the request.",
    };
    mocks.hermesBridgeSkills.mockResolvedValue([
      {
        name: "repo-build-pr",
        description: "Build a branch and open a PR",
        enabled: true,
      },
    ]);
    mocks.getHermesBridgeSkill.mockReturnValue(
      new Promise((resolve) => {
        resolveSkill = resolve;
      }),
    );
    render(<AgentWorkspace initialSession={existingSession} />);

    const composer = await screen.findByRole("textbox", { name: "Message June" });
    await user.type(composer, "/repo-build-pr pending deletion");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(mocks.getHermesBridgeSkill).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_DELETE_SESSION_EVENT, {
          detail: { sessionId: "session-1" },
        }),
      );
    });
    let laterDispatchRan = false;
    const laterReservation = reserveHermesSessionDispatch("session-1");
    await laterReservation.run(async () => {
      laterDispatchRan = true;
    });
    expect(laterDispatchRan).toBe(true);

    await act(async () => {
      resolveSkill(skillDocument);
    });
    await waitFor(() =>
      expect(
        mocks.gatewayRequest.mock.calls.some(
          ([method, params]) =>
            method === "prompt.submit" && params?.text?.includes("pending deletion"),
        ),
      ).toBe(false),
    );
    expect(screen.queryByText("pending deletion")).toBeNull();
  });

  it("keeps another session's media consent open when deleting a preparing session", async () => {
    const user = userEvent.setup();
    let resolveSkill: (document: { name: string; relativePath: string; content: string }) => void =
      () => undefined;
    const skillDocument = {
      name: "repo-build-pr",
      relativePath: "repo-build-pr/SKILL.md",
      content: "# Repo build PR\n\nReview the attachment.",
    };
    const secondSession = {
      ...existingSession,
      id: "session-2",
      title: "Other session",
      preview: "Other preview",
    };
    mocks.listHermesSessions.mockResolvedValue([existingSession, secondSession]);
    mocks.hermesBridgeSkills.mockResolvedValue([
      {
        name: "repo-build-pr",
        description: "Build a branch and open a PR",
        enabled: true,
      },
    ]);
    mocks.getHermesBridgeSkill.mockReturnValue(
      new Promise((resolve) => {
        resolveSkill = resolve;
      }),
    );
    mockGlmCapabilities(["functionCalling", "supportsVision"]);
    mockImageSettings({ imageSafeMode: true, imageSafeModePromptDismissed: false });
    mocks.imagePromptMayBeExplicit.mockResolvedValue(true);
    const view = render(<AgentWorkspace initialSession={existingSession} />);

    let composer = await screen.findByRole("textbox", { name: "Message June" });
    await user.type(composer, "start the audit");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "start the audit",
      }),
    );
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );
    mocks.eventHandlers.get("tauri://drag-drop")?.({
      payload: { paths: ["/Users/alex/Desktop/brief.pdf"] },
    });
    await user.type(composer, "/repo-build-pr preparing in session A");
    await user.click(screen.getByRole("button", { name: "Queue next message" }));
    await waitFor(() => expect(mocks.getHermesBridgeSkill).toHaveBeenCalledTimes(1));

    view.rerender(<AgentWorkspace initialSession={secondSession} />);
    composer = await screen.findByRole("textbox", { name: "Message June" });
    await waitFor(() => expect(composer).toHaveTextContent(""));
    await user.type(composer, "/image explicit prompt in session B");
    fireEvent.submit(document.querySelector(".agent-composer") as HTMLFormElement);
    const dialog = await screen.findByRole("dialog", { name: "Safe mode is on" });

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_DELETE_SESSION_EVENT, {
          detail: { sessionId: "session-1" },
        }),
      );
    });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Safe mode is on" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await act(async () => {
      resolveSkill(skillDocument);
    });
  });

  it("sends a queued file follow-up after the current turn completes", async () => {
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={existingSession} />);

    const composer = await screen.findByRole("textbox", { name: "Message June" });
    await user.type(composer, "start the audit");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "start the audit",
      }),
    );
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );
    mocks.eventHandlers.get("tauri://drag-drop")?.({
      payload: { paths: ["/Users/alex/Desktop/brief.pdf"] },
    });
    expect(await screen.findByText("brief.pdf")).toBeInTheDocument();
    await user.type(composer, "review the brief next");
    await user.click(screen.getByRole("button", { name: "Queue next message" }));

    expect(
      mocks.gatewayRequest.mock.calls.filter(([method]) => method === "prompt.submit"),
    ).toHaveLength(1);
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "lifecycle.complete",
          session_id: "runtime-session-1",
          payload: { status: "success" },
        });
      }
    });

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: expect.stringMatching(/review the brief next[\s\S]*uploads\/brief\.pdf/),
      }),
    );
    expect(screen.queryByText("Up next")).toBeNull();
  });

  it("hands a completed run's queued continuation to the remounted workspace", async () => {
    vi.useFakeTimers();
    try {
      mocks.startAgentRunMonitoring.mockReturnValueOnce(1).mockReturnValueOnce(2);
      const first = render(<AgentWorkspace initialSession={existingSession} />);
      await settleUnderFakeTimers(() =>
        expect(screen.getByRole("textbox", { name: "Message June" })).toBeInTheDocument(),
      );
      const composer = screen.getByRole("textbox", { name: "Message June" });
      fireEvent.paste(composer, { clipboardData: { getData: () => "start before navigation" } });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await settleUnderFakeTimers(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text: "start before navigation",
        }),
      );
      await settleUnderFakeTimers(() =>
        expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
      );
      act(() => {
        mocks.eventHandlers.get("tauri://drag-drop")?.({
          payload: { paths: ["/Users/alex/Desktop/navigation-follow-up.pdf"] },
        });
      });
      await settleUnderFakeTimers(() =>
        expect(screen.getByText("navigation-follow-up.pdf")).toBeInTheDocument(),
      );
      fireEvent.paste(composer, {
        clipboardData: { getData: () => "send once after navigation" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Queue next message" }));
      await settleUnderFakeTimers(() => {
        const upNext = screen.getByRole("region", { name: "Up next" });
        expect(within(upNext).getByText("send once after navigation")).toBeInTheDocument();
      });

      const firstGateway = mocks.gatewayInstances[0];
      expect(firstGateway).toBeDefined();
      const firstGatewayConnectCount = firstGateway.connect.mock.calls.length;
      act(() => {
        for (const handler of [...mocks.gatewayEventHandlers]) {
          handler({
            type: "lifecycle.complete",
            session_id: "runtime-session-1",
            event_id: "pre-navigation-terminal",
            payload: { status: "success" },
          });
        }
      });
      first.unmount();

      render(<AgentWorkspace initialSession={existingSession} />);
      await settleUnderFakeTimers(() =>
        expect(screen.getByText("send once after navigation")).toBeInTheDocument(),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await settleUnderFakeTimers(() =>
        expect(
          mocks.gatewayRequest.mock.calls.filter(
            ([method, params]) =>
              method === "prompt.submit" &&
              typeof params?.text === "string" &&
              params.text.includes("send once after navigation"),
          ),
        ).toHaveLength(1),
      );
      expect(firstGateway.connect).toHaveBeenCalledTimes(firstGatewayConnectCount);

      act(() => {
        window.dispatchEvent(
          new CustomEvent(AGENT_RUN_SETTLED_EVENT, {
            detail: {
              sessionId: "session-1",
              runMonitorGeneration: 2,
              title: "Existing session",
              summary: "June finished.",
            },
          }),
        );
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await settleUnderFakeTimers(() =>
        expect(screen.queryByRole("region", { name: "Up next" })).toBeNull(),
      );
      expect(
        mocks.gatewayRequest.mock.calls.filter(
          ([method, params]) =>
            method === "prompt.submit" &&
            typeof params?.text === "string" &&
            params.text.includes("send once after navigation"),
        ),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a queued continuation gateway created after its workspace unmounts", async () => {
    mocks.startAgentRunMonitoring.mockReturnValueOnce(1).mockReturnValueOnce(2);
    const first = render(<AgentWorkspace initialSession={existingSession} />);
    const composer = await screen.findByRole("textbox", { name: "Message June" });
    fireEvent.paste(composer, { clipboardData: { getData: () => "start before gateway handoff" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );
    act(() => {
      mocks.eventHandlers.get("tauri://drag-drop")?.({
        payload: { paths: ["/Users/alex/Desktop/gateway-handoff.pdf"] },
      });
    });
    expect(await screen.findByText("gateway-handoff.pdf")).toBeInTheDocument();
    fireEvent.paste(composer, {
      clipboardData: { getData: () => "send after delayed gateway creation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Queue next message" }));
    expect(await screen.findByText("send after delayed gateway creation")).toBeInTheDocument();

    act(() => {
      for (const handler of [...mocks.gatewayEventHandlers]) {
        handler({
          type: "lifecycle.complete",
          session_id: "runtime-session-1",
          event_id: "gateway-handoff-predecessor-terminal",
          payload: { status: "success" },
        });
      }
    });
    first.unmount();

    let resolveBridgeStart:
      | ((status: {
          running: boolean;
          connection: { port: number; wsUrl: string; fullMode: boolean };
          connections: Array<{ port: number; wsUrl: string; fullMode: boolean }>;
        }) => void)
      | undefined;
    const delayedBridgeStart = new Promise<{
      running: boolean;
      connection: { port: number; wsUrl: string; fullMode: boolean };
      connections: Array<{ port: number; wsUrl: string; fullMode: boolean }>;
    }>((resolve) => {
      resolveBridgeStart = resolve;
    });
    mocks.hermesBridgeStatus.mockResolvedValue({
      running: true,
      connection: { port: 61234, wsUrl: "ws://127.0.0.1:61234", fullMode: true },
      connections: [{ port: 61234, wsUrl: "ws://127.0.0.1:61234", fullMode: true }],
    });
    mocks.startHermesBridge.mockReturnValue(delayedBridgeStart);
    const gatewayCountBeforeReplacement = mocks.gatewayInstances.length;
    const second = render(<AgentWorkspace initialSession={existingSession} />);
    const remountedUpNext = await screen.findByRole("region", { name: "Up next" });
    expect(await within(remountedUpNext).findByText("Sending")).toBeInTheDocument();
    await waitFor(() => expect(mocks.startHermesBridge).toHaveBeenCalled());
    expect(mocks.gatewayInstances).toHaveLength(gatewayCountBeforeReplacement);

    second.unmount();
    await act(async () => {
      resolveBridgeStart?.({
        running: true,
        connection: { port: 61235, wsUrl: "ws://127.0.0.1:61235", fullMode: false },
        connections: [{ port: 61235, wsUrl: "ws://127.0.0.1:61235", fullMode: false }],
      });
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    await waitFor(() =>
      expect(mocks.gatewayInstances.length).toBeGreaterThan(gatewayCountBeforeReplacement),
    );
    const lateGateway = mocks.gatewayInstances.at(-1);
    expect(lateGateway).toBeDefined();
    await waitFor(() => expect(lateGateway?.close).toHaveBeenCalledTimes(1));
  });

  it("holds a remounted fast-terminal continuation through its post-ack refresh", async () => {
    let deferFirstFollowUpLoad = false;
    let resolveFirstFollowUpLoad: ((sessions: (typeof existingSession)[]) => void) | undefined;
    mocks.startAgentRunMonitoring
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(2)
      .mockReturnValueOnce(3);
    mocks.listHermesSessions.mockImplementation(() => {
      if (!deferFirstFollowUpLoad) return Promise.resolve([existingSession]);
      deferFirstFollowUpLoad = false;
      return new Promise<(typeof existingSession)[]>((resolve) => {
        resolveFirstFollowUpLoad = resolve;
      });
    });
    mocks.gatewayRequest.mockImplementation((method: string, params?: { text?: string }) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "prompt.submit" && params?.text?.includes("first after bridge remount")) {
        deferFirstFollowUpLoad = true;
      }
      return Promise.resolve({});
    });
    const first = render(<AgentWorkspace initialSession={existingSession} />);
    const composer = await screen.findByRole("textbox", { name: "Message June" });
    fireEvent.paste(composer, { clipboardData: { getData: () => "start before bridge remount" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );
    for (const [path, message] of [
      ["/Users/alex/Desktop/bridge-first.pdf", "first after bridge remount"],
      ["/Users/alex/Desktop/bridge-second.pdf", "second after bridge remount"],
    ] as const) {
      act(() => {
        mocks.eventHandlers.get("tauri://drag-drop")?.({ payload: { paths: [path] } });
      });
      expect(await screen.findByText(path.split("/").at(-1) ?? path)).toBeInTheDocument();
      fireEvent.paste(composer, { clipboardData: { getData: () => message } });
      fireEvent.click(screen.getByRole("button", { name: "Queue next message" }));
      expect(await screen.findByText(message)).toBeInTheDocument();
    }

    act(() => {
      for (const handler of [...mocks.gatewayEventHandlers]) {
        handler({
          type: "lifecycle.complete",
          session_id: "runtime-session-1",
          event_id: "bridge-remount-predecessor-terminal",
          payload: { status: "success" },
        });
      }
    });
    first.unmount();

    let resolveReplacementBridgeStatus:
      | ((status: {
          running: boolean;
          connection: { port: number; wsUrl: string; fullMode: boolean };
          connections: Array<{ port: number; wsUrl: string; fullMode: boolean }>;
        }) => void)
      | undefined;
    mocks.hermesBridgeStatus.mockReturnValue(
      new Promise((resolve) => {
        resolveReplacementBridgeStatus = resolve;
      }),
    );
    render(<AgentWorkspace initialSession={existingSession} />);
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(
      mocks.gatewayRequest.mock.calls.some(
        ([method, params]) =>
          method === "prompt.submit" && params?.text?.includes("first after bridge remount"),
      ),
    ).toBe(false);
    await act(async () => {
      resolveReplacementBridgeStatus?.({
        running: true,
        connection: { port: 61236, wsUrl: "ws://127.0.0.1:61236", fullMode: false },
        connections: [{ port: 61236, wsUrl: "ws://127.0.0.1:61236", fullMode: false }],
      });
    });

    await waitFor(() => expect(resolveFirstFollowUpLoad).toBeTypeOf("function"));
    act(() => {
      for (const handler of [...mocks.gatewayEventHandlers]) {
        handler({
          type: "lifecycle.complete",
          session_id: "runtime-session-1",
          event_id: "remounted-first-fast-terminal",
          payload: { status: "success" },
        });
      }
    });
    expect(
      mocks.gatewayRequest.mock.calls.some(
        ([method, params]) =>
          method === "prompt.submit" && params?.text?.includes("second after bridge remount"),
      ),
    ).toBe(false);

    await act(async () => {
      resolveFirstFollowUpLoad?.([existingSession]);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: expect.stringContaining("second after bridge remount"),
      }),
    );
    await waitFor(() => expect(screen.queryByRole("region", { name: "Up next" })).toBeNull());
    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_SETTLED_EVENT, {
          detail: {
            sessionId: "session-1",
            runMonitorGeneration: 3,
            title: "Existing session",
            summary: "June finished.",
          },
        }),
      );
    });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });

  it("keeps a remounted queued row sending until its held prompt acknowledgement settles", async () => {
    let resolveFollowUpSubmit: (() => void) | undefined;
    mocks.startAgentRunMonitoring
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(2)
      .mockReturnValueOnce(3);
    mocks.gatewayRequest.mockImplementation((method: string, params?: { text?: string }) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "prompt.submit" && params?.text?.includes("held across navigation")) {
        return new Promise((resolve) => {
          resolveFollowUpSubmit = () => resolve({});
        });
      }
      return Promise.resolve({});
    });
    const first = render(<AgentWorkspace initialSession={existingSession} />);
    const composer = await screen.findByRole("textbox", { name: "Message June" });
    fireEvent.paste(composer, { clipboardData: { getData: () => "start before held send" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "start before held send",
      }),
    );
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );
    act(() => {
      mocks.eventHandlers.get("tauri://drag-drop")?.({
        payload: { paths: ["/Users/alex/Desktop/held-follow-up.pdf"] },
      });
    });
    expect(await screen.findByText("held-follow-up.pdf")).toBeInTheDocument();
    fireEvent.paste(composer, {
      clipboardData: { getData: () => "held across navigation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Queue next message" }));
    expect(await screen.findByText("held across navigation")).toBeInTheDocument();
    act(() => {
      mocks.eventHandlers.get("tauri://drag-drop")?.({
        payload: { paths: ["/Users/alex/Desktop/second-held-follow-up.pdf"] },
      });
    });
    expect(await screen.findByText("second-held-follow-up.pdf")).toBeInTheDocument();
    fireEvent.paste(composer, {
      clipboardData: { getData: () => "send after the held acknowledgement" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Queue next message" }));
    expect(await screen.findByText("send after the held acknowledgement")).toBeInTheDocument();

    act(() => {
      for (const handler of [...mocks.gatewayEventHandlers]) {
        handler({
          type: "lifecycle.complete",
          session_id: "runtime-session-1",
          event_id: "held-follow-up-predecessor-terminal",
          payload: { status: "success" },
        });
      }
    });
    await waitFor(() => expect(resolveFollowUpSubmit).toBeTypeOf("function"));
    expect(screen.getByText("Sending")).toBeInTheDocument();

    first.unmount();
    const second = render(<AgentWorkspace initialSession={existingSession} />);
    const remountedUpNext = await screen.findByRole("region", { name: "Up next" });
    expect(within(remountedUpNext).getByText("held across navigation")).toBeInTheDocument();
    expect(within(remountedUpNext).getByText("Sending")).toBeInTheDocument();
    expect(within(remountedUpNext).queryByText("Delivery was interrupted. Try again.")).toBeNull();
    expect(
      within(remountedUpNext).queryByRole("button", { name: "Retry queued message" }),
    ).toBeNull();

    act(() => {
      for (const handler of [...mocks.gatewayEventHandlers]) {
        handler({
          type: "lifecycle.complete",
          session_id: "runtime-session-1",
          event_id: "held-follow-up-fast-terminal",
          payload: { status: "success" },
        });
      }
    });

    await act(async () => {
      resolveFollowUpSubmit?.();
    });
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: expect.stringContaining("send after the held acknowledgement"),
      }),
    );
    await waitFor(() => expect(screen.queryByRole("region", { name: "Up next" })).toBeNull());

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_SETTLED_EVENT, {
          detail: {
            sessionId: "session-1",
            runMonitorGeneration: 2,
            title: "Existing session",
            summary: "June finished.",
          },
        }),
      );
    });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(
      mocks.gatewayRequest.mock.calls.filter(
        ([method, params]) =>
          method === "prompt.submit" &&
          typeof params?.text === "string" &&
          params.text.includes("held across navigation"),
      ),
    ).toHaveLength(1);
    expect(screen.queryByText("Hermes session dispatch reservation was already used.")).toBeNull();

    second.unmount();
    const third = render(<AgentWorkspace initialSession={existingSession} />);
    const reusedIdComposer = await screen.findByRole("textbox", { name: "Message June" });
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );
    for (const [path, message] of [
      ["/Users/alex/Desktop/reused-first.pdf", "first message after identity reset"],
      ["/Users/alex/Desktop/reused-second.pdf", "second message after identity reset"],
    ] as const) {
      act(() => {
        mocks.eventHandlers.get("tauri://drag-drop")?.({ payload: { paths: [path] } });
      });
      expect(await screen.findByText(path.split("/").at(-1) ?? path)).toBeInTheDocument();
      fireEvent.paste(reusedIdComposer, { clipboardData: { getData: () => message } });
      fireEvent.click(screen.getByRole("button", { name: "Queue next message" }));
      expect(await screen.findByText(message)).toBeInTheDocument();
    }

    third.unmount();
    render(<AgentWorkspace initialSession={existingSession} />);
    const reusedIdUpNext = await screen.findByRole("region", { name: "Up next" });
    expect(
      within(reusedIdUpNext).getByText("first message after identity reset"),
    ).toBeInTheDocument();
    expect(
      within(reusedIdUpNext).getByText("second message after identity reset"),
    ).toBeInTheDocument();
  });

  it("does not auto-send a completed run's continuation after a newer run starts", async () => {
    vi.useFakeTimers();
    try {
      mocks.startAgentRunMonitoring.mockReturnValueOnce(1).mockReturnValueOnce(3);
      render(<AgentWorkspace initialSession={existingSession} />);
      await settleUnderFakeTimers(() =>
        expect(screen.getByRole("textbox", { name: "Message June" })).toBeInTheDocument(),
      );
      const composer = screen.getByRole("textbox", { name: "Message June" });
      fireEvent.paste(composer, { clipboardData: { getData: () => "start generation one" } });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await settleUnderFakeTimers(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text: "start generation one",
        }),
      );

      fireEvent.paste(composer, { clipboardData: { getData: () => "preserve this follow-up" } });
      fireEvent.click(screen.getByRole("button", { name: "Send to steer June" }));
      await settleUnderFakeTimers(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.steer", {
          session_id: "session-1",
          text: "preserve this follow-up",
        }),
      );

      act(() => {
        for (const handler of [...mocks.gatewayEventHandlers]) {
          handler({
            type: "lifecycle.complete",
            session_id: "runtime-session-1",
            event_id: "generation-one-complete",
            payload: { status: "success" },
          });
        }
        window.dispatchEvent(
          new CustomEvent(AGENT_RUN_STARTED_EVENT, {
            detail: {
              storedSessionId: "session-1",
              runMonitorGeneration: 2,
              runtimeSessionId: "runtime-note-chat",
              fullMode: false,
            },
          }),
        );
        // The passive generation can settle before generation one's queued
        // continuation callback gets its first timer turn. That settlement
        // must remain pending and re-enter the queue exactly once.
        window.dispatchEvent(
          new CustomEvent(AGENT_RUN_SETTLED_EVENT, {
            detail: {
              sessionId: "session-1",
              runMonitorGeneration: 2,
              title: "Existing session",
              summary: "June finished.",
            },
          }),
        );
      });
      expect(
        mocks.gatewayRequest.mock.calls.filter(([method]) => method === "prompt.submit"),
      ).toHaveLength(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText("preserve this follow-up")).toBeInTheDocument();
      await settleUnderFakeTimers(() =>
        expect(
          mocks.gatewayRequest.mock.calls.filter(
            ([method, params]) =>
              method === "prompt.submit" &&
              typeof params?.text === "string" &&
              params.text.includes("preserve this follow-up"),
          ),
        ).toHaveLength(1),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a fast terminal's queued continuation behind a newer cross-surface run", async () => {
    let deferFirstFollowUpLoad = false;
    let resolveFirstFollowUpLoad: ((sessions: (typeof existingSession)[]) => void) | undefined;
    mocks.startAgentRunMonitoring
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(2)
      .mockReturnValueOnce(4);
    mocks.listHermesSessions.mockImplementation(() => {
      if (!deferFirstFollowUpLoad) return Promise.resolve([existingSession]);
      deferFirstFollowUpLoad = false;
      return new Promise<(typeof existingSession)[]>((resolve) => {
        resolveFirstFollowUpLoad = resolve;
      });
    });
    mocks.gatewayRequest.mockImplementation((method: string, params?: { text?: string }) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "prompt.submit" && params?.text?.includes("first fast-terminal follow-up")) {
        deferFirstFollowUpLoad = true;
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={existingSession} />);

    const composer = await screen.findByRole("textbox", { name: "Message June" });
    await user.type(composer, "start before the fast terminal");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );
    for (const [path, message] of [
      ["/Users/alex/Desktop/first-fast.pdf", "first fast-terminal follow-up"],
      ["/Users/alex/Desktop/second-after-newer.pdf", "second follow-up after newer run"],
    ] as const) {
      act(() => {
        mocks.eventHandlers.get("tauri://drag-drop")?.({ payload: { paths: [path] } });
      });
      expect(await screen.findByText(path.split("/").at(-1) ?? path)).toBeInTheDocument();
      await user.type(composer, message);
      await user.click(screen.getByRole("button", { name: "Queue next message" }));
      expect(await screen.findByText(message)).toBeInTheDocument();
    }

    act(() => {
      for (const handler of [...mocks.gatewayEventHandlers]) {
        handler({
          type: "lifecycle.complete",
          session_id: "runtime-session-1",
          event_id: "fast-terminal-predecessor-complete",
          payload: { status: "success" },
        });
      }
    });
    await waitFor(() => expect(resolveFirstFollowUpLoad).toBeTypeOf("function"));
    act(() => {
      for (const handler of [...mocks.gatewayEventHandlers]) {
        handler({
          type: "lifecycle.complete",
          session_id: "runtime-session-1",
          event_id: "first-follow-up-fast-terminal",
          payload: { status: "success" },
        });
      }
    });
    expect(
      mocks.gatewayRequest.mock.calls.some(
        ([method, params]) =>
          method === "prompt.submit" && params?.text?.includes("second follow-up after newer run"),
      ),
    ).toBe(false);

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_STARTED_EVENT, {
          detail: {
            storedSessionId: "session-1",
            runMonitorGeneration: 3,
            runtimeSessionId: "runtime-note-chat",
            fullMode: false,
          },
        }),
      );
    });
    await act(async () => {
      resolveFirstFollowUpLoad?.([existingSession]);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(
      mocks.gatewayRequest.mock.calls.some(
        ([method, params]) =>
          method === "prompt.submit" && params?.text?.includes("second follow-up after newer run"),
      ),
    ).toBe(false);

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_SETTLED_EVENT, {
          detail: {
            sessionId: "session-1",
            runMonitorGeneration: 3,
            title: "Existing session",
            summary: "June finished.",
          },
        }),
      );
    });
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: expect.stringContaining("second follow-up after newer run"),
      }),
    );
  });

  it("advances a completed turn once and keeps attachment follow-ups behind undrained steers", async () => {
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={existingSession} />);

    const composer = await screen.findByRole("textbox", { name: "Message June" });
    await user.type(composer, "start the audit");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "start the audit",
      }),
    );
    await user.type(composer, "check the API boundary");
    await user.click(screen.getByRole("button", { name: "Send to steer June" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.steer", {
        session_id: "session-1",
        text: "check the API boundary",
      }),
    );
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );
    mocks.eventHandlers.get("tauri://drag-drop")?.({
      payload: { paths: ["/Users/alex/Desktop/brief.pdf"] },
    });
    await user.type(composer, "review the brief after that");
    await user.click(screen.getByRole("button", { name: "Queue next message" }));

    const firstRunCompleted = {
      type: "lifecycle.complete",
      session_id: "runtime-session-1",
      payload: { status: "success" },
    };
    act(() => {
      for (const handler of [...mocks.gatewayEventHandlers]) {
        handler(firstRunCompleted);
      }
    });

    await waitFor(() =>
      expect(
        mocks.gatewayRequest.mock.calls.filter(
          ([method, params]) =>
            method === "prompt.submit" && params?.text === "check the API boundary",
        ),
      ).toHaveLength(1),
    );
    expect(
      mocks.gatewayRequest.mock.calls.some(
        ([method, params]) =>
          method === "prompt.submit" && params?.text?.includes("review the brief after that"),
      ),
    ).toBe(false);
    expect(screen.getByText("review the brief after that")).toBeInTheDocument();

    // The gateway can replay the previous Agent run's terminal after the steer has
    // installed its next listener. It must not terminate that new run.
    act(() => {
      for (const handler of [...mocks.gatewayEventHandlers]) {
        handler(firstRunCompleted);
      }
    });
    await act(async () => Promise.resolve());
    expect(
      mocks.gatewayRequest.mock.calls.some(
        ([method, params]) =>
          method === "prompt.submit" && params?.text?.includes("review the brief after that"),
      ),
    ).toBe(false);

    act(() => {
      for (const handler of [...mocks.gatewayEventHandlers]) {
        handler({
          type: "lifecycle.complete",
          session_id: "runtime-session-1",
          event_id: "current-follow-up-terminal",
          payload: { status: "success" },
        });
      }
    });
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: expect.stringContaining("review the brief after that"),
      }),
    );
  });

  it("keeps a later steer fallback behind an earlier attachment follow-up", async () => {
    let activeStatus: "absent" | "working" | "idle" = "absent";
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "session.active_list") {
        return Promise.resolve({
          sessions:
            activeStatus === "absent"
              ? []
              : [
                  {
                    id: "runtime-session-1",
                    session_key: "session-1",
                    status: activeStatus,
                  },
                ],
        });
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={existingSession} />);

    const composer = await screen.findByRole("textbox", { name: "Message June" });
    await user.type(composer, "start the audit");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "start the audit",
      }),
    );
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );
    mocks.eventHandlers.get("tauri://drag-drop")?.({
      payload: { paths: ["/Users/alex/Desktop/brief.pdf"] },
    });
    await user.type(composer, "review the brief first");
    await user.click(screen.getByRole("button", { name: "Queue next message" }));
    await user.type(composer, "then check the API boundary");
    await user.click(screen.getByRole("button", { name: "Send to steer June" }));

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "lifecycle.complete",
          session_id: "runtime-session-1",
          payload: { status: "success" },
        });
      }
    });

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: expect.stringMatching(/review the brief first[\s\S]*uploads\/brief\.pdf/),
      }),
    );
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", {
      session_id: "runtime-session-1",
      text: "then check the API boundary",
    });
    const acceptedFollowUpText = mocks.gatewayRequest.mock.calls.find(
      ([method, params]) =>
        method === "prompt.submit" && params?.text?.includes("review the brief first"),
    )?.[1]?.text;
    expect(acceptedFollowUpText).toEqual(expect.any(String));
    mocks.listHermesSessionMessages.mockClear();
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "persisted-follow-up-user",
        role: "user",
        content: acceptedFollowUpText,
      },
      {
        id: "persisted-follow-up-assistant",
        role: "assistant",
        content: "The brief review is complete.",
      },
    ]);

    const activeListCallCount = () =>
      mocks.gatewayRequest.mock.calls.filter(([method]) => method === "session.active_list").length;
    const activeListCallsBeforeReplay = activeListCallCount();
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "lifecycle.complete",
          session_id: "runtime-session-1",
          payload: { status: "success" },
        });
      }
    });
    await waitFor(() => expect(mocks.listHermesSessionMessages).toHaveBeenCalled());
    await waitFor(() => expect(activeListCallCount()).toBe(activeListCallsBeforeReplay + 1));
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", {
      session_id: "runtime-session-1",
      text: "then check the API boundary",
    });

    activeStatus = "working";
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "lifecycle.complete",
          session_id: "runtime-session-1",
          payload: { status: "success" },
        });
      }
    });
    await waitFor(() => expect(activeListCallCount()).toBe(activeListCallsBeforeReplay + 2));
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", {
      session_id: "runtime-session-1",
      text: "then check the API boundary",
    });

    activeStatus = "idle";
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "lifecycle.complete",
          session_id: "runtime-session-1",
          payload: { status: "success" },
        });
      }
    });
    await waitFor(() => expect(activeListCallCount()).toBe(activeListCallsBeforeReplay + 3));
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", {
      session_id: "runtime-session-1",
      text: "then check the API boundary",
    });

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_SETTLED_EVENT, {
          detail: {
            sessionId: "session-1",
            title: "Existing session",
            runMonitorGeneration: 1,
            summary: "June finished.",
          },
        }),
      );
    });
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "then check the API boundary",
      }),
    );
  });

  it("advances the remaining follow-up queue when the submitted item completes immediately", async () => {
    let immediateTerminalWasDeferred = false;
    mocks.gatewayRequest.mockImplementation((method: string, params?: { text?: string }) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "prompt.submit" && params?.text?.includes("first queued message")) {
        const succeededBeforeTerminal = mocks.markAgentRunSucceeded.mock.calls.length;
        for (const handler of [...mocks.gatewayEventHandlers]) {
          handler({
            type: "lifecycle.complete",
            session_id: "runtime-session-1",
            event_id: "first-queued-terminal",
            payload: { status: "success" },
          });
        }
        immediateTerminalWasDeferred =
          mocks.markAgentRunSucceeded.mock.calls.length === succeededBeforeTerminal;
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={existingSession} />);

    const composer = await screen.findByRole("textbox", { name: "Message June" });
    await user.type(composer, "start the audit");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "start the audit",
      }),
    );
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );

    for (const [path, message] of [
      ["/Users/alex/Desktop/first.pdf", "first queued message"],
      ["/Users/alex/Desktop/second.pdf", "second queued message"],
    ]) {
      mocks.eventHandlers.get("tauri://drag-drop")?.({ payload: { paths: [path] } });
      expect(await screen.findByText(path.split("/").at(-1) ?? path)).toBeInTheDocument();
      await user.type(composer, message);
      await user.click(screen.getByRole("button", { name: "Queue next message" }));
    }

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "lifecycle.complete",
          session_id: "runtime-session-1",
          payload: { status: "success" },
        });
      }
    });

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: expect.stringContaining("second queued message"),
      }),
    );
    expect(immediateTerminalWasDeferred).toBe(true);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Up next" })).toBeNull());
  });

  it("advances the queue when polling settles a follow-up during the prior continuation", async () => {
    type PersistedMessage = {
      id: string;
      role: "user" | "assistant";
      content: string;
      timestamp: string;
    };
    let persistedMessages: PersistedMessage[] = [];
    let deferFirstFollowUpLoad = false;
    let resolveFirstFollowUpLoad: ((sessions: (typeof existingSession)[]) => void) | undefined;
    mocks.listHermesSessionMessages.mockImplementation(async () => persistedMessages);
    mocks.listHermesSessions.mockImplementation(() => {
      if (!deferFirstFollowUpLoad) return Promise.resolve([existingSession]);
      deferFirstFollowUpLoad = false;
      return new Promise<(typeof existingSession)[]>((resolve) => {
        resolveFirstFollowUpLoad = resolve;
      });
    });
    mocks.gatewayRequest.mockImplementation((method: string, params?: { text?: string }) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "prompt.submit" && params?.text?.includes("first queued message")) {
        deferFirstFollowUpLoad = true;
      }
      if (method === "session.active_list") {
        return Promise.resolve({ sessions: [] });
      }
      return Promise.resolve({});
    });

    vi.useFakeTimers();
    try {
      render(<AgentWorkspace initialSession={existingSession} />);
      await settleUnderFakeTimers(() =>
        expect(screen.getByRole("textbox", { name: "Message June" })).toBeInTheDocument(),
      );
      const composer = screen.getByRole("textbox", { name: "Message June" });
      fireEvent.paste(composer, {
        clipboardData: { getData: () => "start the audit" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await settleUnderFakeTimers(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text: "start the audit",
        }),
      );

      for (const [path, message] of [
        ["/Users/alex/Desktop/first.pdf", "first queued message"],
        ["/Users/alex/Desktop/second.pdf", "second queued message"],
      ] as const) {
        mocks.eventHandlers.get("tauri://drag-drop")?.({ payload: { paths: [path] } });
        await settleUnderFakeTimers(() =>
          expect(screen.getByText(path.split("/").at(-1) ?? path)).toBeInTheDocument(),
        );
        fireEvent.paste(composer, {
          clipboardData: { getData: () => message },
        });
        fireEvent.click(screen.getByRole("button", { name: "Queue next message" }));
        await settleUnderFakeTimers(() => expect(screen.getByText(message)).toBeInTheDocument());
      }

      persistedMessages = [
        {
          id: "initial-run-user",
          role: "user",
          content: "start the audit",
          timestamp: new Date().toISOString(),
        },
        {
          id: "initial-run-assistant",
          role: "assistant",
          content: "The initial run is complete.",
          timestamp: new Date().toISOString(),
        },
      ];

      act(() => {
        for (const handler of [...mocks.gatewayEventHandlers]) {
          handler({
            type: "lifecycle.complete",
            session_id: "runtime-session-1",
            event_id: "initial-run-terminal",
            payload: { status: "success" },
          });
        }
      });
      await settleUnderFakeTimers(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text: expect.stringContaining("first queued message"),
        }),
      );
      expect(resolveFirstFollowUpLoad).toBeTypeOf("function");
      const firstFollowUpText = mocks.gatewayRequest.mock.calls.find(
        ([method, params]) =>
          method === "prompt.submit" && params?.text?.includes("first queued message"),
      )?.[1]?.text;
      expect(firstFollowUpText).toEqual(expect.any(String));
      persistedMessages = [
        ...persistedMessages,
        {
          id: "first-follow-up-user",
          role: "user",
          content: "first queued message",
          timestamp: new Date().toISOString(),
        },
        {
          id: "first-follow-up-assistant",
          role: "assistant",
          content: "The first queued message is complete.",
          timestamp: new Date().toISOString(),
        },
      ];
      mocks.markAgentRunSucceeded.mockClear();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      expect(
        mocks.gatewayRequest.mock.calls.filter(([method]) => method === "session.active_list"),
      ).toHaveLength(2);
      await settleUnderFakeTimers(() =>
        expect(mocks.markAgentRunSucceeded).toHaveBeenCalledWith("session-1", 1),
      );
      expect(
        mocks.gatewayRequest.mock.calls.some(
          ([method, params]) =>
            method === "prompt.submit" && params?.text?.includes("second queued message"),
        ),
      ).toBe(false);

      await act(async () => {
        resolveFirstFollowUpLoad?.([existingSession]);
        await vi.advanceTimersByTimeAsync(0);
      });

      await settleUnderFakeTimers(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text: expect.stringContaining("second queued message"),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a real pre-ack terminal behind a stale replay candidate", async () => {
    let promptSubmitCount = 0;
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "prompt.submit") {
        promptSubmitCount += 1;
        if (promptSubmitCount === 2) {
          for (const handler of [...mocks.gatewayEventHandlers]) {
            handler({
              type: "lifecycle.complete",
              session_id: "runtime-session-1",
              event_id: "old-pre-ack-terminal",
              payload: { status: "success" },
            });
            handler({
              type: "lifecycle.complete",
              session_id: "runtime-session-1",
              event_id: "current-pre-ack-terminal",
              payload: { status: "success" },
            });
          }
        }
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={existingSession} />);
    const composer = await screen.findByRole("textbox", { name: "Message June" });

    await user.type(composer, "finish the first run");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(promptSubmitCount).toBe(1));
    act(() => {
      for (const handler of [...mocks.gatewayEventHandlers]) {
        handler({
          type: "lifecycle.complete",
          session_id: "runtime-session-1",
          event_id: "old-pre-ack-terminal",
          payload: { status: "success" },
        });
      }
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
    );
    mocks.markAgentRunSucceeded.mockClear();

    await user.type(composer, "finish the second run immediately");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(promptSubmitCount).toBe(2));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
    );
    // The unique current terminal settles while prompt.submit is still awaiting
    // its acknowledgement, so no app-lifetime monitor is started or marked.
    expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
  });

  it("keeps the direct Agent prompt gateway open through a pre-ACK remount", async () => {
    let resolvePrompt: (() => void) | undefined;
    const heldPrompt = new Promise<void>((resolve) => {
      resolvePrompt = resolve;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "prompt.submit") return heldPrompt;
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    const first = render(<AgentWorkspace initialSession={existingSession} />);
    const composer = await screen.findByRole("textbox", { name: "Message June" });
    await user.type(composer, "Hold this prompt until the gateway acknowledges it");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(resolvePrompt).toBeTypeOf("function"));
    const firstGateway = mocks.gatewayInstances[0];
    expect(firstGateway).toBeDefined();

    first.unmount();
    render(<AgentWorkspace initialSession={existingSession} />);
    await screen.findByRole("textbox", { name: "Message June" });

    expect(firstGateway?.close).not.toHaveBeenCalled();
    let laterDispatchStarted = false;
    const laterDispatch = reserveHermesSessionDispatch("session-1").run(async () => {
      laterDispatchStarted = true;
    });
    await act(async () => Promise.resolve());
    expect(laterDispatchStarted).toBe(false);

    await act(async () => resolvePrompt?.());
    await laterDispatch;
    expect(laterDispatchStarted).toBe(true);
    await waitFor(() => expect(firstGateway?.close).toHaveBeenCalledTimes(1));
  });

  it("keeps a pre-prompt session dispatch alive through a Workspace remount", async () => {
    let resolveResume: ((value: { session_id: string }) => void) | undefined;
    const heldResume = new Promise<{ session_id: string }>((resolve) => {
      resolveResume = resolve;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") return heldResume;
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    const first = render(<AgentWorkspace initialSession={existingSession} />);
    const composer = await screen.findByRole("textbox", { name: "Message June" });
    await user.type(composer, "Keep this accepted Send alive during resume");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(resolveResume).toBeTypeOf("function"));
    const firstGateway = mocks.gatewayInstances[0];
    expect(firstGateway).toBeDefined();

    first.unmount();
    render(<AgentWorkspace initialSession={existingSession} />);
    await screen.findByRole("textbox", { name: "Message June" });

    expect(firstGateway?.close).not.toHaveBeenCalled();
    let laterDispatchStarted = false;
    const laterDispatch = reserveHermesSessionDispatch("session-1").run(async () => {
      laterDispatchStarted = true;
    });
    await act(async () => Promise.resolve());
    expect(laterDispatchStarted).toBe(false);

    await act(async () => resolveResume?.({ session_id: "runtime-session-1" }));
    await laterDispatch;
    expect(laterDispatchStarted).toBe(true);
    expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
      session_id: "runtime-session-1",
      text: "Keep this accepted Send alive during resume",
    });
    await waitFor(() => expect(firstGateway?.close).toHaveBeenCalledTimes(1));
  });

  it("preserves a failed message completion without treating it as the Agent-run terminal", async () => {
    const statusDetails: AgentSessionStatusDetail[] = [];
    const handleStatus = (event: Event) => {
      statusDetails.push((event as CustomEvent<AgentSessionStatusDetail>).detail);
    };
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);

    try {
      const user = userEvent.setup();
      render(<AgentWorkspace initialSession={existingSession} />);
      const composer = await screen.findByRole("textbox", { name: "Message June" });

      await user.type(composer, "search the notes then summarize");
      await user.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() => expect(mocks.startAgentRunMonitoring).toHaveBeenCalledOnce());
      const monitorInput = mocks.startAgentRunMonitoring.mock.calls[0]?.[0];
      const dispatchedAtMs = monitorInput?.acceptedPrompt?.dispatchedAtMs;
      expect(dispatchedAtMs).toEqual(expect.any(Number));
      mocks.preserveAgentRunTerminalEvidence.mockClear();
      mocks.markAgentRunSucceeded.mockClear();
      mocks.cancelAgentRunMonitoring.mockClear();

      act(() => {
        for (const handler of [...mocks.gatewayEventHandlers]) {
          handler({
            type: "message.complete",
            session_id: "runtime-session-1",
            payload: {
              status: "error",
              text: "Context length exceeded after the final tool result.",
            },
          });
        }
      });

      expect(mocks.preserveAgentRunTerminalEvidence).toHaveBeenCalledWith(
        "session-1",
        expect.objectContaining({
          status: "failed",
          notBeforeMs: dispatchedAtMs,
        }),
        1,
      );
      expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
      expect(mocks.cancelAgentRunMonitoring).not.toHaveBeenCalled();
      expect(
        statusDetails.some((detail) => detail.status === "completed" || detail.status === "failed"),
      ).toBe(false);
      expect(screen.getByRole("button", { name: "Stop June" })).toBeInTheDocument();
    } finally {
      window.removeEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
    }
  });

  it("requires current authority for a non-consecutive no-id terminal replay", async () => {
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
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
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={existingSession} />);
    const composer = await screen.findByRole("textbox", { name: "Message June" });
    const submit = async (text: string) => {
      await user.type(composer, text);
      await user.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text,
        }),
      );
    };
    const firstSuccess = {
      type: "lifecycle.complete",
      session_id: "runtime-session-1",
      payload: { status: "success" },
    };

    await submit("finish run one");
    act(() => {
      for (const handler of [...mocks.gatewayEventHandlers]) handler(firstSuccess);
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
    );

    await submit("fail run two");
    act(() => {
      for (const handler of [...mocks.gatewayEventHandlers]) {
        handler({
          type: "lifecycle.complete",
          session_id: "runtime-session-1",
          payload: { status: "timeout" },
        });
      }
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
    );

    await submit("keep run three working");
    mocks.listHermesSessionMessages.mockClear();
    mocks.listHermesSessionMessages.mockResolvedValue([
      { id: "run-three-user", role: "user", content: "keep run three working" },
      { id: "run-three-assistant", role: "assistant", content: "Still working." },
    ]);
    mocks.markAgentRunSucceeded.mockClear();

    act(() => {
      for (const handler of [...mocks.gatewayEventHandlers]) handler(firstSuccess);
    });

    await waitFor(() => expect(mocks.listHermesSessionMessages).toHaveBeenCalled());
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.active_list", {}),
    );
    expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Stop June" })).toBeInTheDocument();
  });

  it.each([
    { terminalStatus: "timeout", expectedStatus: "failed" as const },
    { terminalStatus: "cancelled", expectedStatus: "cancelled" as const },
  ])("keeps a repeated no-id $terminalStatus terminal pending until monitor resolution", async ({
    terminalStatus,
    expectedStatus,
  }) => {
    const statusDetails: AgentSessionStatusDetail[] = [];
    const handleStatus = (event: Event) => {
      statusDetails.push((event as CustomEvent<AgentSessionStatusDetail>).detail);
    };
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
    let persistedMessages: Array<{
      id: string;
      role: "user";
      content: string;
      timestamp: string;
    }> = [];
    mocks.listHermesSessionMessages.mockImplementation(async () => persistedMessages);
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "session.active_list") {
        return Promise.resolve({
          sessions: [
            {
              id: "runtime-session-1",
              session_key: "session-1",
              status: "idle",
            },
          ],
        });
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={existingSession} />);
    const composer = await screen.findByRole("textbox", { name: "Message June" });
    const terminal = {
      type: "lifecycle.complete",
      session_id: "runtime-session-1",
      payload: { status: terminalStatus },
    };

    await user.type(composer, "repeat the failing action");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "repeat the failing action",
      }),
    );
    persistedMessages = [
      {
        id: "first-failed-user",
        role: "user",
        content: "repeat the failing action",
        timestamp: new Date().toISOString(),
      },
    ];
    const refreshesBeforeFirstTerminal = mocks.listHermesSessionMessages.mock.calls.length;
    act(() => {
      for (const handler of [...mocks.gatewayEventHandlers]) handler(terminal);
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(mocks.listHermesSessionMessages.mock.calls.length).toBeGreaterThan(
        refreshesBeforeFirstTerminal,
      ),
    );

    await user.type(composer, "repeat the failing action");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(
        mocks.gatewayRequest.mock.calls.filter(([method]) => method === "prompt.submit"),
      ).toHaveLength(2),
    );
    persistedMessages = [
      ...persistedMessages,
      {
        id: "second-failed-user",
        role: "user",
        content: "repeat the failing action",
        timestamp: new Date().toISOString(),
      },
    ];
    mocks.preserveAgentRunTerminalEvidence.mockClear();

    act(() => {
      for (const handler of [...mocks.gatewayEventHandlers]) handler(terminal);
    });

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.active_list", {}),
    );
    await waitFor(() =>
      expect(mocks.preserveAgentRunTerminalEvidence).toHaveBeenCalledWith(
        "session-1",
        expect.objectContaining({ status: expectedStatus }),
        1,
      ),
    );
    expect(
      statusDetails.filter(
        (detail) => detail.sessionId === "session-1" && detail.status === expectedStatus,
      ),
    ).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Stop June" })).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new CustomEvent<AgentSessionStatusDetail>(AGENT_SESSION_STATUS_EVENT, {
          detail: {
            sessionId: "session-1",
            runMonitorGeneration: 1,
            status: expectedStatus,
            summary: expectedStatus === "cancelled" ? "Stopped." : "June hit a problem.",
          },
        }),
      );
    });
    await waitFor(() =>
      expect(
        statusDetails.filter(
          (detail) => detail.sessionId === "session-1" && detail.status === expectedStatus,
        ),
      ).toHaveLength(2),
    );
    expect(screen.queryByRole("button", { name: "Stop June" })).toBeNull();
    window.removeEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
  });

  it.each([
    "timeout",
    "cancelled",
  ])("does not let a repeated no-id %s terminal fail a later persisted reply", async (terminalStatus) => {
    type PersistedMessage = {
      id: string;
      role: "user" | "assistant";
      content: string;
      timestamp: string;
    };
    let persistedMessages: PersistedMessage[] = [];
    const statusDetails: AgentSessionStatusDetail[] = [];
    const handleStatus = (event: Event) => {
      statusDetails.push((event as CustomEvent<AgentSessionStatusDetail>).detail);
    };
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
    mocks.listHermesSessionMessages.mockImplementation(async () => persistedMessages);
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "session.active_list") {
        return Promise.resolve({
          sessions: [
            {
              id: "runtime-session-1",
              session_key: "session-1",
              status: "idle",
            },
          ],
        });
      }
      return Promise.resolve({});
    });
    const terminal = {
      type: "lifecycle.complete",
      session_id: "runtime-session-1",
      payload: { status: terminalStatus },
    };

    try {
      const user = userEvent.setup();
      render(<AgentWorkspace initialSession={existingSession} />);
      const composer = await screen.findByRole("textbox", { name: "Message June" });

      await user.type(composer, "seed the repeated failure");
      await user.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text: "seed the repeated failure",
        }),
      );
      persistedMessages = [
        {
          id: "seed-failure-user",
          role: "user",
          content: "seed the repeated failure",
          timestamp: new Date().toISOString(),
        },
      ];
      const refreshesBeforeSeedTerminal = mocks.listHermesSessionMessages.mock.calls.length;
      act(() => {
        for (const handler of [...mocks.gatewayEventHandlers]) handler(terminal);
      });
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
      );
      await waitFor(() =>
        expect(mocks.listHermesSessionMessages.mock.calls.length).toBeGreaterThan(
          refreshesBeforeSeedTerminal,
        ),
      );

      await user.type(composer, "complete the later run");
      await user.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text: "complete the later run",
        }),
      );
      persistedMessages = [
        ...persistedMessages,
        {
          id: "later-run-user",
          role: "user",
          content: "complete the later run",
          timestamp: new Date().toISOString(),
        },
        {
          id: "later-run-assistant",
          role: "assistant",
          content: "The later run completed successfully.",
          timestamp: new Date().toISOString(),
        },
      ];
      await user.type(composer, "retain this submitted steer");
      await user.click(screen.getByRole("button", { name: "Send to steer June" }));
      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.steer", {
          session_id: "session-1",
          text: "retain this submitted steer",
        }),
      );
      expect(screen.getByText("retain this submitted steer")).toBeInTheDocument();
      const terminalStatusesBeforeReplay = statusDetails.filter(
        (detail) =>
          detail.sessionId === "session-1" &&
          (detail.status === "failed" || detail.status === "cancelled"),
      ).length;
      mocks.cancelAgentRunMonitoring.mockClear();
      mocks.preserveAgentRunTerminalEvidence.mockClear();

      act(() => {
        for (const handler of [...mocks.gatewayEventHandlers]) handler(terminal);
      });
      expect(mocks.preserveAgentRunTerminalEvidence).toHaveBeenCalledWith(
        "session-1",
        expect.objectContaining({
          status: terminalStatus === "cancelled" ? "cancelled" : "failed",
          summary: expect.any(String),
          notBeforeMs: expect.any(Number),
        }),
        1,
      );
      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.active_list", {}),
      );
      await waitFor(() =>
        expect(mocks.preserveAgentRunTerminalEvidence).toHaveBeenCalledWith(
          "session-1",
          expect.objectContaining({
            status: terminalStatus === "cancelled" ? "cancelled" : "failed",
            summary: expect.any(String),
            notBeforeMs: expect.any(Number),
          }),
          1,
        ),
      );
      await act(async () => Promise.resolve());

      expect(
        statusDetails.filter(
          (detail) =>
            detail.sessionId === "session-1" &&
            (detail.status === "failed" || detail.status === "cancelled"),
        ),
      ).toHaveLength(terminalStatusesBeforeReplay);
      expect(mocks.cancelAgentRunMonitoring).not.toHaveBeenCalledWith("session-1", 1);
      expect(screen.getByText("retain this submitted steer")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Stop June" })).toBeInTheDocument();
    } finally {
      window.removeEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
    }
  });

  it("does not let a repeated anonymous completion beat the current run's failure", async () => {
    type PersistedMessage = {
      id: string;
      role: "user" | "assistant";
      content: string;
      timestamp: string;
    };
    let persistedMessages: PersistedMessage[] = [];
    const statuses: AgentSessionStatusDetail[] = [];
    const onStatus = (event: Event) => {
      statuses.push((event as CustomEvent<AgentSessionStatusDetail>).detail);
    };
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, onStatus);
    mocks.listHermesSessionMessages.mockImplementation(async () => persistedMessages);
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "session.active_list") {
        return Promise.resolve({
          sessions: [
            {
              id: "runtime-session-1",
              session_key: "session-1",
              status: "idle",
            },
          ],
        });
      }
      return Promise.resolve({});
    });
    const repeatedCompletion = {
      type: "lifecycle.complete",
      session_id: "runtime-session-1",
      payload: { status: "success" },
    };

    try {
      const user = userEvent.setup();
      render(<AgentWorkspace initialSession={existingSession} />);
      const composer = await screen.findByRole("textbox", { name: "Message June" });

      await user.type(composer, "seed the anonymous completion");
      await user.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text: "seed the anonymous completion",
        }),
      );
      persistedMessages = [
        {
          id: "seed-user",
          role: "user",
          content: "seed the anonymous completion",
          timestamp: new Date().toISOString(),
        },
        {
          id: "seed-assistant",
          role: "assistant",
          content: "The seed run completed.",
          timestamp: new Date().toISOString(),
        },
      ];
      act(() => {
        for (const handler of [...mocks.gatewayEventHandlers]) handler(repeatedCompletion);
      });
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
      );

      await user.type(composer, "write partial prose then fail");
      await user.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text: "write partial prose then fail",
        }),
      );
      persistedMessages = [
        ...persistedMessages,
        {
          id: "current-user",
          role: "user",
          content: "write partial prose then fail",
          timestamp: new Date().toISOString(),
        },
        {
          id: "current-assistant",
          role: "assistant",
          content: "Partial prose from the failing run.",
          timestamp: new Date().toISOString(),
        },
      ];
      mocks.markAgentRunSucceeded.mockClear();
      mocks.cancelAgentRunMonitoring.mockClear();

      act(() => {
        for (const handler of [...mocks.gatewayEventHandlers]) handler(repeatedCompletion);
      });
      await waitFor(() =>
        expect(mocks.preserveAgentRunTerminalEvidence).toHaveBeenCalledWith(
          "session-1",
          expect.objectContaining({ status: "completed" }),
          1,
        ),
      );
      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.active_list", {}),
      );
      expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Stop June" })).toBeInTheDocument();

      act(() => {
        for (const handler of [...mocks.gatewayEventHandlers]) {
          handler({
            type: "lifecycle.complete",
            session_id: "runtime-session-1",
            event_id: "current-run-timeout",
            payload: { status: "timeout" },
          });
        }
      });
      await waitFor(() => expect(screen.queryByRole("button", { name: "Stop June" })).toBeNull());
      expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
      expect(mocks.cancelAgentRunMonitoring).toHaveBeenCalledWith("session-1", 1);
      expect(
        statuses.some((detail) => detail.sessionId === "session-1" && detail.status === "failed"),
      ).toBe(true);
      expect(await screen.findByText("Partial prose from the failing run.")).toBeInTheDocument();
    } finally {
      window.removeEventListener(AGENT_SESSION_STATUS_EVENT, onStatus);
    }
  });

  it("does not let idle reconciliation turn pending terminal ambiguity into success", async () => {
    type PersistedMessage = {
      id: string;
      role: "user" | "assistant";
      content: string;
      timestamp: string;
    };
    let persistedMessages: PersistedMessage[] = [];
    const statuses: AgentSessionStatusDetail[] = [];
    const onStatus = (event: Event) => {
      statuses.push((event as CustomEvent<AgentSessionStatusDetail>).detail);
    };
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, onStatus);
    let promptSubmitCount = 0;
    let resolveSecondPrompt: (() => void) | undefined;
    const heldSecondPrompt = new Promise<void>((resolve) => {
      resolveSecondPrompt = resolve;
    });
    mocks.listHermesSessionMessages.mockImplementation(async () => persistedMessages);
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "session.active_list") {
        return Promise.resolve({
          sessions: [
            {
              id: "runtime-session-1",
              session_key: "session-1",
              status: "idle",
            },
          ],
        });
      }
      if (method === "prompt.submit") {
        promptSubmitCount += 1;
        if (promptSubmitCount === 2) {
          for (const handler of [...mocks.gatewayEventHandlers]) handler(repeatedTimeout);
          return heldSecondPrompt;
        }
      }
      return Promise.resolve({});
    });
    const repeatedTimeout = {
      type: "lifecycle.complete",
      session_id: "runtime-session-1",
      payload: { status: "timeout" },
    };

    vi.useFakeTimers();
    try {
      const workspace = render(<AgentWorkspace initialSession={existingSession} />);
      await settleUnderFakeTimers(() =>
        expect(screen.getByRole("textbox", { name: "Message June" })).toBeInTheDocument(),
      );
      const composer = screen.getByRole("textbox", { name: "Message June" });

      fireEvent.paste(composer, { clipboardData: { getData: () => "seed timeout" } });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await settleUnderFakeTimers(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text: "seed timeout",
        }),
      );
      persistedMessages = [
        {
          id: "seed-user",
          role: "user",
          content: "seed timeout",
          timestamp: new Date().toISOString(),
        },
      ];
      act(() => {
        for (const handler of [...mocks.gatewayEventHandlers]) handler(repeatedTimeout);
      });
      await settleUnderFakeTimers(() =>
        expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
      );

      persistedMessages = [
        ...persistedMessages,
        {
          id: "current-user",
          role: "user",
          content: "write then fail",
          timestamp: new Date().toISOString(),
        },
        {
          id: "partial-assistant",
          role: "assistant",
          content: "Partial prose before timeout.",
          timestamp: new Date().toISOString(),
        },
      ];
      mocks.startAgentRunMonitoring.mockClear();
      mocks.preserveAgentRunTerminalEvidence.mockClear();
      mocks.markAgentRunSucceeded.mockClear();
      fireEvent.paste(composer, { clipboardData: { getData: () => "write then fail" } });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await settleUnderFakeTimers(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text: "write then fail",
        }),
      );
      expect(mocks.startAgentRunMonitoring).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });

      expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Stop June" })).toBeInTheDocument();

      workspace.unmount();
      render(<AgentWorkspace initialSession={existingSession} />);
      await settleUnderFakeTimers(() =>
        expect(screen.getByRole("button", { name: "Stop June" })).toBeInTheDocument(),
      );
      mocks.markAgentRunSucceeded.mockClear();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();

      await act(async () => {
        resolveSecondPrompt?.();
        await vi.advanceTimersByTimeAsync(0);
      });
      await settleUnderFakeTimers(() => expect(mocks.startAgentRunMonitoring).toHaveBeenCalled());
      expect(mocks.startAgentRunMonitoring).toHaveBeenCalledWith(
        expect.objectContaining({
          storedSessionId: "session-1",
          terminalEvidence: expect.objectContaining({ status: "failed" }),
        }),
      );
      mocks.hasPendingAgentRunTerminalEvidence.mockReturnValue(true);
      expect(mocks.preserveAgentRunTerminalEvidence).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });

      expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
      expect(
        statuses.some(
          (detail) => detail.sessionId === "session-1" && detail.status === "completed",
        ),
      ).toBe(false);
      expect(screen.getByRole("button", { name: "Stop June" })).toBeInTheDocument();

      mocks.hasPendingAgentRunTerminalEvidence.mockReturnValue(false);
      act(() => {
        window.dispatchEvent(
          new CustomEvent<AgentSessionStatusDetail>(AGENT_SESSION_STATUS_EVENT, {
            detail: {
              sessionId: "session-1",
              runMonitorGeneration: 1,
              status: "failed",
              summary: "The current run timed out.",
            },
          }),
        );
      });
      await settleUnderFakeTimers(() =>
        expect(screen.queryByRole("button", { name: "Stop June" })).toBeNull(),
      );
      expect(screen.getByText("Partial prose before timeout.")).toBeInTheDocument();
      expect(screen.getByText("The current run timed out.")).toBeInTheDocument();
    } finally {
      window.removeEventListener(AGENT_SESSION_STATUS_EVENT, onStatus);
      vi.useRealTimers();
    }
  });

  it("does not reconcile a unique terminal buffered before prompt acceptance as success", async () => {
    type PersistedMessage = {
      id: string;
      role: "user" | "assistant";
      content: string;
      timestamp: string;
    };
    let persistedMessages: PersistedMessage[] = [];
    let resolvePrompt: (() => void) | undefined;
    const heldPrompt = new Promise<void>((resolve) => {
      resolvePrompt = resolve;
    });
    mocks.listHermesSessionMessages.mockImplementation(async () => persistedMessages);
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "session.active_list") {
        return Promise.resolve({
          sessions: [
            {
              id: "runtime-session-1",
              session_key: "session-1",
              status: "idle",
            },
          ],
        });
      }
      if (method === "prompt.submit") {
        const timestamp = new Date().toISOString();
        persistedMessages = [
          {
            id: "current-user",
            role: "user",
            content: "write then fail uniquely",
            timestamp,
          },
          {
            id: "partial-assistant",
            role: "assistant",
            content: "Partial prose before the unique failure.",
            timestamp,
          },
        ];
        for (const handler of [...mocks.gatewayEventHandlers]) {
          handler({
            type: "lifecycle.complete",
            session_id: "runtime-session-1",
            event_id: "current-run-failure",
            payload: { status: "timeout" },
          });
        }
        return heldPrompt;
      }
      return Promise.resolve({});
    });

    vi.useFakeTimers();
    try {
      render(<AgentWorkspace initialSession={existingSession} />);
      await settleUnderFakeTimers(() =>
        expect(screen.getByRole("textbox", { name: "Message June" })).toBeInTheDocument(),
      );
      const composer = screen.getByRole("textbox", { name: "Message June" });
      fireEvent.paste(composer, {
        clipboardData: { getData: () => "write then fail uniquely" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await settleUnderFakeTimers(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text: "write then fail uniquely",
        }),
      );
      expect(mocks.startAgentRunMonitoring).not.toHaveBeenCalled();
      mocks.markAgentRunSucceeded.mockClear();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });

      expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Stop June" })).toBeInTheDocument();

      await act(async () => {
        resolvePrompt?.();
        await vi.advanceTimersByTimeAsync(0);
      });
      await settleUnderFakeTimers(() =>
        expect(screen.queryByRole("button", { name: "Stop June" })).toBeNull(),
      );
      expect(mocks.startAgentRunMonitoring).not.toHaveBeenCalled();
      expect(screen.getByText("Partial prose before the unique failure.")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores the prior monitor settling while the next prompt awaits acceptance", async () => {
    let promptSubmitCount = 0;
    let resolveSecondPrompt: (() => void) | undefined;
    const heldSecondPrompt = new Promise<void>((resolve) => {
      resolveSecondPrompt = resolve;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "prompt.submit") {
        promptSubmitCount += 1;
        return promptSubmitCount === 2 ? heldSecondPrompt : Promise.resolve({});
      }
      return Promise.resolve({});
    });

    vi.useFakeTimers();
    try {
      render(<AgentWorkspace initialSession={existingSession} />);
      await settleUnderFakeTimers(() =>
        expect(screen.getByRole("textbox", { name: "Message June" })).toBeInTheDocument(),
      );
      const composer = screen.getByRole("textbox", { name: "Message June" });

      fireEvent.paste(composer, { clipboardData: { getData: () => "accepted run A" } });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await settleUnderFakeTimers(() =>
        expect(mocks.startAgentRunMonitoring).toHaveBeenCalledTimes(1),
      );

      act(() => {
        hermesActivityStore.record(
          {
            kind: "lifecycle",
            sessionId: "session-1",
            flavor: "terminal",
            status: "completed",
            text: "",
            receivedAt: new Date().toISOString(),
          },
          "sandboxed",
        );
      });
      await settleUnderFakeTimers(() =>
        expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
      );

      fireEvent.paste(composer, {
        clipboardData: { getData: () => "pending run B must survive" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await settleUnderFakeTimers(() => expect(promptSubmitCount).toBe(2));
      expect(screen.getByRole("button", { name: "Stop June" })).toBeInTheDocument();

      act(() => {
        window.dispatchEvent(
          new CustomEvent<AgentSessionStatusDetail>(AGENT_SESSION_STATUS_EVENT, {
            detail: {
              sessionId: "session-1",
              runMonitorGeneration: 1,
              status: "failed",
              summary: "Run A failed late.",
            },
          }),
        );
        window.dispatchEvent(
          new CustomEvent(AGENT_RUN_SETTLED_EVENT, {
            detail: {
              sessionId: "session-1",
              title: "Existing session",
              runMonitorGeneration: 1,
              summary: "Run A settled late.",
            },
          }),
        );
      });

      expect(screen.getByRole("button", { name: "Stop June" })).toBeInTheDocument();
      expect(mocks.startAgentRunMonitoring).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveSecondPrompt?.();
        await vi.advanceTimersByTimeAsync(0);
      });
      await settleUnderFakeTimers(() =>
        expect(mocks.startAgentRunMonitoring).toHaveBeenCalledTimes(2),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("consumes a monitor settlement emitted while the Workspace is unmounted", async () => {
    vi.useFakeTimers();
    try {
      const firstMount = render(<AgentWorkspace initialSession={existingSession} />);
      await settleUnderFakeTimers(() =>
        expect(screen.getByRole("textbox", { name: "Message June" })).toBeInTheDocument(),
      );
      fireEvent.paste(screen.getByRole("textbox", { name: "Message June" }), {
        clipboardData: { getData: () => "finish while offscreen" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await settleUnderFakeTimers(() =>
        expect(mocks.startAgentRunMonitoring).toHaveBeenCalledTimes(1),
      );

      firstMount.unmount();
      act(() => {
        window.dispatchEvent(
          new CustomEvent(AGENT_RUN_SETTLED_EVENT, {
            detail: {
              sessionId: "session-1",
              title: "Existing session",
              runMonitorGeneration: 1,
              summary: "June finished.",
            },
          }),
        );
      });

      render(<AgentWorkspace initialSession={existingSession} />);
      await settleUnderFakeTimers(() =>
        expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
      );
      expect(screen.queryByRole("button", { name: "Stop June" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("consumes a monitor failure emitted while the Workspace is unmounted", async () => {
    vi.useFakeTimers();
    try {
      const firstMount = render(<AgentWorkspace initialSession={existingSession} />);
      await settleUnderFakeTimers(() =>
        expect(screen.getByRole("textbox", { name: "Message June" })).toBeInTheDocument(),
      );
      fireEvent.paste(screen.getByRole("textbox", { name: "Message June" }), {
        clipboardData: { getData: () => "fail while offscreen" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await settleUnderFakeTimers(() =>
        expect(mocks.startAgentRunMonitoring).toHaveBeenCalledTimes(1),
      );

      firstMount.unmount();
      act(() => {
        window.dispatchEvent(
          new CustomEvent<AgentSessionStatusDetail>(AGENT_SESSION_STATUS_EVENT, {
            detail: {
              sessionId: "session-1",
              runMonitorGeneration: 1,
              status: "failed",
              summary: "June stopped responding.",
            },
          }),
        );
      });
      expect(hermesActivityStore.getRecord("session-1")?.phase).toBe("error");

      render(<AgentWorkspace initialSession={existingSession} />);
      await settleUnderFakeTimers(() =>
        expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
      );
      expect(screen.queryByRole("button", { name: "Stop June" })).toBeNull();
      expect(screen.getByText("June stopped responding.")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a terminal generation tombstone across its queued start and stale failure", () => {
    act(() => {
      window.dispatchEvent(
        new CustomEvent<AgentSessionStatusDetail>(AGENT_SESSION_STATUS_EVENT, {
          detail: {
            sessionId: "session-1",
            runMonitorGeneration: 2,
            status: "cancelled",
            summary: "Stopped.",
          },
        }),
      );
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_STARTED_EVENT, {
          detail: {
            storedSessionId: "session-1",
            runMonitorGeneration: 2,
            runtimeSessionId: "runtime-session-2",
            fullMode: false,
          },
        }),
      );
      window.dispatchEvent(
        new CustomEvent<AgentSessionStatusDetail>(AGENT_SESSION_STATUS_EVENT, {
          detail: {
            sessionId: "session-1",
            runMonitorGeneration: 1,
            status: "failed",
            summary: "Stale failure.",
          },
        }),
      );
    });

    expect(hermesActivityStore.getRecord("session-1")?.phase).toBe("complete");
  });

  it("does not let a delayed local terminal settle a newer cross-surface run", async () => {
    const statusDetails: AgentSessionStatusDetail[] = [];
    const handleStatus = (event: Event) => {
      statusDetails.push((event as CustomEvent<AgentSessionStatusDetail>).detail);
    };
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={existingSession} />);
    const composer = await screen.findByRole("textbox", { name: "Message June" });
    await user.type(composer, "Run generation one.");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(mocks.startAgentRunMonitoring).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_STARTED_EVENT, {
          detail: {
            storedSessionId: "session-1",
            runMonitorGeneration: 2,
            runtimeSessionId: "runtime-note-chat",
            fullMode: false,
          },
        }),
      );
    });
    expect(screen.getByRole("button", { name: "Stop June" })).toBeInTheDocument();
    const completedBefore = statusDetails.filter((detail) => detail.status === "completed").length;
    mocks.markAgentRunSucceeded.mockClear();

    act(() => {
      for (const handler of [...mocks.gatewayEventHandlers]) {
        handler({
          type: "lifecycle.complete",
          session_id: "runtime-session-1",
          event_id: "late-generation-one-terminal",
          payload: { status: "success" },
        });
      }
    });

    expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
    expect(statusDetails.filter((detail) => detail.status === "completed")).toHaveLength(
      completedBefore,
    );
    expect(screen.getByRole("button", { name: "Stop June" })).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_SETTLED_EVENT, {
          detail: {
            sessionId: "session-1",
            runMonitorGeneration: 2,
            title: "Existing session",
            summary: "June finished.",
          },
        }),
      );
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
    );
    window.removeEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
  });

  it("cancels a direct Send prepared behind a newer external generation", async () => {
    let resolveSkill: (document: { name: string; relativePath: string; content: string }) => void =
      () => undefined;
    mocks.hermesBridgeSkills.mockResolvedValue([
      {
        name: "repo-build-pr",
        description: "Build a branch and open a PR",
        enabled: true,
      },
    ]);
    mocks.getHermesBridgeSkill.mockReturnValue(
      new Promise((resolve) => {
        resolveSkill = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={existingSession} />);
    const composer = await screen.findByRole("textbox", { name: "Message June" });
    await user.type(composer, "/repo-build-pr pending external start");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(mocks.getHermesBridgeSkill).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_STARTED_EVENT, {
          detail: {
            storedSessionId: "session-1",
            runMonitorGeneration: 4,
            runtimeSessionId: "runtime-note-chat",
            fullMode: false,
          },
        }),
      );
    });
    await act(async () => {
      resolveSkill({
        name: "repo-build-pr",
        relativePath: "repo-build-pr/SKILL.md",
        content: "# Repo build PR\n\nReview the request.",
      });
    });

    await waitFor(() => expect(composer).toHaveTextContent("pending external start"));
    expect(mocks.gatewayRequest.mock.calls.some(([method]) => method === "prompt.submit")).toBe(
      false,
    );
    expect(mocks.startAgentRunMonitoring).not.toHaveBeenCalled();
    expect(hermesActivityStore.getRecord("session-1")?.phase).toBe("running");
    expect(
      Array.from(document.querySelectorAll(".agent-user-turn")).some((turn) =>
        turn.textContent?.includes("pending external start"),
      ),
    ).toBe(false);
  });

  it.each([
    "resolve",
    "busy",
    "error",
  ] as const)("preserves a newer external generation when an older held Workspace prompt ends with %s", async (outcome) => {
    let resolvePrompt: (() => void) | undefined;
    let rejectPrompt: ((error: Error) => void) | undefined;
    const heldPrompt = new Promise<void>((resolve, reject) => {
      resolvePrompt = resolve;
      rejectPrompt = reject;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "prompt.submit") return heldPrompt;
      return Promise.resolve({});
    });
    const statuses: AgentSessionStatusDetail[] = [];
    const onStatus = (event: Event) => {
      statuses.push((event as CustomEvent<AgentSessionStatusDetail>).detail);
    };
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, onStatus);
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={existingSession} />);
    const composer = await screen.findByRole("textbox", { name: "Message June" });
    await user.type(composer, "Older held Workspace prompt");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "Older held Workspace prompt",
      }),
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_STARTED_EVENT, {
          detail: {
            storedSessionId: "session-1",
            runMonitorGeneration: 8,
            runtimeSessionId: "runtime-note-chat",
            fullMode: false,
          },
        }),
      );
    });
    await act(async () => {
      if (outcome === "resolve") resolvePrompt?.();
      else if (outcome === "busy") {
        rejectPrompt?.(new HermesGatewayError("session busy", 4009));
      } else {
        rejectPrompt?.(new Error("Older Workspace prompt failed."));
      }
      await heldPrompt.catch(() => undefined);
      await Promise.resolve();
    });

    await waitFor(() => expect(hermesActivityStore.getRecord("session-1")?.phase).toBe("running"));
    expect(mocks.startAgentRunMonitoring).not.toHaveBeenCalled();
    expect(
      statuses.some(
        (status) =>
          status.status === "failed" && status.summary === "Older Workspace prompt failed.",
      ),
    ).toBe(false);
    expect(screen.queryByText("Older Workspace prompt failed.")).toBeNull();
    window.removeEventListener(AGENT_SESSION_STATUS_EVENT, onStatus);
  });

  it("keeps a newer fast terminal ahead of its queued start while an older Workspace prompt awaits ACK", async () => {
    let promptSubmitCount = 0;
    let resolveSecondPrompt: (() => void) | undefined;
    const heldSecondPrompt = new Promise<void>((resolve) => {
      resolveSecondPrompt = resolve;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "prompt.submit") {
        promptSubmitCount += 1;
        return promptSubmitCount === 2 ? heldSecondPrompt : Promise.resolve({});
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={existingSession} />);
    const composer = await screen.findByRole("textbox", { name: "Message June" });
    await user.type(composer, "Establish generation one");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(mocks.startAgentRunMonitoring).toHaveBeenCalledTimes(1));
    act(() => {
      for (const handler of [...mocks.gatewayEventHandlers]) {
        handler({
          type: "lifecycle.complete",
          session_id: "runtime-session-1",
          event_id: "generation-one-complete",
          payload: { status: "success" },
        });
      }
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
    );

    await user.type(composer, "Older pre-ACK Workspace prompt");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(promptSubmitCount).toBe(2));
    act(() => {
      window.dispatchEvent(
        new CustomEvent<AgentSessionStatusDetail>(AGENT_SESSION_STATUS_EVENT, {
          detail: {
            sessionId: "session-1",
            runMonitorGeneration: 2,
            status: "failed",
            summary: "Newer Workspace run failed fast.",
          },
        }),
      );
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_STARTED_EVENT, {
          detail: {
            storedSessionId: "session-1",
            runMonitorGeneration: 2,
            runtimeSessionId: "runtime-note-chat",
            fullMode: false,
          },
        }),
      );
    });
    await act(async () => {
      resolveSecondPrompt?.();
      await heldSecondPrompt;
      await Promise.resolve();
    });

    await waitFor(() => expect(hermesActivityStore.getRecord("session-1")?.phase).toBe("error"));
    expect(mocks.startAgentRunMonitoring).toHaveBeenCalledTimes(1);
  });

  it("does not tag a rejected prompt with the previous run monitor generation", async () => {
    let promptSubmitCount = 0;
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "prompt.submit") {
        promptSubmitCount += 1;
        return promptSubmitCount === 2
          ? Promise.reject(new Error("The replacement prompt failed."))
          : Promise.resolve({});
      }
      return Promise.resolve({});
    });
    const statuses: AgentSessionStatusDetail[] = [];
    const onStatus = (event: Event) => {
      statuses.push((event as CustomEvent<AgentSessionStatusDetail>).detail);
    };
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, onStatus);
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={existingSession} />);
    const composer = await screen.findByRole("textbox", { name: "Message June" });
    await user.type(composer, "Establish the previous run");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(mocks.startAgentRunMonitoring).toHaveBeenCalledTimes(1));
    act(() => {
      for (const handler of [...mocks.gatewayEventHandlers]) {
        handler({
          type: "lifecycle.complete",
          session_id: "runtime-session-1",
          event_id: "previous-run-complete",
          payload: { status: "success" },
        });
      }
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
    );

    await user.type(composer, "Reject this replacement prompt");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(
        statuses.some(
          (status) =>
            status.status === "failed" && status.summary === "The replacement prompt failed.",
        ),
      ).toBe(true),
    );
    const rejection = statuses.find(
      (status) => status.status === "failed" && status.summary === "The replacement prompt failed.",
    );
    expect(rejection?.runMonitorGeneration).toBeUndefined();
    window.removeEventListener(AGENT_SESSION_STATUS_EVENT, onStatus);
  });

  it("captures an immutable persisted-user boundary after queued predecessors finish", async () => {
    let releasePredecessor: (() => void) | undefined;
    const predecessorGate = new Promise<void>((resolve) => {
      releasePredecessor = resolve;
    });
    const predecessor = reserveHermesSessionDispatch("session-1");
    const predecessorRun = predecessor.run(() => predecessorGate);
    const priorExchange = [
      { id: "prior-user", role: "user" as const, content: "repeat this" },
      { id: "prior-assistant", role: "assistant" as const, content: "Earlier answer" },
    ];
    let predecessorFinished = false;
    mocks.listHermesSessionMessages.mockImplementation(async () =>
      predecessorFinished ? priorExchange : [],
    );
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={existingSession} />);
    const composer = await screen.findByRole("textbox", { name: "Message June" });
    await user.type(composer, "repeat this");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await act(async () => {
      predecessorFinished = true;
      releasePredecessor?.();
      await predecessorRun;
    });
    await waitFor(() => expect(mocks.startAgentRunMonitoring).toHaveBeenCalledTimes(1));

    const monitorInput = mocks.startAgentRunMonitoring.mock.calls[0]?.[0];
    expect(monitorInput.acceptedPrompt.findPersistedUserIndex(priorExchange)).toBe(-1);
    expect(
      monitorInput.acceptedPrompt.findPersistedUserIndex([
        ...priorExchange,
        { id: "current-user", role: "user", content: "repeat this" },
      ]),
    ).toBe(2);
  });

  it("waits for its dispatch reservation before resuming a stored session", async () => {
    let releasePredecessor: (() => void) | undefined;
    const predecessorGate = new Promise<void>((resolve) => {
      releasePredecessor = resolve;
    });
    const predecessor = reserveHermesSessionDispatch("session-1");
    const predecessorRun = predecessor.run(() => predecessorGate);
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={existingSession} />);
    const composer = await screen.findByRole("textbox", { name: "Message June" });
    await user.type(composer, "Wait for the earlier surface");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(mocks.ensureHermesBridgeSession).toHaveBeenCalled());
    await act(async () => Promise.resolve());

    const resumeCallsBeforeRelease = mocks.gatewayRequest.mock.calls.filter(
      ([method]) => method === "session.resume",
    ).length;
    await act(async () => {
      releasePredecessor?.();
      await predecessorRun;
    });

    expect(resumeCallsBeforeRelease).toBe(0);
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "Wait for the earlier surface",
      }),
    );
  });

  it("does not resume a stored session after a queued Send is superseded", async () => {
    let releasePredecessor: (() => void) | undefined;
    const predecessorGate = new Promise<void>((resolve) => {
      releasePredecessor = resolve;
    });
    const predecessor = reserveHermesSessionDispatch("session-1");
    const predecessorRun = predecessor.run(() => predecessorGate);
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={existingSession} />);
    const composer = await screen.findByRole("textbox", { name: "Message June" });
    await user.type(composer, "Do not steal the newer Agent run");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(mocks.ensureHermesBridgeSession).toHaveBeenCalled());

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_STARTED_EVENT, {
          detail: {
            storedSessionId: "session-1",
            runMonitorGeneration: 4,
            runtimeSessionId: "runtime-note-chat",
            fullMode: false,
          },
        }),
      );
    });
    await act(async () => {
      releasePredecessor?.();
      await predecessorRun;
    });
    await waitFor(() => expect(composer).toHaveTextContent("Do not steal the newer Agent run"));

    expect(mocks.gatewayRequest.mock.calls.some(([method]) => method === "session.resume")).toBe(
      false,
    );
    expect(mocks.gatewayRequest.mock.calls.some(([method]) => method === "prompt.submit")).toBe(
      false,
    );
  });

  it("stops the latest cross-surface generation and refreshes again after interrupt", async () => {
    mocks.stopAgentRunMonitoring.mockImplementation(() => true);
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={existingSession} />);
    await screen.findByRole("textbox", { name: "Message June" });
    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_STARTED_EVENT, {
          detail: {
            storedSessionId: "session-1",
            runMonitorGeneration: 7,
            runtimeSessionId: "runtime-note-chat",
            fullMode: false,
          },
        }),
      );
    });
    const stop = await screen.findByRole("button", { name: "Stop June" });
    mocks.gatewayRequest.mockClear();
    mocks.listHermesSessionMessages.mockClear();

    await user.click(stop);

    expect(mocks.stopAgentRunMonitoring).toHaveBeenCalledWith("session-1", 7, expect.any(Function));
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("session.interrupt", expect.anything());
    await waitFor(() => expect(mocks.listHermesSessionMessages).toHaveBeenCalled());
    const refreshesBeforeInterruptCompletes = mocks.listHermesSessionMessages.mock.calls.length;
    const composer = screen.getByRole("textbox", { name: "Message June" });
    fireEvent.paste(composer, {
      clipboardData: { getData: () => "Run only after central Stop." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", expect.anything());
    const stopCalls = mocks.stopAgentRunMonitoring.mock.calls as unknown as Array<
      [string, number, () => void]
    >;
    const onStopped = stopCalls.at(-1)?.[2];
    act(() => onStopped?.());
    await waitFor(() =>
      expect(mocks.listHermesSessionMessages.mock.calls.length).toBeGreaterThan(
        refreshesBeforeInterruptCompletes,
      ),
    );
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "Run only after central Stop.",
      }),
    );
  });

  it("does not resurrect a buffered held prompt after remount and Stop", async () => {
    let resolvePrompt: (() => void) | undefined;
    const heldPrompt = new Promise<void>((resolve) => {
      resolvePrompt = resolve;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "prompt.submit") {
        for (const handler of [...mocks.gatewayEventHandlers]) {
          handler({
            type: "lifecycle.complete",
            session_id: "runtime-session-1",
            event_id: "held-run-timeout",
            payload: { status: "timeout" },
          });
        }
        return heldPrompt;
      }
      return Promise.resolve({});
    });

    vi.useFakeTimers();
    try {
      const firstMount = render(<AgentWorkspace initialSession={existingSession} />);
      await settleUnderFakeTimers(() =>
        expect(screen.getByRole("textbox", { name: "Message June" })).toBeInTheDocument(),
      );
      const composer = screen.getByRole("textbox", { name: "Message June" });
      fireEvent.paste(composer, { clipboardData: { getData: () => "held across remount" } });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await settleUnderFakeTimers(() =>
        expect(screen.getByRole("button", { name: "Stop June" })).toBeInTheDocument(),
      );

      firstMount.unmount();
      render(<AgentWorkspace initialSession={existingSession} />);
      await settleUnderFakeTimers(() =>
        expect(screen.getByRole("button", { name: "Stop June" })).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByRole("button", { name: "Stop June" }));
      await settleUnderFakeTimers(() =>
        expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
      );
      mocks.startAgentRunMonitoring.mockClear();

      await act(async () => {
        resolvePrompt?.();
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mocks.startAgentRunMonitoring).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not use old timestamp-less identical history as current success authority", async () => {
    let persistedMessages: Array<{
      id: string;
      role: "user" | "assistant";
      content: string;
    }> = [];
    mocks.listHermesSessionMessages.mockImplementation(async () => persistedMessages);
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "session.active_list") {
        return Promise.resolve({
          sessions: [
            {
              id: "runtime-session-1",
              session_key: "session-1",
              status: "idle",
            },
          ],
        });
      }
      return Promise.resolve({});
    });
    vi.useFakeTimers();
    try {
      render(<AgentWorkspace initialSession={existingSession} />);
      await settleUnderFakeTimers(() =>
        expect(screen.getByRole("textbox", { name: "Message June" })).toBeInTheDocument(),
      );
      const composer = screen.getByRole("textbox", { name: "Message June" });
      await settleUnderFakeTimers(() => expect(mocks.listHermesSessionMessages).toHaveBeenCalled());
      const noIdSuccess = {
        type: "lifecycle.complete",
        session_id: "runtime-session-1",
        payload: { status: "success" },
      };

      fireEvent.paste(composer, { clipboardData: { getData: () => "continue" } });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await settleUnderFakeTimers(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text: "continue",
        }),
      );
      persistedMessages = [
        { id: "old-identical-user", role: "user", content: "continue" },
        { id: "old-identical-assistant", role: "assistant", content: "Old answer." },
      ];
      act(() => {
        for (const handler of [...mocks.gatewayEventHandlers]) handler(noIdSuccess);
      });
      await settleUnderFakeTimers(() =>
        expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      await settleUnderFakeTimers(() =>
        expect(screen.getByText("Old answer.")).toBeInTheDocument(),
      );

      fireEvent.paste(composer, { clipboardData: { getData: () => "continue" } });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await settleUnderFakeTimers(() =>
        expect(
          mocks.gatewayRequest.mock.calls.filter(([method]) => method === "prompt.submit"),
        ).toHaveLength(2),
      );
      mocks.markAgentRunSucceeded.mockClear();
      const messageLoadsBeforeReplay = mocks.listHermesSessionMessages.mock.calls.length;
      const activeListCallsBeforeReplay = mocks.gatewayRequest.mock.calls.filter(
        ([method]) => method === "session.active_list",
      ).length;

      act(() => {
        for (const handler of [...mocks.gatewayEventHandlers]) handler(noIdSuccess);
      });

      await settleUnderFakeTimers(() =>
        expect(mocks.listHermesSessionMessages.mock.calls.length).toBeGreaterThan(
          messageLoadsBeforeReplay,
        ),
      );
      expect(
        mocks.gatewayRequest.mock.calls.filter(([method]) => method === "session.active_list"),
      ).toHaveLength(activeListCallsBeforeReplay);

      // The same generic persisted refresh is used after two authoritative
      // runtime misses. It must honor the run's persistence boundary too,
      // instead of treating the old identical exchange as the current reply.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });

      expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Stop June" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps conflicting repeated terminals behind monitor authority", async () => {
    type PersistedMessage = {
      id: string;
      role: "user" | "assistant";
      content: string;
      timestamp: string;
    };
    let persistedMessages: PersistedMessage[] = [];
    const statusDetails: AgentSessionStatusDetail[] = [];
    const handleStatus = (event: Event) => {
      statusDetails.push((event as CustomEvent<AgentSessionStatusDetail>).detail);
    };
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
    mocks.listHermesSessionMessages.mockImplementation(async () => persistedMessages);
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "session.active_list") {
        return Promise.resolve({
          sessions: [
            {
              id: "runtime-session-1",
              session_key: "session-1",
              status: "idle",
            },
          ],
        });
      }
      return Promise.resolve({});
    });
    const success = {
      type: "lifecycle.complete",
      session_id: "runtime-session-1",
      payload: { status: "success" },
    };
    const timeout = {
      type: "lifecycle.complete",
      session_id: "runtime-session-1",
      payload: { status: "timeout" },
    };

    try {
      const user = userEvent.setup();
      render(<AgentWorkspace initialSession={existingSession} />);
      const composer = await screen.findByRole("textbox", { name: "Message June" });
      const submit = async (text: string) => {
        await user.type(composer, text);
        await user.click(screen.getByRole("button", { name: "Send message" }));
        await waitFor(() =>
          expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
            session_id: "runtime-session-1",
            text,
          }),
        );
      };
      const emit = (terminal: typeof success) => {
        act(() => {
          for (const handler of [...mocks.gatewayEventHandlers]) handler(terminal);
        });
      };

      await submit("seed repeated success");
      persistedMessages = [
        {
          id: "seed-success-user",
          role: "user",
          content: "seed repeated success",
          timestamp: new Date().toISOString(),
        },
        {
          id: "seed-success-assistant",
          role: "assistant",
          content: "Seed success complete.",
          timestamp: new Date().toISOString(),
        },
      ];
      const refreshesBeforeSuccess = mocks.listHermesSessionMessages.mock.calls.length;
      emit(success);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
      );
      await waitFor(() =>
        expect(mocks.listHermesSessionMessages.mock.calls.length).toBeGreaterThan(
          refreshesBeforeSuccess,
        ),
      );

      await submit("seed repeated timeout");
      persistedMessages = [
        ...persistedMessages,
        {
          id: "seed-timeout-user",
          role: "user",
          content: "seed repeated timeout",
          timestamp: new Date().toISOString(),
        },
      ];
      const refreshesBeforeTimeout = mocks.listHermesSessionMessages.mock.calls.length;
      emit(timeout);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
      );
      await waitFor(() =>
        expect(mocks.listHermesSessionMessages.mock.calls.length).toBeGreaterThan(
          refreshesBeforeTimeout,
        ),
      );

      await submit("run the current action");
      persistedMessages = [
        ...persistedMessages,
        {
          id: "current-conflict-user",
          role: "user",
          content: "run the current action",
          timestamp: new Date().toISOString(),
        },
      ];
      mocks.markAgentRunSucceeded.mockClear();
      mocks.cancelAgentRunMonitoring.mockClear();
      mocks.preserveAgentRunTerminalEvidence.mockClear();
      const failedStatusesBefore = statusDetails.filter(
        (detail) => detail.sessionId === "session-1" && detail.status === "failed",
      ).length;

      act(() => {
        for (const handler of [...mocks.gatewayEventHandlers]) {
          handler(success);
          handler(timeout);
        }
      });

      await waitFor(() =>
        expect(mocks.preserveAgentRunTerminalEvidence).toHaveBeenCalledWith(
          "session-1",
          expect.objectContaining({ status: "failed" }),
          1,
        ),
      );
      expect(
        statusDetails.filter(
          (detail) => detail.sessionId === "session-1" && detail.status === "failed",
        ),
      ).toHaveLength(failedStatusesBefore);
      expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
      expect(mocks.cancelAgentRunMonitoring).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Stop June" })).toBeInTheDocument();

      act(() => {
        window.dispatchEvent(
          new CustomEvent<AgentSessionStatusDetail>(AGENT_SESSION_STATUS_EVENT, {
            detail: {
              sessionId: "session-1",
              runMonitorGeneration: 1,
              status: "failed",
              summary: "June hit a problem.",
            },
          }),
        );
      });
      await waitFor(() =>
        expect(
          statusDetails.filter(
            (detail) => detail.sessionId === "session-1" && detail.status === "failed",
          ),
        ).toHaveLength(failedStatusesBefore + 1),
      );
      expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
      expect(mocks.cancelAgentRunMonitoring).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Stop June" })).toBeNull();
    } finally {
      window.removeEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
    }
  });

  it("invalidates an old listener's ambiguous proof when recovery installs a newer listener", async () => {
    type PersistedMessage = {
      id: string;
      role: "user" | "assistant";
      content: string;
      timestamp: string;
    };
    type ActiveListResponse = {
      sessions: Array<{ id: string; session_key: string; status: string }>;
    };
    let persistedMessages: PersistedMessage[] = [];
    let resumeCalls = 0;
    let activeListCalls = 0;
    let resolveOldProof: ((response: ActiveListResponse) => void) | undefined;
    let resolveNewProof: ((response: ActiveListResponse) => void) | undefined;
    const oldProof = new Promise<ActiveListResponse>((resolve) => {
      resolveOldProof = resolve;
    });
    const newProof = new Promise<ActiveListResponse>((resolve) => {
      resolveNewProof = resolve;
    });
    const statusDetails: AgentSessionStatusDetail[] = [];
    const handleStatus = (event: Event) => {
      statusDetails.push((event as CustomEvent<AgentSessionStatusDetail>).detail);
    };
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
    mocks.listHermesSessionMessages.mockImplementation(async () => persistedMessages);
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        resumeCalls += 1;
        return Promise.resolve({
          session_id: resumeCalls === 1 ? "runtime-session-1" : "runtime-session-recovered",
        });
      }
      if (method === "session.active_list") {
        activeListCalls += 1;
        return activeListCalls === 1 ? oldProof : newProof;
      }
      return Promise.resolve({});
    });
    const success = {
      type: "lifecycle.complete",
      session_id: "runtime-session-1",
      payload: { status: "success" },
    };
    const timeout = {
      type: "lifecycle.complete",
      session_id: "runtime-session-1",
      payload: { status: "timeout" },
    };

    try {
      const user = userEvent.setup();
      render(<AgentWorkspace initialSession={existingSession} />);
      const composer = await screen.findByRole("textbox", { name: "Message June" });
      const submit = async (text: string) => {
        await user.type(composer, text);
        await user.click(screen.getByRole("button", { name: "Send message" }));
        await waitFor(() =>
          expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
            session_id: expect.any(String),
            text,
          }),
        );
      };
      const emit = (terminal: typeof success) => {
        act(() => {
          for (const handler of [...mocks.gatewayEventHandlers]) handler(terminal);
        });
      };

      await submit("seed listener success");
      persistedMessages = [
        {
          id: "listener-success-user",
          role: "user",
          content: "seed listener success",
          timestamp: new Date().toISOString(),
        },
        {
          id: "listener-success-assistant",
          role: "assistant",
          content: "Success seeded.",
          timestamp: new Date().toISOString(),
        },
      ];
      emit(success);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
      );

      await submit("seed listener timeout");
      persistedMessages = [
        ...persistedMessages,
        {
          id: "listener-timeout-user",
          role: "user",
          content: "seed listener timeout",
          timestamp: new Date().toISOString(),
        },
      ];
      emit(timeout);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
      );

      await submit("current listener run");
      persistedMessages = [
        ...persistedMessages,
        {
          id: "listener-current-user",
          role: "user",
          content: "current listener run",
          timestamp: new Date().toISOString(),
        },
        {
          id: "listener-current-assistant",
          role: "assistant",
          content: "Current response persisted.",
          timestamp: new Date().toISOString(),
        },
      ];
      mocks.markAgentRunSucceeded.mockClear();
      mocks.cancelAgentRunMonitoring.mockClear();
      const failedStatusesBefore = statusDetails.filter(
        (detail) => detail.sessionId === "session-1" && detail.status === "failed",
      ).length;

      emit(success);
      await waitFor(() => expect(activeListCalls).toBe(1));
      act(() => {
        for (const close of mocks.gatewayCloseHandlers) close();
      });
      await waitFor(() => expect(resumeCalls).toBe(2));
      expect(mocks.gatewayEventHandlers.size).toBe(1);
      act(() => {
        for (const handler of [...mocks.gatewayEventHandlers]) {
          handler({ ...timeout, session_id: "runtime-session-recovered" });
        }
      });
      await waitFor(() => expect(activeListCalls).toBe(2));

      await act(async () => {
        resolveOldProof?.({
          sessions: [
            {
              id: "runtime-session-1",
              session_key: "session-1",
              status: "idle",
            },
          ],
        });
        await Promise.resolve();
      });
      expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();

      await act(async () => {
        resolveNewProof?.({
          sessions: [
            {
              id: "runtime-session-recovered",
              session_key: "session-1",
              status: "idle",
            },
          ],
        });
        await Promise.resolve();
      });
      expect(
        statusDetails.filter(
          (detail) => detail.sessionId === "session-1" && detail.status === "failed",
        ),
      ).toHaveLength(failedStatusesBefore);
      expect(mocks.cancelAgentRunMonitoring).not.toHaveBeenCalledWith("session-1", 1);
      expect(screen.getByRole("button", { name: "Stop June" })).toBeInTheDocument();
    } finally {
      window.removeEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
    }
  });

  it("preserves repeated-success authority when recovery replaces the listener", async () => {
    type PersistedMessage = {
      id: string;
      role: "user" | "assistant";
      content: string;
      timestamp: string;
    };
    let persistedMessages: PersistedMessage[] = [];
    let resumeCalls = 0;
    mocks.listHermesSessionMessages.mockImplementation(async () => persistedMessages);
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        resumeCalls += 1;
        return Promise.resolve({
          session_id: resumeCalls === 1 ? "runtime-session-1" : "runtime-session-recovered",
        });
      }
      if (method === "session.active_list") {
        return Promise.resolve({
          sessions: [
            {
              id: "runtime-session-recovered",
              session_key: "session-1",
              status: "idle",
            },
          ],
        });
      }
      return Promise.resolve({});
    });
    const repeatedSuccess = {
      type: "lifecycle.complete",
      payload: { status: "success" },
    };
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={existingSession} />);
    const composer = await screen.findByRole("textbox", { name: "Message June" });

    await user.type(composer, "seed reconnect success");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "seed reconnect success",
      }),
    );
    persistedMessages = [
      {
        id: "reconnect-seed-user",
        role: "user",
        content: "seed reconnect success",
        timestamp: new Date().toISOString(),
      },
      {
        id: "reconnect-seed-assistant",
        role: "assistant",
        content: "Reconnect seed complete.",
        timestamp: new Date().toISOString(),
      },
    ];
    const refreshesBeforeSeed = mocks.listHermesSessionMessages.mock.calls.length;
    act(() => {
      for (const handler of [...mocks.gatewayEventHandlers]) {
        handler({ ...repeatedSuccess, session_id: "runtime-session-1" });
      }
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(mocks.listHermesSessionMessages.mock.calls.length).toBeGreaterThan(
        refreshesBeforeSeed,
      ),
    );

    await user.type(composer, "finish after reconnect");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "finish after reconnect",
      }),
    );
    persistedMessages = [
      ...persistedMessages,
      {
        id: "reconnect-current-user",
        role: "user",
        content: "finish after reconnect",
        timestamp: new Date().toISOString(),
      },
      {
        id: "reconnect-current-assistant",
        role: "assistant",
        content: "The recovered run is complete.",
        timestamp: new Date().toISOString(),
      },
    ];
    mocks.markAgentRunSucceeded.mockClear();

    act(() => {
      for (const close of mocks.gatewayCloseHandlers) close();
    });
    await waitFor(() => expect(resumeCalls).toBe(2));
    expect(mocks.gatewayEventHandlers.size).toBe(1);
    mocks.preserveAgentRunTerminalEvidence.mockClear();
    act(() => {
      for (const handler of [...mocks.gatewayEventHandlers]) {
        handler({ ...repeatedSuccess, session_id: "runtime-session-recovered" });
      }
    });

    await waitFor(() =>
      expect(mocks.preserveAgentRunTerminalEvidence).toHaveBeenCalledWith(
        "session-1",
        expect.objectContaining({ status: "completed" }),
        1,
      ),
    );
    expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Stop June" })).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_SETTLED_EVENT, {
          detail: {
            sessionId: "session-1",
            title: "Existing session",
            runMonitorGeneration: 1,
            summary: "June finished.",
          },
        }),
      );
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop June" })).toBeNull());
  });

  it.each([
    { terminalStatus: "timeout", expectedStatus: "failed" as const },
    { terminalStatus: "cancelled", expectedStatus: "cancelled" as const },
  ])("preserves repeated $terminalStatus authority when a remount replaces the listener", async ({
    terminalStatus,
    expectedStatus,
  }) => {
    type PersistedMessage = {
      id: string;
      role: "user";
      content: string;
      timestamp: string;
    };
    let persistedMessages: PersistedMessage[] = [];
    const statusDetails: AgentSessionStatusDetail[] = [];
    const handleStatus = (event: Event) => {
      statusDetails.push((event as CustomEvent<AgentSessionStatusDetail>).detail);
    };
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
    mocks.listHermesSessionMessages.mockImplementation(async () => persistedMessages);
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "session.active_list") {
        return Promise.resolve({
          sessions: [
            {
              id: "runtime-session-1",
              session_key: "session-1",
              status: "idle",
            },
          ],
        });
      }
      return Promise.resolve({});
    });
    const repeatedTerminal = {
      type: "lifecycle.complete",
      session_id: "runtime-session-1",
      payload: { status: terminalStatus },
    };

    try {
      const user = userEvent.setup();
      const first = render(<AgentWorkspace initialSession={existingSession} />);
      const composer = await screen.findByRole("textbox", { name: "Message June" });
      await user.type(composer, `seed remount ${terminalStatus}`);
      await user.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text: `seed remount ${terminalStatus}`,
        }),
      );
      persistedMessages = [
        {
          id: `remount-${terminalStatus}-seed-user`,
          role: "user",
          content: `seed remount ${terminalStatus}`,
          timestamp: new Date().toISOString(),
        },
      ];
      const refreshesBeforeSeed = mocks.listHermesSessionMessages.mock.calls.length;
      act(() => {
        for (const handler of [...mocks.gatewayEventHandlers]) handler(repeatedTerminal);
      });
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
      );
      await waitFor(() =>
        expect(mocks.listHermesSessionMessages.mock.calls.length).toBeGreaterThan(
          refreshesBeforeSeed,
        ),
      );

      await user.type(composer, `current remount ${terminalStatus}`);
      await user.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text: `current remount ${terminalStatus}`,
        }),
      );
      persistedMessages = [
        ...persistedMessages,
        {
          id: `remount-${terminalStatus}-current-user`,
          role: "user",
          content: `current remount ${terminalStatus}`,
          timestamp: new Date().toISOString(),
        },
      ];
      first.unmount();
      mocks.gatewayEventHandlers.clear();
      render(<AgentWorkspace initialSession={existingSession} />);
      await waitFor(() => expect(mocks.gatewayEventHandlers.size).toBe(1));
      await screen.findByRole("button", { name: "Stop June" });
      const matchingStatusesBefore = statusDetails.filter(
        (detail) => detail.sessionId === "session-1" && detail.status === expectedStatus,
      ).length;
      mocks.cancelAgentRunMonitoring.mockClear();
      mocks.preserveAgentRunTerminalEvidence.mockClear();

      act(() => {
        for (const handler of [...mocks.gatewayEventHandlers]) handler(repeatedTerminal);
      });

      await waitFor(() =>
        expect(mocks.preserveAgentRunTerminalEvidence).toHaveBeenCalledWith(
          "session-1",
          expect.objectContaining({ status: expectedStatus }),
          1,
        ),
      );
      expect(
        statusDetails.filter(
          (detail) => detail.sessionId === "session-1" && detail.status === expectedStatus,
        ),
      ).toHaveLength(matchingStatusesBefore);
      expect(screen.getByRole("button", { name: "Stop June" })).toBeInTheDocument();
      expect(mocks.cancelAgentRunMonitoring).not.toHaveBeenCalled();

      act(() => {
        window.dispatchEvent(
          new CustomEvent<AgentSessionStatusDetail>(AGENT_SESSION_STATUS_EVENT, {
            detail: {
              sessionId: "session-1",
              runMonitorGeneration: 1,
              status: expectedStatus,
              summary: expectedStatus === "cancelled" ? "Stopped." : "June hit a problem.",
            },
          }),
        );
      });
      await waitFor(() =>
        expect(
          statusDetails.filter(
            (detail) => detail.sessionId === "session-1" && detail.status === expectedStatus,
          ),
        ).toHaveLength(matchingStatusesBefore + 1),
      );
      expect(screen.queryByRole("button", { name: "Stop June" })).toBeNull();
    } finally {
      window.removeEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
    }
  });

  it.each([
    { replayKind: "no-id fingerprint", eventId: undefined },
    { replayKind: "delivery-id", eventId: "compacted-terminal-delivery" },
  ])("preserves $replayKind terminal replay history across a settled remount", async ({
    eventId,
  }) => {
    type PersistedMessage = {
      id: string;
      role: "user" | "assistant";
      content: string;
      timestamp: string;
    };
    let persistedMessages: PersistedMessage[] = [];
    mocks.listHermesSessionMessages.mockImplementation(async () => persistedMessages);
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
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
    const repeatedSuccess = {
      type: "lifecycle.complete",
      session_id: "runtime-session-1",
      ...(eventId ? { event_id: eventId } : {}),
      payload: { status: "success" },
    };
    const user = userEvent.setup();
    const first = render(<AgentWorkspace initialSession={existingSession} />);
    const composer = await screen.findByRole("textbox", { name: "Message June" });

    await user.type(composer, "seed compacted replay history");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "seed compacted replay history",
      }),
    );
    persistedMessages = [
      {
        id: "compacted-replay-user",
        role: "user",
        content: "seed compacted replay history",
        timestamp: new Date().toISOString(),
      },
      {
        id: "compacted-replay-assistant",
        role: "assistant",
        content: "Persisted result.",
        timestamp: new Date().toISOString(),
      },
    ];
    const refreshesBeforeTerminal = mocks.listHermesSessionMessages.mock.calls.length;
    act(() => {
      for (const handler of [...mocks.gatewayEventHandlers]) {
        handler({
          type: "message.start",
          session_id: "runtime-session-1",
          payload: { message_id: "compacted-replay-assistant" },
        });
        handler({
          type: "message.delta",
          session_id: "runtime-session-1",
          payload: {
            message_id: "compacted-replay-assistant",
            delta: "Persisted result.",
          },
        });
        handler({
          type: "message.complete",
          session_id: "runtime-session-1",
          payload: {
            message_id: "compacted-replay-assistant",
            text: "Persisted result.",
          },
        });
        handler(repeatedSuccess);
      }
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(mocks.listHermesSessionMessages.mock.calls.length).toBeGreaterThan(
        refreshesBeforeTerminal,
      ),
    );

    first.unmount();
    mocks.gatewayEventHandlers.clear();
    render(<AgentWorkspace initialSession={existingSession} />);
    const remountedComposer = await screen.findByRole("textbox", { name: "Message June" });
    await user.type(remountedComposer, "keep the remounted run working");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "keep the remounted run working",
      }),
    );
    mocks.markAgentRunSucceeded.mockClear();

    act(() => {
      for (const handler of [...mocks.gatewayEventHandlers]) handler(repeatedSuccess);
    });
    await act(async () => Promise.resolve());

    expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Stop June" })).toBeInTheDocument();
  });

  it("preserves a structured-only tool response across a lagging-persistence remount", async () => {
    type PersistedMessage = {
      id: string;
      role: "user";
      content: string;
      timestamp: string;
    };
    let persistedMessages: PersistedMessage[] = [];
    mocks.listHermesSessionMessages.mockImplementation(async () => persistedMessages);

    const user = userEvent.setup();
    const first = render(<AgentWorkspace initialSession={existingSession} />);
    const composer = await screen.findByRole("textbox", { name: "Message June" });

    await user.type(composer, "inspect the workspace");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "inspect the workspace",
      }),
    );
    persistedMessages = [
      {
        id: "structured-only-user",
        role: "user",
        content: "inspect the workspace",
        timestamp: new Date().toISOString(),
      },
    ];
    const refreshesBeforeTerminal = mocks.listHermesSessionMessages.mock.calls.length;

    act(() => {
      for (const handler of [...mocks.gatewayEventHandlers]) {
        handler({
          type: "tool.start",
          event_id: "structured-only-tool-start",
          session_id: "runtime-session-1",
          payload: {
            tool_id: "structured-only-tool",
            tool_name: "read_file",
            path: "src/components/agent/AgentWorkspace.tsx",
          },
        });
        handler({
          type: "tool.complete",
          event_id: "structured-only-tool-complete",
          session_id: "runtime-session-1",
          payload: {
            tool_id: "structured-only-tool",
            tool_name: "read_file",
            path: "src/components/agent/AgentWorkspace.tsx",
          },
        });
        handler({
          type: "lifecycle.complete",
          event_id: "structured-only-terminal",
          session_id: "runtime-session-1",
          payload: { status: "success" },
        });
      }
    });

    await waitFor(() => expect(document.querySelectorAll(".agent-tool-stack")).toHaveLength(1));
    expect(document.querySelector(".agent-tool-stack")).toHaveTextContent(/files/i);
    await waitFor(() =>
      expect(mocks.listHermesSessionMessages.mock.calls.length).toBeGreaterThan(
        refreshesBeforeTerminal,
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
    );

    first.unmount();
    mocks.gatewayEventHandlers.clear();
    render(<AgentWorkspace initialSession={existingSession} />);
    await screen.findByRole("textbox", { name: "Message June" });

    await waitFor(() => expect(document.querySelectorAll(".agent-tool-stack")).toHaveLength(1));
    expect(document.querySelector(".agent-tool-stack")).toHaveTextContent(/files/i);
  });

  it("ignores every event from a retired listener after a newer Agent run starts", async () => {
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={existingSession} />);
    const composer = await screen.findByRole("textbox", { name: "Message June" });

    await user.type(composer, "finish the old run");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "finish the old run",
      }),
    );
    const retiredHandler = [...mocks.gatewayEventHandlers][0];
    expect(retiredHandler).toBeDefined();
    act(() => {
      retiredHandler?.({
        type: "lifecycle.complete",
        event_id: "old-run-terminal",
        session_id: "runtime-session-1",
        payload: { status: "success" },
      });
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
    );

    await user.type(composer, "keep the new run active");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "keep the new run active",
      }),
    );
    mocks.markAgentRunSucceeded.mockClear();

    act(() => {
      retiredHandler?.({
        type: "message.complete",
        event_id: "late-old-message",
        session_id: "runtime-session-1",
        payload: { message_id: "old-answer", text: "Late text from the old run." },
      });
      retiredHandler?.({
        type: "lifecycle.complete",
        event_id: "late-old-terminal",
        session_id: "runtime-session-1",
        payload: { status: "success" },
      });
    });

    expect(screen.queryByText("Late text from the old run.")).toBeNull();
    expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Stop June" })).toBeInTheDocument();
  });

  it("attaches a queued image only after the current turn completes", async () => {
    mockGlmCapabilities(["functionCalling", "supportsVision"]);
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={existingSession} />);

    const composer = await screen.findByRole("textbox", { name: "Message June" });
    await user.type(composer, "start the audit");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "start the audit",
      }),
    );
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );
    mocks.eventHandlers.get("tauri://drag-drop")?.({
      payload: { paths: ["/Users/alex/Desktop/reference.png"] },
    });
    expect(await screen.findByText("reference.png")).toBeInTheDocument();
    await user.type(composer, "use this reference next");
    await user.click(screen.getByRole("button", { name: "Queue next message" }));

    expect(
      mocks.gatewayRequest.mock.calls.some(([method]) => method === "image.attach_bytes"),
    ).toBe(false);
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "lifecycle.complete",
          session_id: "runtime-session-1",
          payload: { status: "success" },
        });
      }
    });

    await waitFor(() =>
      expect(
        mocks.gatewayRequest.mock.calls.some(([method]) => method === "image.attach_bytes"),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: expect.stringContaining("use this reference next"),
      }),
    );
    const methods = mocks.gatewayRequest.mock.calls.map(([method]) => method);
    expect(methods.indexOf("image.attach_bytes")).toBeLessThan(
      methods.lastIndexOf("prompt.submit"),
    );
  });

  it("retains a failed queued attachment delivery for retry", async () => {
    let queuedAttempts = 0;
    mocks.gatewayRequest.mockImplementation((method: string, params?: { text?: string }) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "prompt.submit" && params?.text?.includes("review the brief next")) {
        queuedAttempts += 1;
        return queuedAttempts === 1
          ? Promise.reject(new Error("gateway unavailable"))
          : Promise.resolve({});
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={existingSession} />);

    const composer = await screen.findByRole("textbox", { name: "Message June" });
    await user.type(composer, "start the audit");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "start the audit",
      }),
    );
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );
    mocks.eventHandlers.get("tauri://drag-drop")?.({
      payload: { paths: ["/Users/alex/Desktop/brief.pdf"] },
    });
    expect(await screen.findByText("brief.pdf")).toBeInTheDocument();
    await user.type(composer, "review the brief next");
    await user.click(screen.getByRole("button", { name: "Queue next message" }));
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "lifecycle.complete",
          session_id: "runtime-session-1",
          payload: { status: "success" },
        });
      }
    });

    const retry = await screen.findByRole("button", { name: "Retry queued message" });
    expect(screen.getByText("Couldn't send")).toBeInTheDocument();
    expect(screen.getByText("review the brief next")).toBeInTheDocument();
    expect(mocks.releaseAgentRunSettlement).not.toHaveBeenCalled();
    await user.click(retry);
    await waitFor(() => expect(queuedAttempts).toBe(2));
    expect(screen.queryByText("Up next")).toBeNull();
  });

  it("does not auto-send a failed queued follow-up after the turn completes", async () => {
    let queuedAttempts = 0;
    mocks.gatewayRequest.mockImplementation((method: string, params?: { text?: string }) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "prompt.submit" && params?.text?.includes("review the brief next")) {
        queuedAttempts += 1;
        return Promise.reject(new Error("gateway unavailable"));
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={existingSession} />);

    const composer = await screen.findByRole("textbox", { name: "Message June" });
    await user.type(composer, "start the audit");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "start the audit",
      }),
    );
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );
    mocks.eventHandlers.get("tauri://drag-drop")?.({
      payload: { paths: ["/Users/alex/Desktop/brief.pdf"] },
    });
    expect(await screen.findByText("brief.pdf")).toBeInTheDocument();
    await user.type(composer, "review the brief next");
    await user.click(screen.getByRole("button", { name: "Queue next message" }));

    // First completion drains the queue; the delivery fails, so the row flips
    // to a retry affordance.
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "lifecycle.complete",
          session_id: "runtime-session-1",
          event_id: "failed-queue-delivery-trigger",
          payload: { status: "success" },
        });
      }
    });
    expect(await screen.findByRole("button", { name: "Retry queued message" })).toBeInTheDocument();
    await waitFor(() => expect(queuedAttempts).toBe(1));

    // A fresh turn re-arms the session and completes cleanly. Automatic
    // advancement must stop at the failed head rather than silently resending
    // it.
    await user.type(composer, "keep going");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "keep going",
      }),
    );
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "lifecycle.complete",
          session_id: "runtime-session-1",
          event_id: "failed-queue-later-run-complete",
          payload: { status: "success" },
        });
      }
    });
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));

    expect(queuedAttempts).toBe(1);
    expect(screen.getByRole("button", { name: "Retry queued message" })).toBeInTheDocument();
    expect(screen.getByText("review the brief next")).toBeInTheDocument();
  });

  it("surfaces an error when queued follow-up preparation fails", async () => {
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={existingSession} />);

    const composer = await screen.findByRole("textbox", { name: "Message June" });
    await user.type(composer, "start the audit");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "start the audit",
      }),
    );
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );
    mocks.eventHandlers.get("tauri://drag-drop")?.({
      payload: { paths: ["/Users/alex/Desktop/brief.pdf"] },
    });
    expect(await screen.findByText("brief.pdf")).toBeInTheDocument();
    // No skill is registered, so the slash command cannot resolve and
    // preparation rejects before anything is enqueued.
    await user.type(composer, "/nonexistent review the brief next");
    await user.click(screen.getByRole("button", { name: "Queue next message" }));

    expect(await screen.findByText("Could not find skill /nonexistent.")).toBeInTheDocument();
    expect(screen.queryByText("Up next")).toBeNull();
    const promptSubmits = mocks.gatewayRequest.mock.calls.filter(
      ([method]) => method === "prompt.submit",
    );
    expect(promptSubmits).toHaveLength(1);
    expect(composer).toHaveTextContent("review the brief next");
    expect(screen.getByText("brief.pdf")).toBeInTheDocument();
  });

  it("does not offer edit or remove after an image was attached but its message failed", async () => {
    mockGlmCapabilities(["functionCalling", "supportsVision"]);
    mocks.gatewayRequest.mockImplementation((method: string, params?: { text?: string }) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "image.attach_bytes") {
        return Promise.resolve({ attachment_id: "attached-image-1" });
      }
      if (method === "prompt.submit" && params?.text?.includes("use this reference next")) {
        return Promise.reject(new Error("gateway unavailable"));
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={existingSession} />);

    const composer = await screen.findByRole("textbox", { name: "Message June" });
    await user.type(composer, "start the audit");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "start the audit",
      }),
    );
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );
    mocks.eventHandlers.get("tauri://drag-drop")?.({
      payload: { paths: ["/Users/alex/Desktop/reference.png"] },
    });
    await user.type(composer, "use this reference next");
    await user.click(screen.getByRole("button", { name: "Queue next message" }));
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "lifecycle.complete",
          session_id: "runtime-session-1",
          payload: { status: "success" },
        });
      }
    });

    expect(await screen.findByText("Image attached; message not sent")).toBeInTheDocument();
    expect(screen.getByText("gateway unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry queued message" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit queued message" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove queued message" })).toBeNull();
  });

  it("restores an attached queued image when attachment succeeds offscreen but its prompt fails", async () => {
    mockGlmCapabilities(["functionCalling", "supportsVision"]);
    let resolveImageAttach: ((result: { attachment_id: string }) => void) | undefined;
    mocks.gatewayRequest.mockImplementation((method: string, params?: { text?: string }) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "image.attach_bytes") {
        return new Promise((resolve) => {
          resolveImageAttach = resolve;
        });
      }
      if (method === "prompt.submit" && params?.text?.includes("attach across navigation")) {
        return Promise.reject(new Error("gateway unavailable after attachment"));
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    const first = render(<AgentWorkspace initialSession={existingSession} />);

    const composer = await screen.findByRole("textbox", { name: "Message June" });
    await user.type(composer, "start the audit");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );
    act(() => {
      mocks.eventHandlers.get("tauri://drag-drop")?.({
        payload: { paths: ["/Users/alex/Desktop/offscreen-reference.png"] },
      });
    });
    await user.type(composer, "attach across navigation");
    await user.click(screen.getByRole("button", { name: "Queue next message" }));
    act(() => {
      for (const handler of [...mocks.gatewayEventHandlers]) {
        handler({
          type: "lifecycle.complete",
          session_id: "runtime-session-1",
          payload: { status: "success" },
        });
      }
    });
    await waitFor(() => expect(resolveImageAttach).toBeTypeOf("function"));

    first.unmount();
    await act(async () => {
      resolveImageAttach?.({ attachment_id: "offscreen-attached-image" });
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    render(<AgentWorkspace initialSession={existingSession} />);
    expect(await screen.findByText("Image attached; message not sent")).toBeInTheDocument();
    expect(screen.getByText("gateway unavailable after attachment")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit queued message" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove queued message" })).toBeNull();
  });

  it("opens report rows from the plus menu without inserting a chip", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now() }),
    );

    render(<AgentWorkspace />);

    expect(await screen.findByRole("textbox", { name: "Message June" })).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", {
        name: "Add files, notes, or reports",
      }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Feature request" }));

    expect(await screen.findByRole("dialog", { name: "Issue report" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Feature request" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(document.querySelector(".agent-category-chip")).toBeNull();
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("session.create", expect.anything());
  });

  it("starts a fresh report dialog draft when reopening the same category", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now() }),
    );

    render(<AgentWorkspace />);

    expect(await screen.findByRole("textbox", { name: "Message June" })).toBeInTheDocument();

    // Open a Bug report and stage a draft: a description plus a dropped file.
    await user.click(screen.getByRole("button", { name: "Add files, notes, or reports" }));
    await user.click(await screen.findByRole("menuitem", { name: "Bug report" }));

    const dialog = await screen.findByRole("dialog", { name: "Issue report" });
    await user.type(within(dialog).getByLabelText("Description"), "sensitive draft notes");
    const dropZone = dialog.querySelector(".report-dialog-drop");
    expect(dropZone).not.toBeNull();
    fireEvent.drop(dropZone as HTMLElement, {
      dataTransfer: {
        files: [new File(["png"], "screenshot.png", { type: "image/png" })],
      },
    });
    expect(await within(dialog).findByText("screenshot.png")).toBeInTheDocument();

    // Abandon the draft without sending.
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Issue report" })).toBeNull());

    // Reopening the SAME category is a new report intent: the abandoned
    // draft (description + attachment) must not survive the close.
    await user.click(screen.getByRole("button", { name: "Add files, notes, or reports" }));
    await user.click(await screen.findByRole("menuitem", { name: "Bug report" }));

    const reopened = await screen.findByRole("dialog", { name: "Issue report" });
    expect(within(reopened).getByLabelText("Description")).toHaveValue("");
    expect(within(reopened).queryByText("screenshot.png")).toBeNull();
    expect(within(reopened).queryByRole("list", { name: "Attached files" })).toBeNull();
  });

  it("wraps a submitted issue report for June and waits for explicit send", async () => {
    const user = userEvent.setup();
    seedLegacyNewSessionReportDraft();
    mocks.submitIssueReport.mockResolvedValue({ received: true });

    render(<AgentWorkspace />);

    // Wait for the restored legacy Bug report chip, then type the report after it.
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
        handler({
          type: "turn.completed",
          session_id: "runtime-session-2",
        });
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

  it("keeps a pre-ACK issue report across remount and promotes the accepted run", async () => {
    seedLegacyExistingSessionReportDraft();
    let resolvePrompt: (() => void) | undefined;
    const heldPrompt = new Promise<void>((resolve) => {
      resolvePrompt = resolve;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "prompt.submit") return heldPrompt;
      return Promise.resolve({});
    });
    mocks.submitIssueReport.mockResolvedValue({ received: true });
    const first = render(<AgentWorkspace initialSession={existingSession} />);
    const user = userEvent.setup();
    expect(await screen.findByText("Bug report")).toBeInTheDocument();
    await user.type(await screen.findByRole("textbox"), "The held report survives navigation");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: expect.stringContaining("---USER REPORT---"),
      }),
    );

    first.unmount();
    render(<AgentWorkspace initialSession={existingSession} />);
    await screen.findByRole("textbox");
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "held-report-diagnosis",
        role: "assistant",
        content: "The held report was reproduced after navigation.",
        timestamp: new Date(Date.now() + 1000).toISOString(),
      },
    ]);
    act(() => {
      for (const handler of [...mocks.gatewayEventHandlers]) {
        handler({
          type: "turn.completed",
          session_id: "runtime-session-1",
          event_id: "held-report-terminal",
        });
      }
    });
    expect(screen.queryByText(/Report ready/)).toBeNull();

    await act(async () => {
      resolvePrompt?.();
      await heldPrompt;
      await Promise.resolve();
    });

    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();
    expect(screen.getAllByText(/Report ready/)).toHaveLength(1);
    expect(mocks.startAgentRunMonitoring).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Send report" }));
    await waitFor(() =>
      expect(mocks.submitIssueReport).toHaveBeenCalledWith({
        category: "bug",
        description: "The held report survives navigation",
        agentDiagnosis: "The held report was reproduced after navigation.",
        attachmentNames: [],
        attachmentPaths: [],
        sessionId: "session-1",
      }),
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
  });

  it("shares one diagnosis refresh across promotion listeners and a remount", async () => {
    vi.useFakeTimers();
    try {
      const report = {
        category: "bug" as const,
        description: "The recorder crashes after long meetings",
        followUps: [],
        attachmentNames: [],
        attachmentPaths: [],
      };
      mocks.submitIssueReport.mockResolvedValue({ received: true });

      const first = render(<AgentWorkspace initialSession={existingSession} />);
      const second = render(<AgentWorkspace initialSession={existingSession} />);
      await settleUnderFakeTimers(() =>
        expect(
          within(first.container).getByRole("textbox", { name: "Message June" }),
        ).toBeInTheDocument(),
      );
      await settleUnderFakeTimers(() =>
        expect(
          within(second.container).getByRole("textbox", { name: "Message June" }),
        ).toBeInTheDocument(),
      );

      act(() => {
        dispatchIssueReportPromotedForTest({
          storedSessionId: "session-1",
          report,
          queueDiagnosisRefresh: true,
        });
      });
      expect(within(first.container).getByText(/Report ready/)).toBeInTheDocument();
      expect(within(second.container).getByText(/Report ready/)).toBeInTheDocument();

      // The second listener is deliberately the last surface to snapshot
      // continuity. If only the first event listener marked the refresh as
      // pending, the replacement would send immediately instead of joining
      // the shared app-lifetime refresh below.
      first.unmount();
      second.unmount();
      const replacement = render(<AgentWorkspace initialSession={existingSession} />);
      for (let index = 0; index < 8; index += 1) {
        await act(async () => Promise.resolve());
      }
      expect(within(replacement.container).getByText(/Report ready/)).toBeInTheDocument();

      let resolveRefresh: ((messages: Array<Record<string, unknown>>) => void) | undefined;
      let postPromotionFetches = 0;
      const diagnosisMessages = [
        {
          id: "shared-refresh-diagnosis",
          role: "assistant",
          content: "The recorder failed while saving.",
          timestamp: new Date().toISOString(),
        },
      ];
      mocks.listHermesSessionMessages.mockImplementation(() => {
        postPromotionFetches += 1;
        if (postPromotionFetches === 1) {
          return new Promise((resolve) => {
            resolveRefresh = resolve;
          });
        }
        return Promise.resolve(diagnosisMessages);
      });
      mocks.listHermesSessionMessages.mockClear();

      fireEvent.click(within(replacement.container).getByRole("button", { name: "Send report" }));
      expect(mocks.listHermesSessionMessages).not.toHaveBeenCalled();
      expect(mocks.submitIssueReport).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(299);
      });
      expect(mocks.listHermesSessionMessages).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(mocks.listHermesSessionMessages).toHaveBeenCalledTimes(1);
      expect(mocks.submitIssueReport).not.toHaveBeenCalled();

      await act(async () => {
        resolveRefresh?.(diagnosisMessages);
        await Promise.resolve();
      });
      await settleUnderFakeTimers(() =>
        expect(mocks.submitIssueReport).toHaveBeenCalledWith({
          category: "bug",
          description: "The recorder crashes after long meetings",
          agentDiagnosis: "The recorder failed while saving.",
          attachmentNames: [],
          attachmentPaths: [],
          sessionId: "session-1",
        }),
      );
      expect(mocks.listHermesSessionMessages).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
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
    seedLegacyExistingSessionReportDraft();

    render(<AgentWorkspace initialSession={existingSession} />);

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
    seedLegacyExistingSessionReportDraft();

    render(<AgentWorkspace initialSession={existingSession} />);

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
    seedLegacyExistingSessionReportDraft();

    render(<AgentWorkspace initialSession={existingSession} />);

    expect(await screen.findByText("Bug report")).toBeInTheDocument();
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
            storedSessionId: "session-1",
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
    seedLegacyNewSessionReportDraft();
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
        handler({
          type: "turn.completed",
          session_id: "runtime-session-2",
        });
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
    seedLegacyNewSessionReportDraft();
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
        handler({
          type: "turn.completed",
          session_id: "runtime-session-2",
          event_id: "report-initial-diagnosis-complete",
        });
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
        handler({
          type: "turn.completed",
          session_id: "runtime-session-2",
          event_id: "report-follow-up-diagnosis-complete",
        });
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
    seedLegacyNewSessionReportDraft();
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
    seedLegacyNewSessionReportDraft();
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
    seedLegacyNewSessionReportDraft();
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
        handler({
          type: "turn.completed",
          session_id: "runtime-session-2",
          event_id: "restored-report-initial-diagnosis-complete",
        });
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

    await waitFor(() => expect(mocks.gatewayEventHandlers.size).toBe(1));
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "turn.completed",
          session_id: "runtime-session-2",
          event_id: "restored-report-follow-up-complete",
          payload: { status: "success" },
        });
      }
    });

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
    seedLegacyNewSessionReportDraft();
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
        handler({
          type: "turn.completed",
          session_id: "runtime-session-2",
        });
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
    seedLegacyNewSessionReportDraft();
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
        handler({
          type: "turn.completed",
          session_id: "runtime-session-2",
        });
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

  it("replays pre-subscription delivery transitions in publication order", async () => {
    const reportA = {
      category: "bug" as const,
      description: "The first report was already delivered",
      followUps: [],
      attachmentNames: [],
      attachmentPaths: [],
    };
    const reportB = {
      category: "bug" as const,
      description: "The replacement report still needs delivery",
      followUps: [],
      attachmentNames: [],
      attachmentPaths: [],
    };
    let resolveFirstDelivery: ((value: { received: boolean }) => void) | undefined;
    mocks.submitIssueReport
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstDelivery = resolve;
          }),
      )
      .mockResolvedValue({ received: true });

    const first = render(<AgentWorkspace initialSession={existingSession} />);
    await screen.findByRole("textbox", { name: "Message June" });
    act(() => {
      dispatchIssueReportDeliverySettledForTest({
        storedSessionId: "session-1",
        report: reportA,
        result: {
          sent: false,
          errorMessage: "The issue report could not be sent. Network down.",
        },
      });
    });
    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    await waitFor(() => expect(mocks.submitIssueReport).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Sending" })).toBeDisabled();

    first.unmount();
    const publish = () => {
      dispatchIssueReportDeliverySettledForTest({
        storedSessionId: "session-1",
        report: reportA,
        result: { sent: true },
      });
      dispatchIssueReportDeliverySettledForTest({
        storedSessionId: "session-1",
        report: reportB,
        result: {
          sent: false,
          errorMessage: "The issue report could not be sent. Try again.",
        },
      });
    };
    render(
      <PublishIssueReportTransitionInLayout publish={publish}>
        <AgentWorkspace initialSession={existingSession} />
      </PublishIssueReportTransitionInLayout>,
    );

    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send report" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Sending" })).toBeNull();

    // The original async delivery can still settle after the replay. Its
    // identity must not erase the newer failed report restored by the second
    // transition.
    await act(async () => {
      resolveFirstDelivery?.({ received: true });
      await Promise.resolve();
    });
    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    await waitFor(() =>
      expect(mocks.submitIssueReport).toHaveBeenLastCalledWith({
        category: "bug",
        description: "The replacement report still needs delivery",
        agentDiagnosis: undefined,
        attachmentNames: [],
        attachmentPaths: [],
        sessionId: "session-1",
      }),
    );
  });

  it("keeps a newer follow-up draft when an older report delivery finishes", async () => {
    const user = userEvent.setup();
    seedLegacyNewSessionReportDraft();
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
        handler({
          type: "turn.completed",
          session_id: "runtime-session-2",
          event_id: "newer-draft-diagnosis-complete",
        });
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
        handler({
          type: "turn.completed",
          session_id: "runtime-session-2",
          event_id: "newer-draft-follow-up-complete",
        });
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
    seedLegacyNewSessionReportDraft();
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
        handler({
          type: "turn.completed",
          session_id: "runtime-session-2",
          event_id: "stale-report-diagnosis-complete",
        });
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
        handler({
          type: "turn.completed",
          session_id: "runtime-session-2",
          event_id: "stale-report-follow-up-complete",
        });
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
    seedLegacyNewSessionReportDraft();
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
    seedLegacyNewSessionReportDraft();
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
    seedLegacyNewSessionReportDraft();
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
    seedLegacyNewSessionReportDraft();
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

  it("replays a follow-up failure published before passive subscription", async () => {
    const report = {
      category: "bug" as const,
      description: "The recorder crashes after long meetings",
      followUps: [],
      attachmentNames: [],
      attachmentPaths: [],
    };
    mocks.submitIssueReport.mockResolvedValue({ received: true });
    const publish = () => {
      dispatchIssueReportFollowUpSubmitFailedForTest({
        storedSessionId: "session-1",
        queuedReport: report,
        restoreReport: report,
      });
    };

    render(
      <PublishIssueReportTransitionInLayout publish={publish}>
        <AgentWorkspace initialSession={existingSession} />
      </PublishIssueReportTransitionInLayout>,
    );

    expect(await screen.findByText(/Report ready/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send report" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    await waitFor(() =>
      expect(mocks.submitIssueReport).toHaveBeenCalledWith({
        category: "bug",
        description: "The recorder crashes after long meetings",
        agentDiagnosis: undefined,
        attachmentNames: [],
        attachmentPaths: [],
        sessionId: "session-1",
      }),
    );
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
            storedSessionId: "session-1",
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
    seedLegacyNewSessionReportDraft();
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
    seedLegacyNewSessionReportDraft();
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
    seedLegacyNewSessionReportDraft();
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
    // lives on the composer's current-model status. The badge's accessible name
    // carries the mode description.
    expect(getCurrentModelLabel("Anonymous Only")).toBeInTheDocument();
    expect(
      screen.getByLabelText(new RegExp(`^Anonymous mode: ${ANONYMOUS_MODEL_DESCRIPTION}`)),
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

  it("opens the model picker from an existing chat", async () => {
    const user = userEvent.setup();

    render(<AgentWorkspace initialSession={existingSession} />);

    await user.click(await screen.findByRole("button", { name: "Model: GLM 5.2" }));
    expect(await screen.findByRole("dialog", { name: "Choose text model" })).toBeInTheDocument();
  });

  it("queues /model in an existing chat and applies it before the next message", async () => {
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

    const composer = await screen.findByRole("textbox", {
      name: "Message June",
    });
    await user.type(composer, "/model anonymous");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(mocks.setVeniceModel).not.toHaveBeenCalled();
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("config.set", expect.anything());
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", expect.anything());
    expect(
      await screen.findByText("Model changed. It will be used for your next message."),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Model: Anonymous Only" }),
    ).toBeInTheDocument();

    await user.type(composer, "Continue with the private option");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("config.set", {
        session_id: "runtime-session-1",
        key: "model",
        value: "__june_remote_generation__:anonymous-only --session",
        confirm_expensive_model: true,
      }),
    );
    expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
      session_id: "runtime-session-1",
      text: "Continue with the private option",
    });
    const methods = mocks.gatewayRequest.mock.calls.map(([method]) => method);
    expect(methods.indexOf("config.set")).toBeLessThan(methods.indexOf("prompt.submit"));
  });

  it("keeps a cold /model lookup scoped to the session where Send was pressed", async () => {
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
    ];
    let finishCatalogLoad: ((value: Record<string, unknown>) => void) | undefined;
    const catalogLoad = new Promise<Record<string, unknown>>((resolve) => {
      finishCatalogLoad = resolve;
    });
    mocks.listVeniceModels.mockReturnValue(catalogLoad);
    const user = userEvent.setup();
    const { rerender } = render(<AgentWorkspace initialSession={existingSession} />);

    const composer = await screen.findByRole("textbox", { name: "Message June" });
    await user.type(composer, "/model kimi");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(mocks.listVeniceModels).toHaveBeenCalled());

    rerender(
      <AgentWorkspace
        initialSession={{
          ...existingSession,
          id: "session-2",
          title: "Other session",
          model: "zai-org-glm-5-2",
        }}
      />,
    );
    await act(async () => {
      finishCatalogLoad?.({
        mode: "generation",
        modelType: "text",
        selectedModel: "zai-org-glm-5-2",
        models: catalog,
      });
      await catalogLoad;
    });

    await waitFor(() =>
      expect(readSessionModelSelections()["session-1"]?.selection).toEqual({
        modelId: "kimi-k2-6",
      }),
    );
    expect(readSessionModelSelections()["session-2"]).toBeUndefined();
  });

  it("shows each existing chat's stored model as its picker selection", async () => {
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

    const { rerender } = render(<AgentWorkspace initialSession={existingSession} />);

    expect(await findCurrentModelLabel("GLM 5.2")).toBeInTheDocument();

    rerender(<AgentWorkspace initialSession={secondSession} />);

    expect(await findCurrentModelLabel("Kimi K2.6")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Model: Kimi K2.6" })).toBeInTheDocument();
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
    expect(getCurrentModelLabel("GLM 5.2")).toBeInTheDocument();
    expect(screen.queryByText("Anonymous mode")).not.toBeInTheDocument();
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

  it("switches Auto on from the picker toggle and persists the drilled-in preference", async () => {
    mocks.listAgentTasks.mockResolvedValue({ items: [] });
    mocks.listHermesSessions.mockResolvedValue([]);
    mocks.setVeniceModel.mockImplementation(async () => {
      const settings = {
        transcriptionProvider: "venice",
        transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
        generationModel: "open-software/auto",
        costQuality: 20,
      };
      mocks.providerModelSettings.mockResolvedValue({ settings });
      return settings;
    });
    mocks.setCostQuality.mockImplementation(async (costQuality: number) => {
      const settings = {
        transcriptionProvider: "venice",
        transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
        generationModel: "open-software/auto",
        costQuality,
      };
      mocks.providerModelSettings.mockResolvedValue({ settings });
      return settings;
    });
    const user = userEvent.setup();

    render(<AgentWorkspace />);

    await user.click(await screen.findByRole("button", { name: "Model: GLM 5.2" }));
    const dialog = await screen.findByRole("dialog", { name: "Choose text model" });
    // Suggested rows stay concrete models; Auto lives in the pinned toggle.
    expect(within(dialog).getByRole("option", { name: /GLM 5\.2/ })).toBeVisible();
    const autoSwitch = within(dialog).getByRole("switch", {
      name: "Choose the model automatically",
    });
    expect(autoSwitch).not.toBeChecked();

    // Toggling on selects the router and keeps the popover open.
    await user.click(autoSwitch);
    await waitFor(() =>
      expect(mocks.setVeniceModel).toHaveBeenCalledWith("generation", "open-software/auto"),
    );
    // The pill ghosts the active preset designation beside the model name.
    expect(await screen.findByRole("button", { name: "Model: Auto (Lower)" })).toBeInTheDocument();

    // The Preference drill-in persists a new preset and updates the pill.
    await user.click(within(dialog).getByRole("button", { name: /Preference/ }));
    await user.click(await screen.findByRole("menuitemradio", { name: /Higher quality/ }));
    await waitFor(() => expect(mocks.setCostQuality).toHaveBeenCalledWith(100));
    expect(await screen.findByRole("button", { name: "Model: Auto (Higher)" })).toBeInTheDocument();
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

  it("starts the runtime and restores messages after a full app relaunch", async () => {
    window.localStorage.setItem("june:agent:last-open-session", "session-1");
    mocks.hermesBridgeStatus.mockResolvedValue({ running: false });
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "message-1",
        role: "user",
        content: "Keep this conversation visible after relaunch",
        timestamp: "2026-06-05T12:00:00Z",
      },
      {
        id: "message-2",
        role: "assistant",
        content: "The conversation will be ready when June reopens.",
        timestamp: "2026-06-05T12:00:01Z",
      },
    ]);

    render(<AgentWorkspace />);

    expect(
      await screen.findByText("Keep this conversation visible after relaunch"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The conversation will be ready when June reopens."),
    ).toBeInTheDocument();
    expect(mocks.startHermesBridge).toHaveBeenCalledWith(undefined, false);
    expect(mocks.listHermesSessionMessages).toHaveBeenCalledWith("session-1");
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
    await waitFor(() =>
      expect(mocks.ensureHermesBridgeSession).toHaveBeenCalledWith({
        sessionId: "session-raw",
        title: "CLI Run Tracking",
      }),
    );
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
      undefined,
    );
  });

  it("suggests a loaded-message title from the first exchange when available", async () => {
    const rawTitle = "I need you to inspect the flaky tests";
    mocks.listHermesSessions.mockResolvedValue([
      {
        id: "session-exchange",
        title: rawTitle,
        preview: rawTitle,
        last_active: "2026-06-04T12:00:00Z",
      },
    ]);
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "u1",
        role: "user",
        content: "inspect the flaky tests",
        timestamp: "2026-06-04T12:00:00Z",
      },
      {
        id: "a1",
        role: "assistant",
        content: "I traced the failure to stale timers and updated the regression test.",
        timestamp: "2026-06-04T12:00:01Z",
      },
    ]);
    mocks.suggestAgentSessionTitle.mockResolvedValue({
      title: "Flaky Timer Fix",
    });

    render(<AgentWorkspace />);

    expect(await screen.findByText("Flaky Timer Fix")).toBeInTheDocument();
    expect(mocks.suggestAgentSessionTitle).toHaveBeenCalledWith(
      "inspect the flaky tests",
      "I traced the failure to stale timers and updated the regression test.",
    );
    await waitFor(() =>
      expect(mocks.ensureHermesBridgeSession).toHaveBeenCalledWith({
        sessionId: "session-exchange",
        title: "Flaky Timer Fix",
      }),
    );
    await waitFor(() =>
      expect(window.localStorage.getItem("june.agent.manuallyTitledSessions")).toBe(
        JSON.stringify({ "session-exchange": "exchange" }),
      ),
    );
  });

  it("keeps the persisted first-exchange title after a follow-up and restart", async () => {
    const user = userEvent.setup();
    const rawTitle = "I need you to inspect the flaky tests";
    let persistedTitle = rawTitle;
    mocks.listHermesSessions.mockImplementation(async () => [
      {
        id: "session-follow-up-restart",
        title: persistedTitle,
        preview: rawTitle,
        last_active: "2026-06-04T12:00:00Z",
      },
    ]);
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "u1",
        role: "user",
        content: "inspect the flaky tests",
        timestamp: "2026-06-04T12:00:00Z",
      },
      {
        id: "a1",
        role: "assistant",
        content: "I traced the failure to stale timers and updated the regression test.",
        timestamp: "2026-06-04T12:00:01Z",
      },
    ]);
    mocks.suggestAgentSessionTitle.mockResolvedValue({ title: "Flaky Timer Fix" });
    mocks.ensureHermesBridgeSession.mockImplementation(
      async (input: { sessionId: string; title?: string }) => {
        if (input.title) persistedTitle = input.title;
        return {};
      },
    );

    const first = render(<AgentWorkspace />);

    expect(await screen.findByText("Flaky Timer Fix")).toBeInTheDocument();
    await waitFor(() => expect(persistedTitle).toBe("Flaky Timer Fix"));
    await waitFor(() =>
      expect(window.localStorage.getItem("june.agent.manuallyTitledSessions")).toBe(
        JSON.stringify({ "session-follow-up-restart": "exchange" }),
      ),
    );

    await user.type(screen.getByRole("textbox"), "Does this also fail in CI?");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "Does this also fail in CI?",
      }),
    );

    first.unmount();
    resetAgentSessionContinuity();
    mocks.gatewayEventHandlers.clear();
    render(<AgentWorkspace />);

    expect(await screen.findByText("Flaky Timer Fix")).toBeInTheDocument();
    expect(screen.queryByText("Does this also fail in CI?")).toBeNull();
  });

  it("does not write a follow-up title while the first-exchange title is pending", async () => {
    const user = userEvent.setup();
    const rawTitle = "I need you to inspect the flaky tests";
    let persistedTitle = rawTitle;
    let resolveTitleSuggestion: ((value: { title: string }) => void) | undefined;
    mocks.listHermesSessions.mockImplementation(async () => [
      {
        id: "session-follow-up-pending-title",
        title: persistedTitle,
        preview: rawTitle,
        last_active: "2026-06-04T12:00:00Z",
      },
    ]);
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "u1",
        role: "user",
        content: "inspect the flaky tests",
        timestamp: "2026-06-04T12:00:00Z",
      },
      {
        id: "a1",
        role: "assistant",
        content: "I traced the failure to stale timers and updated the regression test.",
        timestamp: "2026-06-04T12:00:01Z",
      },
    ]);
    mocks.suggestAgentSessionTitle.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTitleSuggestion = resolve;
        }),
    );
    mocks.ensureHermesBridgeSession.mockImplementation(
      async (input: { sessionId: string; title?: string }) => {
        if (input.title) persistedTitle = input.title;
        return {};
      },
    );

    render(<AgentWorkspace />);

    expect(await screen.findByText(rawTitle)).toBeInTheDocument();
    await waitFor(() => expect(mocks.suggestAgentSessionTitle).toHaveBeenCalledTimes(1));
    const titleDerivationsBeforeFollowUp = mocks.titleFromPrompt.mock.calls.length;

    await user.type(screen.getByRole("textbox"), "Does this also fail in CI?");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "Does this also fail in CI?",
      }),
    );

    expect(persistedTitle).toBe(rawTitle);
    expect(mocks.titleFromPrompt).toHaveBeenCalledTimes(titleDerivationsBeforeFollowUp);

    await act(async () => {
      resolveTitleSuggestion?.({ title: "Flaky Timer Fix" });
      await Promise.resolve();
    });

    await waitFor(() => expect(persistedTitle).toBe("Flaky Timer Fix"));
    expect(await screen.findByText("Flaky Timer Fix")).toBeInTheDocument();
  });

  it("keeps a manual title after a follow-up and restart", async () => {
    const user = userEvent.setup();
    let persistedTitle = "Flaky Timer Fix";
    window.localStorage.setItem(
      "june.agent.manuallyTitledSessions",
      JSON.stringify({ "session-manual-follow-up": "exchange" }),
    );
    mocks.listHermesSessions.mockImplementation(async () => [
      {
        id: "session-manual-follow-up",
        title: persistedTitle,
        preview: "inspect the flaky tests",
        last_active: "2026-06-04T12:00:00Z",
      },
    ]);
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "u1",
        role: "user",
        content: "inspect the flaky tests",
        timestamp: "2026-06-04T12:00:00Z",
      },
      {
        id: "a1",
        role: "assistant",
        content: "I traced the failure to stale timers and updated the regression test.",
        timestamp: "2026-06-04T12:00:01Z",
      },
    ]);
    mocks.ensureHermesBridgeSession.mockImplementation(
      async (input: { sessionId: string; title?: string }) => {
        if (input.title) persistedTitle = input.title;
        return {};
      },
    );

    const first = render(<AgentWorkspace />);

    expect(await screen.findByText("Flaky Timer Fix")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Session actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Session name" });
    await user.clear(input);
    await user.type(input, "Manual CI investigation{Enter}");
    await waitFor(() => expect(persistedTitle).toBe("Manual CI investigation"));
    expect(window.localStorage.getItem("june.agent.manuallyTitledSessions")).toBe(
      JSON.stringify({ "session-manual-follow-up": "manual" }),
    );
    const titleDerivationsBeforeFollowUp = mocks.titleFromPrompt.mock.calls.length;

    await user.type(screen.getByRole("textbox"), "Check the Windows runner too");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "Check the Windows runner too",
      }),
    );

    expect(persistedTitle).toBe("Manual CI investigation");
    expect(mocks.titleFromPrompt).toHaveBeenCalledTimes(titleDerivationsBeforeFollowUp);

    first.unmount();
    resetAgentSessionContinuity();
    mocks.gatewayEventHandlers.clear();
    render(<AgentWorkspace />);

    expect(await screen.findByText("Manual CI investigation")).toBeInTheDocument();
  });

  it("uses the preview as the display title for a titleless existing-session follow-up", async () => {
    const statusDetails: AgentSessionStatusDetail[] = [];
    const handleStatus = (event: Event) => {
      statusDetails.push((event as CustomEvent<AgentSessionStatusDetail>).detail);
    };
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
    const preview = "Investigate the desktop release failure";
    const titlelessSession = {
      id: "session-preview-fallback",
      title: "",
      preview,
      last_active: "2026-06-04T12:00:00Z",
    };
    mocks.listHermesSessions.mockResolvedValue([titlelessSession]);
    const user = userEvent.setup();

    try {
      render(<AgentWorkspace initialSession={titlelessSession} />);

      await user.type(
        await screen.findByRole("textbox", { name: "Message June" }),
        "Check the signing step too",
      );
      await user.click(screen.getByRole("button", { name: "Send message" }));

      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text: "Check the signing step too",
        }),
      );
      expect(statusDetails).toContainEqual(
        expect.objectContaining({
          sessionId: "session-preview-fallback",
          status: "running",
          title: preview,
        }),
      );
      expect(statusDetails).not.toContainEqual(
        expect.objectContaining({
          sessionId: "session-preview-fallback",
          title: "Untitled session",
        }),
      );
    } finally {
      window.removeEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
    }
  });

  it("uses the prompt as the display title for a cold-start follow-up", async () => {
    const statusDetails: AgentSessionStatusDetail[] = [];
    const handleStatus = (event: Event) => {
      statusDetails.push((event as CustomEvent<AgentSessionStatusDetail>).detail);
    };
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
    mocks.listHermesSessions.mockResolvedValue([]);
    const user = userEvent.setup();
    const prompt = "Check the signing step too";

    try {
      render(<AgentWorkspace initialSessionId="session-cold-start" />);

      await user.type(await screen.findByRole("textbox", { name: "Message June" }), prompt);
      await user.click(screen.getByRole("button", { name: "Send message" }));

      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text: prompt,
        }),
      );
      expect(mocks.titleFromPrompt).toHaveBeenCalledWith(prompt);
      expect(statusDetails).toContainEqual(
        expect.objectContaining({
          sessionId: "session-cold-start",
          status: "running",
          title: prompt,
        }),
      );
      expect(mocks.ensureHermesBridgeSession).not.toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-cold-start",
          title: expect.any(String),
        }),
      );
    } finally {
      window.removeEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
    }
  });

  it("skips the durable exchange marker when title persistence fails", async () => {
    const rawTitle = "I need you to inspect the flaky tests";
    mocks.listHermesSessions.mockResolvedValue([
      {
        id: "session-exchange-unsaved",
        title: rawTitle,
        preview: rawTitle,
        last_active: "2026-06-04T12:00:00Z",
      },
    ]);
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "u1",
        role: "user",
        content: "inspect the flaky tests",
        timestamp: "2026-06-04T12:00:00Z",
      },
      {
        id: "a1",
        role: "assistant",
        content: "I traced the failure to stale timers and updated the regression test.",
        timestamp: "2026-06-04T12:00:01Z",
      },
    ]);
    mocks.suggestAgentSessionTitle.mockResolvedValue({
      title: "Flaky Timer Fix",
    });
    mocks.ensureHermesBridgeSession.mockRejectedValue(new Error("bridge offline"));

    render(<AgentWorkspace />);

    expect(await screen.findByText("Flaky Timer Fix")).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.ensureHermesBridgeSession).toHaveBeenCalledWith({
        sessionId: "session-exchange-unsaved",
        title: "Flaky Timer Fix",
      }),
    );
    // A failed PATCH must not settle the title durably: the next launch has to
    // be able to retry, or a stale stored title would be frozen forever.
    expect(window.localStorage.getItem("june.agent.manuallyTitledSessions")).toBeNull();
  });

  it("latches a rejected loaded-session title before fallback persistence", async () => {
    const rawTitle = "I need you to inspect the flaky tests";
    mocks.listHermesSessions.mockResolvedValue([
      {
        id: "session-rejected-unsaved",
        title: rawTitle,
        preview: rawTitle,
        last_active: "2026-06-04T12:00:00Z",
      },
    ]);
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "u1",
        role: "user",
        content: "inspect the flaky tests",
        timestamp: "2026-06-04T12:00:00Z",
      },
      {
        id: "a1",
        role: "assistant",
        content: "Could you clarify which failures you mean?",
        timestamp: "2026-06-04T12:00:01Z",
      },
    ]);
    mocks.suggestAgentSessionTitle.mockRejectedValue({
      code: "agent_title_empty",
      message: "Title generation returned an empty title.",
    });
    mocks.ensureHermesBridgeSession.mockRejectedValue(new Error("bridge offline"));

    render(<AgentWorkspace />);

    await waitFor(() => expect(mocks.suggestAgentSessionTitle).toHaveBeenCalledTimes(1));
    expect((await screen.findAllByText("inspect the flaky tests")).length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem("june.agent.manuallyTitledSessions") ?? "{}"),
      ).toEqual({ "session-rejected-unsaved": "rejected" }),
    );

    hermesActivityStore.record(
      {
        kind: "lifecycle",
        sessionId: "session-rejected-unsaved",
        flavor: "running",
        status: "running",
        text: "",
        receivedAt: "2026-06-04T12:00:02Z",
      },
      "sandboxed",
    );
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 2600));
    });

    expect(mocks.suggestAgentSessionTitle).toHaveBeenCalledTimes(1);
  }, 5_000);

  it("re-asserts a manual rename that lands while the auto-title persist is in flight", async () => {
    const rawTitle = "I need you to inspect the flaky tests";
    mocks.listHermesSessions.mockResolvedValue([
      {
        id: "session-race",
        title: rawTitle,
        preview: rawTitle,
        last_active: "2026-06-04T12:00:00Z",
      },
    ]);
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "u1",
        role: "user",
        content: "inspect the flaky tests",
        timestamp: "2026-06-04T12:00:00Z",
      },
      {
        id: "a1",
        role: "assistant",
        content: "I traced the failure to stale timers and updated the regression test.",
        timestamp: "2026-06-04T12:00:01Z",
      },
    ]);
    mocks.suggestAgentSessionTitle.mockResolvedValue({
      title: "Flaky Timer Fix",
    });
    let releaseAutoPatch: (() => void) | undefined;
    mocks.ensureHermesBridgeSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseAutoPatch = () => resolve({});
        }),
    );

    render(<AgentWorkspace />);

    expect(await screen.findByText("Flaky Timer Fix")).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.ensureHermesBridgeSession).toHaveBeenCalledWith({
        sessionId: "session-race",
        title: "Flaky Timer Fix",
      }),
    );

    // Manual rename while the auto-title PATCH is still pending.
    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_SESSION_RENAMED_EVENT, {
          detail: { sessionId: "session-race", title: "My real session name" },
        }),
      );
    });
    expect(await screen.findByText("My real session name")).toBeInTheDocument();

    await act(async () => {
      releaseAutoPatch?.();
      await Promise.resolve();
    });

    // The resolving auto PATCH must re-assert the manual title (so Hermes does
    // not keep the auto title) and must not settle an exchange marker over the
    // manual record.
    await waitFor(() =>
      expect(mocks.ensureHermesBridgeSession).toHaveBeenLastCalledWith({
        sessionId: "session-race",
        title: "My real session name",
      }),
    );
    expect(window.localStorage.getItem("june.agent.manuallyTitledSessions")).toBe(
      JSON.stringify({ "session-race": "manual" }),
    );
  });

  it("upgrades a prompt-only loaded-message title once when the assistant reply appears", async () => {
    const rawTitle = "I want you to summarize latest failures";
    const userMessage = {
      id: "u1",
      role: "user",
      content: "summarize latest failures",
      timestamp: "2026-06-04T12:00:00Z",
    };
    const assistantMessage = {
      id: "a1",
      role: "assistant",
      content: "I found the failing path and isolated the missing persistence call.",
      timestamp: "2026-06-04T12:00:01Z",
    };
    mocks.listHermesSessions.mockResolvedValue([
      {
        id: "session-upgrade",
        title: rawTitle,
        preview: rawTitle,
        last_active: "2026-06-04T12:00:00Z",
      },
    ]);
    mocks.listHermesSessionMessages
      .mockResolvedValueOnce([userMessage])
      .mockResolvedValue([userMessage, assistantMessage]);
    mocks.suggestAgentSessionTitle
      .mockResolvedValueOnce({ title: "Failure Summary" })
      .mockResolvedValueOnce({ title: "Persistence Fix" });
    hermesActivityStore.record(
      {
        kind: "lifecycle",
        sessionId: "session-upgrade",
        flavor: "running",
        status: "running",
        text: "",
        receivedAt: "2026-06-04T12:00:00Z",
      },
      "sandboxed",
    );

    render(<AgentWorkspace />);

    expect(await screen.findByText("Failure Summary")).toBeInTheDocument();
    expect(mocks.suggestAgentSessionTitle).toHaveBeenCalledTimes(1);
    expect(mocks.suggestAgentSessionTitle).toHaveBeenLastCalledWith(
      "summarize latest failures",
      undefined,
    );

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 2600));
    });

    await waitFor(() => expect(mocks.suggestAgentSessionTitle).toHaveBeenCalledTimes(2));
    expect(mocks.suggestAgentSessionTitle).toHaveBeenLastCalledWith(
      "summarize latest failures",
      "I found the failing path and isolated the missing persistence call.",
    );
    expect(await screen.findByText("Persistence Fix")).toBeInTheDocument();
    hermesActivityStore.record(
      {
        kind: "lifecycle",
        sessionId: "session-upgrade",
        flavor: "running",
        status: "running",
        text: "",
        receivedAt: "2026-06-04T12:00:02Z",
      },
      "sandboxed",
    );

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 2600));
    });

    expect(mocks.suggestAgentSessionTitle).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("rechecks latest messages when a fresh prompt-only suggestion resolves after the reply loads", async () => {
    const rawTitle = "I want you to summarize latest failures";
    const userMessage = {
      id: "u1",
      role: "user",
      content: "summarize latest failures",
      timestamp: "2026-06-04T12:00:00Z",
    };
    const assistantMessage = {
      id: "a1",
      role: "assistant",
      content: "I found the failing path and isolated the missing persistence call.",
      timestamp: "2026-06-04T12:00:01Z",
    };
    const secondSession = {
      id: "session-other",
      title: "Other session",
      preview: "Other preview",
      last_active: "2026-06-04T12:05:00Z",
    };
    let resolvePromptTitle: (value: { title: string }) => void = () => {};
    const promptTitle = new Promise<{ title: string }>((resolve) => {
      resolvePromptTitle = resolve;
    });
    const targetSession = {
      id: "session-upgrade-pending",
      title: rawTitle,
      preview: rawTitle,
      last_active: "2026-06-04T12:00:00Z",
    };
    mocks.listHermesSessions.mockResolvedValue([targetSession, secondSession]);
    mocks.listHermesSessionMessages
      .mockResolvedValueOnce([userMessage])
      .mockResolvedValueOnce([])
      .mockResolvedValue([userMessage, assistantMessage]);
    mocks.suggestAgentSessionTitle
      .mockImplementationOnce(() => promptTitle)
      .mockResolvedValueOnce({ title: "Persistence Fix" });

    const { rerender } = render(<AgentWorkspace initialSession={targetSession} />);

    await waitFor(() => expect(mocks.suggestAgentSessionTitle).toHaveBeenCalledTimes(1));
    expect(mocks.suggestAgentSessionTitle).toHaveBeenLastCalledWith(
      "summarize latest failures",
      undefined,
    );

    rerender(<AgentWorkspace initialSession={secondSession} />);
    expect(await screen.findByText("Other session")).toBeInTheDocument();
    rerender(<AgentWorkspace initialSession={targetSession} />);

    await waitFor(() =>
      expect(mocks.listHermesSessionMessages.mock.calls.length).toBeGreaterThanOrEqual(3),
    );
    expect(mocks.suggestAgentSessionTitle).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePromptTitle({ title: "Failure Summary" });
      await promptTitle;
    });

    await waitFor(() => expect(mocks.suggestAgentSessionTitle).toHaveBeenCalledTimes(2));
    expect(mocks.suggestAgentSessionTitle).toHaveBeenLastCalledWith(
      "summarize latest failures",
      "I found the failing path and isolated the missing persistence call.",
    );
    expect(await screen.findByText("Persistence Fix")).toBeInTheDocument();
  }, 10_000);

  it("keeps a prompt title when an exchange title suggestion fails and retries later", async () => {
    const rawTitle = "I want you to summarize latest failures";
    const userMessage = {
      id: "u1",
      role: "user",
      content: "summarize latest failures",
      timestamp: "2026-06-04T12:00:00Z",
    };
    const assistantMessage = {
      id: "a1",
      role: "assistant",
      content: "I found the failing path and isolated the missing persistence call.",
      timestamp: "2026-06-04T12:00:01Z",
    };
    mocks.listHermesSessions.mockResolvedValue([
      {
        id: "session-upgrade-reject",
        title: rawTitle,
        preview: rawTitle,
        last_active: "2026-06-04T12:00:00Z",
      },
    ]);
    mocks.listHermesSessionMessages
      .mockResolvedValueOnce([userMessage])
      .mockResolvedValue([userMessage, assistantMessage]);
    mocks.suggestAgentSessionTitle
      .mockResolvedValueOnce({ title: "Failure Summary" })
      .mockRejectedValueOnce(new Error("title service unavailable"))
      .mockResolvedValueOnce({ title: "Persistence Fix" });
    hermesActivityStore.record(
      {
        kind: "lifecycle",
        sessionId: "session-upgrade-reject",
        flavor: "running",
        status: "running",
        text: "",
        receivedAt: "2026-06-04T12:00:00Z",
      },
      "sandboxed",
    );

    render(<AgentWorkspace />);

    expect(await screen.findByText("Failure Summary")).toBeInTheDocument();
    expect(mocks.suggestAgentSessionTitle).toHaveBeenCalledTimes(1);

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 2600));
    });

    await waitFor(() => expect(mocks.suggestAgentSessionTitle).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Failure Summary")).toBeInTheDocument();
    expect(window.localStorage.getItem("june.agent.manuallyTitledSessions")).toBeNull();

    hermesActivityStore.record(
      {
        kind: "lifecycle",
        sessionId: "session-upgrade-reject",
        flavor: "running",
        status: "running",
        text: "",
        receivedAt: "2026-06-04T12:00:02Z",
      },
      "sandboxed",
    );

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 2600));
    });

    await waitFor(() => expect(mocks.suggestAgentSessionTitle).toHaveBeenCalledTimes(3));
    expect(await screen.findByText("Persistence Fix")).toBeInTheDocument();
  }, 10_000);

  it("keeps a prompt title when the first-exchange suggestion is assistant dialogue", async () => {
    const rawTitle = "I want you to summarize latest failures";
    const userMessage = {
      id: "u1",
      role: "user",
      content: "summarize latest failures",
      timestamp: "2026-06-04T12:00:00Z",
    };
    const assistantMessage = {
      id: "a1",
      role: "assistant",
      content: "Could you clarify which failures you mean?",
      timestamp: "2026-06-04T12:00:01Z",
    };
    const followUpUserMessage = {
      id: "u2",
      role: "user",
      content: "the staging failures",
      timestamp: "2026-06-04T12:00:02Z",
    };
    const substantiveAssistantMessage = {
      id: "a2",
      role: "assistant",
      content: "I fixed the staging persistence race and verified the regression test.",
      timestamp: "2026-06-04T12:00:03Z",
    };
    const extraAssistantMessage = {
      id: "a-tool",
      role: "assistant",
      content: "I checked one more source.",
      timestamp: "2026-06-04T12:00:02Z",
    };
    mocks.listHermesSessions.mockResolvedValue([
      {
        id: "session-invalid-exchange-title",
        title: rawTitle,
        preview: rawTitle,
        last_active: "2026-06-04T12:00:00Z",
      },
    ]);
    mocks.listHermesSessionMessages
      .mockResolvedValueOnce([userMessage])
      .mockResolvedValue([userMessage, assistantMessage]);
    mocks.suggestAgentSessionTitle
      .mockResolvedValueOnce({ title: "Failure summary" })
      .mockRejectedValueOnce({
        code: "agent_title_empty",
        message: "Title generation returned an empty title.",
      })
      .mockResolvedValueOnce({ title: "Staging persistence fix" });
    hermesActivityStore.record(
      {
        kind: "lifecycle",
        sessionId: "session-invalid-exchange-title",
        flavor: "running",
        status: "running",
        text: "",
        receivedAt: "2026-06-04T12:00:00Z",
      },
      "sandboxed",
    );

    render(<AgentWorkspace />);

    expect(await screen.findByText("Failure summary")).toBeInTheDocument();

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 2600));
    });

    await waitFor(() => expect(mocks.suggestAgentSessionTitle).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Failure summary")).toBeInTheDocument();
    expect(screen.queryByText("I'm sorry, but I can't help with that")).toBeNull();
    expect(mocks.ensureHermesBridgeSession).not.toHaveBeenCalledWith({
      sessionId: "session-invalid-exchange-title",
      title: "I'm sorry, but I can't help with that",
    });
    expect(
      JSON.parse(window.localStorage.getItem("june.agent.manuallyTitledSessions") ?? "{}"),
    ).toEqual({ "session-invalid-exchange-title": "rejected" });

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 2600));
    });
    expect(mocks.suggestAgentSessionTitle).toHaveBeenCalledTimes(2);

    mocks.listHermesSessionMessages.mockResolvedValue([
      userMessage,
      assistantMessage,
      extraAssistantMessage,
    ]);
    hermesActivityStore.record(
      {
        kind: "lifecycle",
        sessionId: "session-invalid-exchange-title",
        flavor: "running",
        status: "running",
        text: "",
        receivedAt: "2026-06-04T12:00:03Z",
      },
      "sandboxed",
    );
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 2600));
    });
    expect(mocks.suggestAgentSessionTitle).toHaveBeenCalledTimes(2);

    mocks.listHermesSessionMessages.mockResolvedValue([
      userMessage,
      assistantMessage,
      followUpUserMessage,
      substantiveAssistantMessage,
    ]);
    hermesActivityStore.record(
      {
        kind: "lifecycle",
        sessionId: "session-invalid-exchange-title",
        flavor: "running",
        status: "running",
        text: "",
        receivedAt: "2026-06-04T12:00:04Z",
      },
      "sandboxed",
    );
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 2600));
    });

    await waitFor(() => expect(mocks.suggestAgentSessionTitle).toHaveBeenCalledTimes(3));
    expect(mocks.suggestAgentSessionTitle).toHaveBeenLastCalledWith(
      "the staging failures",
      "I fixed the staging persistence race and verified the regression test.",
    );
    expect(await screen.findByText("Staging persistence fix")).toBeInTheDocument();
  }, 15_000);

  it("keeps a failed fresh title fallback retry to a later natural refresh", async () => {
    const rawTitle = "I want you to summarize latest failures";
    const userMessage = {
      id: "u1",
      role: "user",
      content: "summarize latest failures",
      timestamp: "2026-06-04T12:00:00Z",
    };
    const assistantMessage = {
      id: "a1",
      role: "assistant",
      content: "I found the failing path and isolated the missing persistence call.",
      timestamp: "2026-06-04T12:00:01Z",
    };
    const secondSession = {
      id: "session-other",
      title: "Other session",
      preview: "Other preview",
      last_active: "2026-06-04T12:05:00Z",
    };
    let rejectPromptTitle: (reason?: unknown) => void = () => {};
    const promptTitle = new Promise<{ title: string }>((_resolve, reject) => {
      rejectPromptTitle = reject;
    });
    const targetSession = {
      id: "session-fresh-reject",
      title: rawTitle,
      preview: rawTitle,
      last_active: "2026-06-04T12:00:00Z",
    };
    mocks.listHermesSessions.mockResolvedValue([targetSession, secondSession]);
    mocks.listHermesSessionMessages
      .mockResolvedValueOnce([userMessage])
      .mockResolvedValueOnce([])
      .mockResolvedValue([userMessage, assistantMessage]);
    mocks.suggestAgentSessionTitle
      .mockImplementationOnce(() => promptTitle)
      .mockResolvedValueOnce({ title: "Persistence Fix" });

    const { rerender } = render(<AgentWorkspace initialSession={targetSession} />);

    await waitFor(() => expect(mocks.suggestAgentSessionTitle).toHaveBeenCalledTimes(1));
    expect(mocks.suggestAgentSessionTitle).toHaveBeenLastCalledWith(
      "summarize latest failures",
      undefined,
    );

    rerender(<AgentWorkspace initialSession={secondSession} />);
    expect(await screen.findByText("Other session")).toBeInTheDocument();
    rerender(<AgentWorkspace initialSession={targetSession} />);

    await waitFor(() =>
      expect(mocks.listHermesSessionMessages.mock.calls.length).toBeGreaterThanOrEqual(3),
    );

    await act(async () => {
      rejectPromptTitle(new Error("title service unavailable"));
      await promptTitle.catch(() => undefined);
    });

    await waitFor(() =>
      expect(screen.getAllByText("summarize latest failures").length).toBeGreaterThan(0),
    );
    expect(mocks.suggestAgentSessionTitle).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem("june.agent.manuallyTitledSessions")).toBeNull();
    expect(mocks.ensureHermesBridgeSession).toHaveBeenCalledWith({
      sessionId: "session-fresh-reject",
      title: "summarize latest failures",
    });
  }, 10_000);

  it("upgrades a prompt-only title from the first non-empty assistant reply", async () => {
    const rawTitle = "I want you to summarize latest failures";
    const userMessage = {
      id: "u1",
      role: "user",
      content: "summarize latest failures",
      timestamp: "2026-06-04T12:00:00Z",
    };
    const emptyAssistantMessage = {
      id: "a-empty",
      role: "assistant",
      content: "",
      timestamp: "2026-06-04T12:00:01Z",
    };
    const assistantMessage = {
      id: "a1",
      role: "assistant",
      content: "I found the failing path and isolated the missing persistence call.",
      timestamp: "2026-06-04T12:00:02Z",
    };
    mocks.listHermesSessions.mockResolvedValue([
      {
        id: "session-upgrade-empty",
        title: rawTitle,
        preview: rawTitle,
        last_active: "2026-06-04T12:00:00Z",
      },
    ]);
    mocks.listHermesSessionMessages
      .mockResolvedValueOnce([userMessage])
      .mockResolvedValue([userMessage, emptyAssistantMessage, assistantMessage]);
    mocks.suggestAgentSessionTitle
      .mockResolvedValueOnce({ title: "Failure Summary" })
      .mockResolvedValueOnce({ title: "Persistence Fix" });
    hermesActivityStore.record(
      {
        kind: "lifecycle",
        sessionId: "session-upgrade-empty",
        flavor: "running",
        status: "running",
        text: "",
        receivedAt: "2026-06-04T12:00:00Z",
      },
      "sandboxed",
    );

    render(<AgentWorkspace />);

    expect(await screen.findByText("Failure Summary")).toBeInTheDocument();
    expect(mocks.suggestAgentSessionTitle).toHaveBeenCalledTimes(1);

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 2600));
    });

    await waitFor(() => expect(mocks.suggestAgentSessionTitle).toHaveBeenCalledTimes(2));
    expect(mocks.suggestAgentSessionTitle).toHaveBeenLastCalledWith(
      "summarize latest failures",
      "I found the failing path and isolated the missing persistence call.",
    );
    expect(await screen.findByText("Persistence Fix")).toBeInTheDocument();
  }, 10_000);

  it("keeps a sidebar rename from being overwritten by a prompt-title exchange upgrade", async () => {
    const rawTitle = "I want you to summarize latest failures";
    const userMessage = {
      id: "u1",
      role: "user",
      content: "summarize latest failures",
      timestamp: "2026-06-04T12:00:00Z",
    };
    const assistantMessage = {
      id: "a1",
      role: "assistant",
      content: "I found the failing path and isolated the missing persistence call.",
      timestamp: "2026-06-04T12:00:01Z",
    };
    mocks.listHermesSessions.mockResolvedValue([
      {
        id: "session-sidebar-prompt",
        title: rawTitle,
        preview: rawTitle,
        last_active: "2026-06-04T12:00:00Z",
      },
    ]);
    mocks.listHermesSessionMessages
      .mockResolvedValueOnce([userMessage])
      .mockResolvedValue([userMessage, assistantMessage]);
    mocks.suggestAgentSessionTitle.mockResolvedValueOnce({ title: "Failure Summary" });
    hermesActivityStore.record(
      {
        kind: "lifecycle",
        sessionId: "session-sidebar-prompt",
        flavor: "running",
        status: "running",
        text: "",
        receivedAt: "2026-06-04T12:00:00Z",
      },
      "sandboxed",
    );

    render(<AgentWorkspace />);

    expect(await screen.findByText("Failure Summary")).toBeInTheDocument();
    expect(mocks.suggestAgentSessionTitle).toHaveBeenCalledTimes(1);
    mocks.ensureHermesBridgeSession.mockClear();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_SESSION_RENAMED_EVENT, {
          detail: {
            sessionId: "session-sidebar-prompt",
            title: "Manual sidebar name",
          },
        }),
      );
    });

    expect(await screen.findByText("Manual sidebar name")).toBeInTheDocument();

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 2600));
    });

    await waitFor(() =>
      expect(mocks.listHermesSessionMessages).toHaveBeenCalledWith("session-sidebar-prompt"),
    );
    expect(mocks.suggestAgentSessionTitle).toHaveBeenCalledTimes(1);
    expect(mocks.ensureHermesBridgeSession).not.toHaveBeenCalled();
    expect(screen.getByText("Manual sidebar name")).toBeInTheDocument();
  }, 10_000);

  it("keeps a sidebar rename from being overwritten by a fresh suggestion", async () => {
    const userMessage = {
      id: "u1",
      role: "user",
      content: "review the import retry path",
      timestamp: "2026-06-04T12:00:00Z",
    };
    const assistantMessage = {
      id: "a1",
      role: "assistant",
      content: "The retry path skipped the persisted session title update.",
      timestamp: "2026-06-04T12:00:01Z",
    };
    mocks.listHermesSessions.mockResolvedValue([
      {
        id: "session-sidebar-fresh",
        title: "Untitled session",
        preview: "review the import retry path",
        last_active: "2026-06-04T12:00:00Z",
      },
    ]);
    mocks.listHermesSessionMessages
      .mockResolvedValueOnce([])
      .mockResolvedValue([userMessage, assistantMessage]);
    mocks.suggestAgentSessionTitle.mockResolvedValue({ title: "Import Retry Review" });
    hermesActivityStore.record(
      {
        kind: "lifecycle",
        sessionId: "session-sidebar-fresh",
        flavor: "running",
        status: "running",
        text: "",
        receivedAt: "2026-06-04T12:00:00Z",
      },
      "sandboxed",
    );

    render(<AgentWorkspace />);

    expect(await screen.findByText("Untitled session")).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_SESSION_RENAMED_EVENT, {
          detail: {
            sessionId: "session-sidebar-fresh",
            title: "Manual import notes",
          },
        }),
      );
    });

    expect(await screen.findByText("Manual import notes")).toBeInTheDocument();

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 2600));
    });

    await waitFor(() =>
      expect(mocks.listHermesSessionMessages).toHaveBeenCalledWith("session-sidebar-fresh"),
    );
    expect(mocks.suggestAgentSessionTitle).not.toHaveBeenCalled();
    expect(mocks.ensureHermesBridgeSession).not.toHaveBeenCalledWith({
      sessionId: "session-sidebar-fresh",
      title: "Import Retry Review",
    });
    expect(screen.getByText("Manual import notes")).toBeInTheDocument();
  }, 10_000);

  it("keeps a durable manual title marker from being overwritten on fresh mount", async () => {
    const userMessage = {
      id: "u1",
      role: "user",
      content: "set up staging deploy",
      timestamp: "2026-06-04T12:00:00Z",
    };
    const assistantMessage = {
      id: "a1",
      role: "assistant",
      content: "I checked the deployment steps and found the staging settings.",
      timestamp: "2026-06-04T12:00:01Z",
    };
    window.localStorage.setItem(
      "june.agent.manuallyTitledSessions",
      JSON.stringify({ "session-durable-manual": true }),
    );
    mocks.listHermesSessions.mockResolvedValue([
      {
        id: "session-durable-manual",
        title: "Set up staging deploy",
        preview: "set up staging deploy",
        last_active: "2026-06-04T12:00:00Z",
      },
    ]);
    mocks.listHermesSessionMessages.mockResolvedValue([userMessage, assistantMessage]);
    mocks.suggestAgentSessionTitle.mockResolvedValue({ title: "Staging Deploy Setup" });

    render(<AgentWorkspace />);

    expect(await screen.findByText("Set up staging deploy")).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.listHermesSessionMessages).toHaveBeenCalledWith("session-durable-manual"),
    );
    expect(mocks.suggestAgentSessionTitle).not.toHaveBeenCalled();
    expect(mocks.ensureHermesBridgeSession).not.toHaveBeenCalledWith({
      sessionId: "session-durable-manual",
      title: "Staging Deploy Setup",
    });
    expect(screen.getByText("Set up staging deploy")).toBeInTheDocument();
  });

  it("keeps a durable exchange title marker from being overwritten on fresh mount", async () => {
    const userMessage = {
      id: "u1",
      role: "user",
      content: "set up staging deploy",
      timestamp: "2026-06-04T12:00:00Z",
    };
    const assistantMessage = {
      id: "a1",
      role: "assistant",
      content: "I checked the deployment steps and found the staging settings.",
      timestamp: "2026-06-04T12:00:01Z",
    };
    window.localStorage.setItem(
      "june.agent.manuallyTitledSessions",
      JSON.stringify({ "session-durable-exchange": "exchange" }),
    );
    mocks.listHermesSessions.mockResolvedValue([
      {
        id: "session-durable-exchange",
        title: "Set up staging deploy",
        preview: "set up staging deploy",
        last_active: "2026-06-04T12:00:00Z",
      },
    ]);
    mocks.listHermesSessionMessages.mockResolvedValue([userMessage, assistantMessage]);
    mocks.suggestAgentSessionTitle.mockResolvedValue({ title: "Staging Deploy Setup" });

    render(<AgentWorkspace />);

    expect(await screen.findByText("Set up staging deploy")).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.listHermesSessionMessages).toHaveBeenCalledWith("session-durable-exchange"),
    );
    expect(mocks.suggestAgentSessionTitle).not.toHaveBeenCalled();
    expect(mocks.ensureHermesBridgeSession).not.toHaveBeenCalledWith({
      sessionId: "session-durable-exchange",
      title: "Staging Deploy Setup",
    });
    expect(screen.getByText("Set up staging deploy")).toBeInTheDocument();
  });

  it("persists manual header renames and blocks later title suggestions", async () => {
    const userMessage = {
      id: "u1",
      role: "user",
      content: "summarize the billing retry failure",
      timestamp: "2026-06-04T12:00:00Z",
    };
    const assistantMessage = {
      id: "a1",
      role: "assistant",
      content: "The retry path skipped the persisted session title update.",
      timestamp: "2026-06-04T12:00:01Z",
    };
    mocks.listHermesSessions.mockResolvedValue([
      {
        id: "session-manual",
        title: "I want you to summarize the billing retry failure",
        preview: "I want you to summarize the billing retry failure",
        last_active: "2026-06-04T12:00:00Z",
      },
    ]);
    mocks.listHermesSessionMessages
      .mockResolvedValueOnce([])
      .mockResolvedValue([userMessage, assistantMessage]);
    hermesActivityStore.record(
      {
        kind: "lifecycle",
        sessionId: "session-manual",
        flavor: "running",
        status: "running",
        text: "",
        receivedAt: "2026-06-04T12:00:00Z",
      },
      "sandboxed",
    );
    const user = userEvent.setup();

    render(<AgentWorkspace />);

    expect(
      await screen.findByText("I want you to summarize the billing retry failure"),
    ).toBeInTheDocument();
    expect(mocks.suggestAgentSessionTitle).not.toHaveBeenCalled();
    mocks.ensureHermesBridgeSession.mockRejectedValueOnce(new Error("patch failed"));

    await user.click(screen.getByRole("button", { name: "Session actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Session name" });
    await user.clear(input);
    await user.type(input, "Billing retry notes{Enter}");

    expect(await screen.findByText("Billing retry notes")).toBeInTheDocument();
    expect(mocks.ensureHermesBridgeSession).toHaveBeenCalledWith({
      sessionId: "session-manual",
      title: "Billing retry notes",
    });
    expect(
      await screen.findByText("Could not save the session name. It may revert after a restart."),
    ).toBeInTheDocument();

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 2600));
    });

    await waitFor(() =>
      expect(mocks.listHermesSessionMessages).toHaveBeenCalledWith("session-manual"),
    );
    expect(mocks.suggestAgentSessionTitle).not.toHaveBeenCalled();
  }, 10_000);

  it("does not suggest a title for non-replaceable loaded sessions without a title source", async () => {
    mocks.listHermesSessions.mockResolvedValue([
      {
        id: "session-specific",
        title: "Payment architecture review",
        preview: "Review the billing shape",
        last_active: "2026-06-04T12:00:00Z",
      },
    ]);
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "u1",
        role: "user",
        content: "review the billing shape",
        timestamp: "2026-06-04T12:00:00Z",
      },
      {
        id: "a1",
        role: "assistant",
        content: "I reviewed the architecture and found no blocking issue.",
        timestamp: "2026-06-04T12:00:01Z",
      },
    ]);

    render(<AgentWorkspace />);

    expect(await screen.findByText("Payment architecture review")).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.listHermesSessionMessages).toHaveBeenCalledWith("session-specific"),
    );
    expect(mocks.suggestAgentSessionTitle).not.toHaveBeenCalled();
    expect(mocks.ensureHermesBridgeSession).not.toHaveBeenCalledWith({
      sessionId: "session-specific",
      title: expect.any(String),
    });
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

  it("blocks the CLI-access follow-up at the shared paid dispatch boundary", async () => {
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "a1",
        role: "assistant",
        content: "[REQUEST:AGENT_CLI_ACCESS]",
        timestamp: "2026-06-12T10:00:05Z",
      },
    ]);
    mocks.setHermesAgentCliAccess.mockResolvedValue({ enabled: true });
    const user = userEvent.setup();

    render(
      <AgentWorkspace
        initialSession={existingSession}
        creditActionsDisabledReason="Add credits to send messages or generate images and videos."
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Enable Agent CLI access" }));

    await waitFor(() => expect(mocks.setHermesAgentCliAccess).toHaveBeenCalledWith(true));
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", expect.anything());
    expect(
      screen.getAllByText("Add credits to send messages or generate images and videos.").length,
    ).toBeGreaterThan(0);
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

    // Already granted resolves to the quiet collapsed receipt row — the full
    // "requested" prompt title is not shown, only the enabled outcome.
    expect(await screen.findByText("Agent CLI access enabled")).toBeInTheDocument();
    expect(screen.queryByText("Agent CLI access requested")).toBeNull();
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

  it("copies live media prose without its transport reference", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "a1",
        role: "assistant",
        content: "Earlier answer.",
        timestamp: "2026-06-12T10:00:05Z",
      },
    ]);
    const mediaPath = "/tmp/copied-image.png";
    const rawText = `Here is the image.\n\nMEDIA:${mediaPath}`;

    try {
      render(<AgentWorkspace initialSession={existingSession} />);
      expect(await screen.findByText("Earlier answer.")).toBeInTheDocument();
      await user.type(screen.getByRole("textbox"), "Make an image");
      await user.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text: "Make an image",
        }),
      );

      act(() => {
        for (const handler of mocks.gatewayEventHandlers) {
          handler({
            type: "message.start",
            session_id: "runtime-session-1",
            payload: { message_id: "m1" },
          });
          handler({
            type: "message.delta",
            session_id: "runtime-session-1",
            payload: { message_id: "m1", delta: rawText },
          });
          handler({
            type: "message.complete",
            session_id: "runtime-session-1",
            payload: { message_id: "m1", text: rawText },
          });
        }
      });

      const liveTurn = (await screen.findByText("Here is the image.")).closest("article");
      expect(liveTurn).not.toBeNull();
      await user.click(
        within(liveTurn as HTMLElement).getByRole("button", {
          name: "Copy message",
        }),
      );

      expect(writeText).toHaveBeenLastCalledWith("Here is the image.");
    } finally {
      writeText.mockRestore();
    }
  });

  it("keeps turn actions inside the message row so hover reveal cannot move the transcript", async () => {
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

    render(<AgentWorkspace initialSession={existingSession} />);

    const userTurn = (await screen.findByText("Draft the launch plan")).closest("article");
    const assistantTurn = (await screen.findByText("Here is the launch plan.")).closest("article");

    // Both action rows are always-mounted DESCENDANTS of their message
    // article — never flow siblings in the timeline column that could open
    // the inter-turn gap. Out-of-flow positioning (absolute at 100% block
    // offset, opacity-only reveal) is the CSS contract pinned in
    // agent-turn-actions-css.test.ts; together the two tests guarantee the
    // reveal cannot change transcript spacing.
    for (const turn of [userTurn, assistantTurn]) {
      expect(turn).not.toBeNull();
      expect((turn as HTMLElement).querySelector(".agent-turn-actions")).not.toBeNull();
    }

    // The reveal itself is pure CSS (:hover flips opacity/pointer-events), so
    // hovering must not mutate the transcript DOM at all — there is no React
    // path that could insert or resize anything between messages.
    const timeline = (userTurn as HTMLElement).parentElement as HTMLElement;
    const observer = new MutationObserver(() => {});
    observer.observe(timeline, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    fireEvent.mouseOver(userTurn as HTMLElement);
    fireEvent.mouseOver(assistantTurn as HTMLElement);
    const mutations = observer.takeRecords();
    observer.disconnect();
    expect(mutations).toEqual([]);
  });

  it("resumes a torn-down runtime and retries when branching answers session not found", async () => {
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
    const branchTargets: string[] = [];
    mocks.gatewayRequest.mockImplementation((method: string, params?: { session_id?: string }) => {
      if (method === "session.branch") {
        branchTargets.push(params?.session_id ?? "");
        // Older Hermes pins may reject the stored id for session.branch, so the
        // workspace resumes and retries against the live runtime id.
        if (params?.session_id !== "runtime-fresh") {
          return Promise.reject(
            new Error('Hermes API returned 404 Not Found: {"detail":"Session not found"}'),
          );
        }
        return Promise.resolve({ new_session_id: "session-fork" });
      }
      if (method === "session.resume") {
        return Promise.resolve({
          session_id: params?.session_id === "session-fork" ? "runtime-fork" : "runtime-fresh",
        });
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();

    render(<AgentWorkspace initialSession={existingSession} />);

    const userTurn = (await screen.findByText("Draft the launch plan")).closest("article");
    expect(userTurn).not.toBeNull();
    await user.click(
      within(userTurn as HTMLElement).getByRole("button", {
        name: "Branch from here",
      }),
    );

    // Stored id first (no cached runtime), then resume, then the retry lands.
    await waitFor(() => expect(branchTargets).toEqual(["session-1", "runtime-fresh"]));
    expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.resume", {
      session_id: "session-1",
      cols: 96,
    });
    // The fork opened instead of surfacing the raw 404.
    expect(await screen.findByText(/Branched from/)).toBeInTheDocument();
  });

  it("does not resume a branch source owned by another surface's Agent run", async () => {
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
    const branchTargets: string[] = [];
    mocks.gatewayRequest.mockImplementation((method: string, params?: { session_id?: string }) => {
      if (method === "session.branch") {
        branchTargets.push(params?.session_id ?? "");
        if (params?.session_id === "session-1") {
          return Promise.reject(
            new Error('Hermes API returned 404 Not Found: {"detail":"Session not found"}'),
          );
        }
        return Promise.resolve({ new_session_id: "session-fork" });
      }
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-stolen" });
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    let releaseEarlierDispatch: () => void = () => undefined;
    const earlierDispatch = reserveHermesSessionDispatch("session-1").run(
      () =>
        new Promise<void>((resolve) => {
          releaseEarlierDispatch = resolve;
        }),
    );

    render(<AgentWorkspace initialSession={existingSession} />);

    const answerTurn = (await screen.findByText("Here is the launch plan.")).closest("article");
    expect(answerTurn).not.toBeNull();
    await user.click(
      within(answerTurn as HTMLElement).getByRole("button", {
        name: "Branch from here",
      }),
    );

    await waitFor(() => expect(branchTargets).toEqual(["session-1"]));
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("session.resume", {
      session_id: "session-1",
      cols: 96,
    });
    mocks.agentRunMonitorSnapshot.mockReturnValue({
      generation: 9,
      runtimeSessionId: "runtime-note-chat",
      fullMode: false,
      phase: "active",
    });
    releaseEarlierDispatch();
    await earlierDispatch;

    expect(
      await screen.findByText(/June is still working on the previous message/),
    ).toBeInTheDocument();
    expect(branchTargets).toEqual(["session-1"]);
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("session.resume", {
      session_id: "session-1",
      cols: 96,
    });
  });

  it("ignores duplicate branch clicks while the first fork is still in flight", async () => {
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
    let resolveBranch: ((value: { new_session_id: string }) => void) | undefined;
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.branch") {
        return new Promise<{ new_session_id: string }>((resolve) => {
          resolveBranch = resolve;
        });
      }
      return Promise.resolve({});
    });

    render(<AgentWorkspace initialSession={existingSession} />);

    const answerTurn = (await screen.findByText("Here is the launch plan.")).closest("article");
    expect(answerTurn).not.toBeNull();
    const branchButton = within(answerTurn as HTMLElement).getByRole("button", {
      name: "Branch from here",
    });
    fireEvent.click(branchButton);
    fireEvent.click(branchButton);

    await waitFor(() => expect(mocks.gatewayRequest).toHaveBeenCalledTimes(1));
    const actionRow = (answerTurn as HTMLElement).querySelector(".agent-turn-actions");
    expect(actionRow).toHaveAttribute("data-branching", "true");
    expect(
      within(answerTurn as HTMLElement).getByRole("button", { name: "Copy message" }),
    ).toBeInTheDocument();
    expect(
      within(answerTurn as HTMLElement).getByRole("button", { name: "Creating branch" }),
    ).toBeDisabled();
    expect(await screen.findByText("Creating branch from Existing session")).toBeInTheDocument();
    expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.branch", {
      session_id: "session-1",
      from_message_id: "a1",
    });
    resolveBranch?.({ new_session_id: "session-fork" });
    expect(await screen.findByText(/Branched from/)).toBeInTheDocument();
  });

  it("does not leak raw session-not-found errors when a stale session cannot branch", async () => {
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
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.branch" || method === "session.resume") {
        return Promise.reject(
          new Error('Hermes API returned 404 Not Found: {"detail":"Session not found"}'),
        );
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();

    render(<AgentWorkspace initialSession={existingSession} />);

    const answerTurn = (await screen.findByText("Here is the launch plan.")).closest("article");
    expect(answerTurn).not.toBeNull();
    await user.click(
      within(answerTurn as HTMLElement).getByRole("button", {
        name: "Branch from here",
      }),
    );

    expect(
      await screen.findByText(/Cannot branch from this message because the live session ended/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/session not found/i)).not.toBeInTheDocument();
  });

  it("branches from the first user message with an empty transcript and prefilled composer", async () => {
    const sourceMessages = [
      {
        id: "u1",
        role: "user",
        content: "Hi",
        timestamp: "2026-06-12T10:00:00Z",
      },
      {
        id: "a1",
        role: "assistant",
        content: "Hello! I'm June.",
        timestamp: "2026-06-12T10:00:05Z",
      },
      {
        id: "u2",
        role: "user",
        content: "What is the weather in Poland today?",
        timestamp: "2026-06-12T10:01:00Z",
      },
      {
        id: "a2",
        role: "assistant",
        content: "It is sunny in Warsaw.",
        timestamp: "2026-06-12T10:01:05Z",
      },
    ];
    let branchMessages = sourceMessages;
    mocks.listHermesSessionMessages.mockImplementation((sessionId: string) => {
      if (sessionId === "session-1") return Promise.resolve(sourceMessages);
      if (sessionId === "session-fork") return Promise.resolve(branchMessages);
      return Promise.resolve([]);
    });
    mocks.finalizeHermesBridgeBranch.mockImplementation(async () => {
      branchMessages = [];
      return {
        branchSessionId: "session-fork",
        keptMessageCount: 0,
        removedMessageCount: sourceMessages.length,
      };
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.branch") {
        return Promise.resolve({ new_session_id: "session-fork" });
      }
      if (method === "session.resume") {
        return Promise.reject(
          new Error('Hermes API returned 404 Not Found: {"detail":"Session not found"}'),
        );
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();

    render(<AgentWorkspace initialSession={existingSession} />);

    const firstPromptTurn = (await screen.findByText("Hi")).closest("article");
    expect(firstPromptTurn).not.toBeNull();
    await user.click(
      within(firstPromptTurn as HTMLElement).getByRole("button", {
        name: "Branch from here",
      }),
    );

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.branch", {
        session_id: "session-1",
      }),
    );
    expect(mocks.finalizeHermesBridgeBranch).toHaveBeenCalledWith({
      branchSessionId: "session-fork",
      sourceSessionId: "session-1",
      keepMessageCount: 0,
    });
    expect(await screen.findByText(/Branched from/)).toBeInTheDocument();
    expect(screen.queryByText("Hello! I'm June.")).not.toBeInTheDocument();
    expect(screen.queryByText("What is the weather in Poland today?")).not.toBeInTheDocument();
    expect(screen.queryByText("It is sunny in Warsaw.")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("textbox").textContent ?? "").toContain("Hi"));
    expect(screen.queryByText("session not found")).not.toBeInTheDocument();
  });

  it("branches from a user message by keeping prior context and prefilling that message", async () => {
    const sourceMessages = [
      {
        id: "u1",
        role: "user",
        content: "Hi",
        timestamp: "2026-06-12T10:00:00Z",
      },
      {
        id: "a1",
        role: "assistant",
        content: "Hello! I'm June.",
        timestamp: "2026-06-12T10:00:05Z",
      },
      {
        id: "u2",
        role: "user",
        content: "What is the weather in Poland today?",
        timestamp: "2026-06-12T10:01:00Z",
      },
      {
        id: "a2",
        role: "assistant",
        content: "It is sunny in Warsaw.",
        timestamp: "2026-06-12T10:01:05Z",
      },
    ];
    mocks.listHermesSessionMessages.mockImplementation((sessionId: string) => {
      if (sessionId === "session-1") return Promise.resolve(sourceMessages);
      if (sessionId === "session-fork") return Promise.reject(new Error("session not found"));
      return Promise.resolve([]);
    });
    mocks.gatewayRequest.mockImplementation((method: string, _params?: { session_id?: string }) => {
      if (method === "session.branch") {
        return Promise.resolve({ new_session_id: "session-fork" });
      }
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();

    render(<AgentWorkspace initialSession={existingSession} />);

    const promptTurn = (await screen.findByText("What is the weather in Poland today?")).closest(
      "article",
    );
    expect(promptTurn).not.toBeNull();
    await user.click(
      within(promptTurn as HTMLElement).getByRole("button", {
        name: "Branch from here",
      }),
    );

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.branch", {
        session_id: "session-1",
        from_message_id: "a1",
      }),
    );
    expect(mocks.finalizeHermesBridgeBranch).toHaveBeenCalledWith({
      branchSessionId: "session-fork",
      sourceSessionId: "session-1",
      throughMessageId: "a1",
      keepMessageCount: 2,
    });
    expect(await screen.findByText(/Branched from/)).toBeInTheDocument();
    expect(screen.getByText("Hi")).toBeInTheDocument();
    expect(screen.getByText("Hello! I'm June.")).toBeInTheDocument();
    expect(screen.queryByText("It is sunny in Warsaw.")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("textbox").textContent ?? "").toContain(
        "What is the weather in Poland today?",
      ),
    );
    expect(screen.queryByText("session not found")).not.toBeInTheDocument();
  });

  it("finalizes an earlier assistant branch before later source messages can leak in", async () => {
    const sourceMessages = [
      {
        id: "u1",
        role: "user",
        content: "I want to use GLM5.2, what providers can I use?",
        timestamp: "2026-07-02T12:31:00Z",
      },
      {
        id: "a-empty",
        role: "assistant",
        content: "",
        timestamp: "2026-07-02T12:31:01Z",
      },
      {
        id: "tool-1",
        role: "tool",
        content: "web results",
        timestamp: "2026-07-02T12:31:02Z",
      },
      {
        id: "a1",
        role: "assistant",
        content: "Here are the providers for GLM 5.2.",
        timestamp: "2026-07-02T12:31:05Z",
      },
      {
        id: "u2",
        role: "user",
        content: "I want to use it for coding. So Venice is not the cheapest option here",
        timestamp: "2026-07-02T12:33:00Z",
      },
      {
        id: "a2",
        role: "assistant",
        content: "For coding specifically, there are cheaper options.",
        timestamp: "2026-07-02T12:33:05Z",
      },
    ];
    let branchMessages = sourceMessages;
    mocks.listHermesSessionMessages.mockImplementation((sessionId: string) => {
      if (sessionId === "session-1") return Promise.resolve(sourceMessages);
      if (sessionId === "session-fork") return Promise.resolve(branchMessages);
      return Promise.resolve([]);
    });
    mocks.finalizeHermesBridgeBranch.mockImplementation(async () => {
      branchMessages = sourceMessages.slice(0, 4);
      return {
        branchSessionId: "session-fork",
        keptMessageCount: 4,
        removedMessageCount: 2,
      };
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.branch") {
        return Promise.resolve({ new_session_id: "session-fork" });
      }
      if (method === "session.resume") {
        return Promise.reject(
          new Error('Hermes API returned 404 Not Found: {"detail":"Session not found"}'),
        );
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();

    render(<AgentWorkspace initialSession={existingSession} />);

    const firstAnswerTurn = (
      await screen.findByText("Here are the providers for GLM 5.2.")
    ).closest("article");
    expect(firstAnswerTurn).not.toBeNull();
    await user.click(
      within(firstAnswerTurn as HTMLElement).getByRole("button", {
        name: "Branch from here",
      }),
    );

    await waitFor(() =>
      expect(mocks.finalizeHermesBridgeBranch).toHaveBeenCalledWith({
        branchSessionId: "session-fork",
        sourceSessionId: "session-1",
        throughMessageId: "a1",
        keepMessageCount: 4,
      }),
    );
    expect(await screen.findByText(/Branched from/)).toBeInTheDocument();
    expect(screen.getByText("I want to use GLM5.2, what providers can I use?")).toBeInTheDocument();
    expect(screen.getByText("Here are the providers for GLM 5.2.")).toBeInTheDocument();
    expect(screen.queryByText(/Venice is not the cheapest option/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/cheaper options/i)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveFocus());
    expect(screen.getByRole("textbox").textContent?.trim()).toBe("");

    await user.type(screen.getByRole("textbox"), "Nice, can I use Venice for coding?");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "session-fork",
        text: "Nice, can I use Venice for coding?",
      }),
    );
    expect(screen.queryByText(/This session is no longer available/i)).not.toBeInTheDocument();
  });

  it("does not broadcast a locally titled duplicate branch before the persisted fork loads", async () => {
    const sourceMessages = [
      {
        id: "u1",
        role: "user",
        content: "I want to use GLM5.2, what providers can I use?",
        timestamp: "2026-07-02T12:31:00Z",
      },
      {
        id: "a1",
        role: "assistant",
        content: "Here are the providers for GLM 5.2.",
        timestamp: "2026-07-02T12:31:05Z",
      },
    ];
    const persistedFork = {
      id: "session-fork",
      title: "Use It for Coding #5",
      preview: "Here are the providers for GLM 5.2.",
      started_at: "2026-07-02T13:37:33Z",
      message_count: 2,
    };
    const sourceSession = {
      ...existingSession,
      title: "Use It for Coding #4",
      started_at: "2026-07-02T12:57:19Z",
    };
    let resolveBranchLoad: ((sessions: (typeof persistedFork)[]) => void) | undefined;
    const branchLoad = new Promise<(typeof persistedFork)[]>((resolve) => {
      resolveBranchLoad = resolve;
    });
    let sessionListCalls = 0;
    mocks.listHermesSessions.mockImplementation(() => {
      sessionListCalls += 1;
      if (sessionListCalls === 1) return Promise.resolve([sourceSession]);
      return branchLoad;
    });
    mocks.listHermesSessionMessages.mockImplementation((sessionId: string) => {
      if (sessionId === "session-1" || sessionId === "session-fork") {
        return Promise.resolve(sourceMessages);
      }
      return Promise.resolve([]);
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.branch") {
        return Promise.resolve({ new_session_id: "session-fork" });
      }
      if (method === "session.resume") {
        return Promise.reject(
          new Error('Hermes API returned 404 Not Found: {"detail":"Session not found"}'),
        );
      }
      return Promise.resolve({});
    });
    const events: AgentSessionsChangedDetail[] = [];
    const listener = (event: Event) => {
      events.push((event as CustomEvent<AgentSessionsChangedDetail>).detail);
    };
    window.addEventListener(AGENT_SESSIONS_CHANGED_EVENT, listener);
    const user = userEvent.setup();

    try {
      render(<AgentWorkspace initialSession={sourceSession} />);

      const firstAnswerTurn = (
        await screen.findByText("Here are the providers for GLM 5.2.")
      ).closest("article");
      expect(firstAnswerTurn).not.toBeNull();
      await waitFor(() =>
        expect(
          events.some((event) => event.sessions.some((session) => session.id === "session-1")),
        ).toBe(true),
      );

      await user.click(
        within(firstAnswerTurn as HTMLElement).getByRole("button", {
          name: "Branch from here",
        }),
      );

      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.branch", {
          session_id: "session-1",
          from_message_id: "a1",
        }),
      );
      await waitFor(() =>
        expect(events.some((event) => event.selectedSessionId === "session-fork")).toBe(true),
      );
      expect(
        events
          .filter((event) => event.selectedSessionId === "session-fork")
          .some((event) => event.sessions.some((session) => session.id === "session-fork")),
      ).toBe(false);

      resolveBranchLoad?.([persistedFork]);

      await waitFor(() =>
        expect(
          events.some(
            (event) =>
              event.sessions.filter((session) => session.id === "session-fork").length === 1 &&
              event.sessions.find((session) => session.id === "session-fork")?.title ===
                "Use It for Coding #5",
          ),
        ).toBe(true),
      );
    } finally {
      window.removeEventListener(AGENT_SESSIONS_CHANGED_EVENT, listener);
    }
  });

  it("branches from an assistant message with the full transcript and an empty focused composer", async () => {
    const sourceMessages = [
      {
        id: "u1",
        role: "user",
        content: "Hi",
        timestamp: "2026-06-12T10:00:00Z",
      },
      {
        id: "a1",
        role: "assistant",
        content: "Hello! I'm June.",
        timestamp: "2026-06-12T10:00:05Z",
      },
      {
        id: "u2",
        role: "user",
        content: "What is the weather in Poland today?",
        timestamp: "2026-06-12T10:01:00Z",
      },
      {
        id: "a2",
        role: "assistant",
        content: "It is sunny in Warsaw.",
        timestamp: "2026-06-12T10:01:05Z",
      },
    ];
    mocks.listHermesSessionMessages.mockImplementation((sessionId: string) => {
      if (sessionId === "session-1") return Promise.resolve(sourceMessages);
      if (sessionId === "session-fork") return Promise.reject(new Error("session not found"));
      return Promise.resolve([]);
    });
    mocks.gatewayRequest.mockImplementation((method: string, _params?: { session_id?: string }) => {
      if (method === "session.branch") {
        return Promise.resolve({ new_session_id: "session-fork" });
      }
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();

    render(<AgentWorkspace initialSession={existingSession} />);

    const answerTurn = (await screen.findByText("It is sunny in Warsaw.")).closest("article");
    expect(answerTurn).not.toBeNull();
    await user.click(
      within(answerTurn as HTMLElement).getByRole("button", {
        name: "Branch from here",
      }),
    );

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.branch", {
        session_id: "session-1",
        from_message_id: "a2",
      }),
    );
    expect(await screen.findByText(/Branched from/)).toBeInTheDocument();
    expect(screen.getByText("What is the weather in Poland today?")).toBeInTheDocument();
    expect(screen.getByText("It is sunny in Warsaw.")).toBeInTheDocument();
    const composer = screen.getByRole("textbox");
    await waitFor(() => expect(composer).toHaveFocus());
    expect(composer.textContent?.trim()).toBe("");
    expect(screen.queryByText("session not found")).not.toBeInTheDocument();
  });

  it("branches from a pending user prompt during a live response without carrying the source stream", async () => {
    const sourceMessages = [
      {
        id: "u1",
        role: "user",
        content: "Hi",
        timestamp: "2026-06-12T10:00:00Z",
      },
      {
        id: "a1",
        role: "assistant",
        content: "Hello! I'm June.",
        timestamp: "2026-06-12T10:00:05Z",
      },
    ];
    mocks.listHermesSessionMessages.mockImplementation((sessionId: string) => {
      if (sessionId === "session-1") return Promise.resolve(sourceMessages);
      if (sessionId === "session-fork") return Promise.reject(new Error("session not found"));
      return Promise.resolve([]);
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "session.branch") {
        return Promise.resolve({ new_session_id: "session-fork" });
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();

    render(<AgentWorkspace initialSession={existingSession} />);

    expect(await screen.findByText("Hello! I'm June.")).toBeInTheDocument();
    const composer = screen.getByRole("textbox");
    await user.type(composer, "What is the weather in SF?");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "What is the weather in SF?",
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "message.start",
          session_id: "runtime-session-1",
          payload: { message_id: "m1" },
        });
        handler({
          type: "message.delta",
          session_id: "runtime-session-1",
          payload: { message_id: "m1", delta: "Same live answer" },
        });
      }
    });
    expect(await screen.findByText("Same live answer")).toBeInTheDocument();

    const pendingPromptTurn = screen.getByText("What is the weather in SF?").closest("article");
    expect(pendingPromptTurn).not.toBeNull();
    await user.click(
      within(pendingPromptTurn as HTMLElement).getByRole("button", {
        name: "Branch from here",
      }),
    );

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.branch", {
        session_id: "session-1",
        from_message_id: "a1",
      }),
    );
    expect(await screen.findByText(/Branched from/)).toBeInTheDocument();
    expect(screen.getByText("Hi")).toBeInTheDocument();
    expect(screen.getByText("Hello! I'm June.")).toBeInTheDocument();
    expect(screen.queryByText("Same live answer")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("textbox").textContent ?? "").toContain("What is the weather in SF?"),
    );
    expect(screen.queryByText("session not found")).not.toBeInTheDocument();
  });

  it("branches from a live assistant response at the saved context with an empty focused composer", async () => {
    const sourceMessages = [
      {
        id: "u1",
        role: "user",
        content: "Hi",
        timestamp: "2026-06-12T10:00:00Z",
      },
      {
        id: "a1",
        role: "assistant",
        content: "Hello! I'm June.",
        timestamp: "2026-06-12T10:00:05Z",
      },
    ];
    mocks.listHermesSessionMessages.mockImplementation((sessionId: string) => {
      if (sessionId === "session-1") return Promise.resolve(sourceMessages);
      if (sessionId === "session-fork") return Promise.reject(new Error("session not found"));
      return Promise.resolve([]);
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "session.branch") {
        return Promise.resolve({ new_session_id: "session-fork" });
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();

    render(<AgentWorkspace initialSession={existingSession} />);

    expect(await screen.findByText("Hello! I'm June.")).toBeInTheDocument();
    const composer = screen.getByRole("textbox");
    await user.type(composer, "What is the weather in SF?");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "What is the weather in SF?",
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "message.start",
          session_id: "runtime-session-1",
          payload: { message_id: "m1" },
        });
        handler({
          type: "message.delta",
          session_id: "runtime-session-1",
          payload: { message_id: "m1", delta: "Same live answer" },
        });
      }
    });
    expect(await screen.findByText("Same live answer")).toBeInTheDocument();

    const liveAnswerTurn = screen.getByText("Same live answer").closest("article");
    expect(liveAnswerTurn).not.toBeNull();
    await user.click(
      within(liveAnswerTurn as HTMLElement).getByRole("button", {
        name: "Branch from here",
      }),
    );

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.branch", {
        session_id: "session-1",
        from_message_id: "a1",
      }),
    );
    expect(await screen.findByText(/Branched from/)).toBeInTheDocument();
    expect(screen.getByText("Hi")).toBeInTheDocument();
    expect(screen.getByText("Hello! I'm June.")).toBeInTheDocument();
    expect(screen.queryByText("Same live answer")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveFocus());
    expect(screen.getByRole("textbox").textContent?.trim()).toBe("");
    expect(screen.queryByText("session not found")).not.toBeInTheDocument();
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

  it.each([
    ["routine description", "Set up a weekday summary of my unread notes"],
    ["bundle chat", "/release-check prepare this repository for release"],
  ])("preserves a blocked %s prompt as a draft", async (_entryPoint, prompt) => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({
        createdAt: Date.now(),
        prompt,
      }),
    );

    render(
      <AgentWorkspace creditActionsDisabledReason="Add credits to send messages or generate images and videos." />,
    );

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Message June" })).toHaveTextContent(prompt),
    );
    expect(window.sessionStorage.getItem("june:agent:new-session-draft")).toContain(prompt);
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("session.create", expect.anything());
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", expect.anything());
  });

  it("preserves a blocked dictated prompt as a draft", async () => {
    const prompt = "Summarize the launch plan";

    render(
      <AgentWorkspace creditActionsDisabledReason="Add credits to send messages or generate images and videos." />,
    );
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_NEW_SESSION_EVENT, {
          detail: { prompt },
        }),
      );
    });

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Message June" })).toHaveTextContent(prompt),
    );
    expect(window.sessionStorage.getItem("june:agent:new-session-draft")).toContain(prompt);
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("session.create", expect.anything());
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", expect.anything());
  });

  it.each([
    {
      command: "/image a red bicycle",
      entry: "runImageSlashCommand" as const,
      generationCall: () => mocks.generateImage,
    },
    {
      command: "/video a red bicycle",
      entry: "runVideoSlashCommand" as const,
      generationCall: () => mocks.videoGenerate,
    },
  ])("blocks the direct $entry fast-path entry when credit actions are disabled", async (test) => {
    const reason = "Add credits to send messages or generate images and videos.";
    const slashCommandEntriesRef: {
      current: {
        runImageSlashCommand: (argument: string, commandText: string) => Promise<void>;
        runVideoSlashCommand: (argument: string, commandText: string) => Promise<void>;
      } | null;
    } = { current: null };
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now() }),
    );

    render(
      <AgentWorkspace
        creditActionsDisabledReason={reason}
        testOnlySlashCommandEntriesRef={slashCommandEntriesRef}
      />,
    );
    expect(await screen.findByText(HERO_GREETING)).toBeInTheDocument();
    mocks.gatewayRequest.mockClear();
    test.generationCall().mockClear();

    const entries = slashCommandEntriesRef.current;
    if (!entries) throw new Error("Agent workspace did not expose its slash-command entries.");
    await act(async () => {
      await entries[test.entry]("a red bicycle", test.command);
    });

    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("session.create", expect.anything());
    expect(test.generationCall()).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(reason);
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

    expect(mocks.stopAgentRunMonitoring).toHaveBeenCalledWith("session-2", 1, expect.any(Function));
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("session.interrupt", expect.anything());
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
    mocks.stopAgentRunMonitoring.mockReturnValue(false);
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

  it("keeps one thinking shimmer mounted until visible response content arrives", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({
        createdAt: Date.now(),
        prompt: "summarize the current page",
      }),
    );

    render(<AgentWorkspace />);

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "summarize the current page",
      }),
    );
    const indicator = await screen.findByText("Thinking…");
    expect(indicator).toHaveClass("text-shimmer", "shimmer");

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "message.start",
          session_id: "runtime-session-2",
          payload: { message_id: "live-response" },
        });
      }
    });

    expect(screen.getAllByText("Thinking…")).toHaveLength(1);
    expect(screen.getByText("Thinking…")).toBe(indicator);

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "message.delta",
          session_id: "runtime-session-2",
          payload: { delta: "Here is the summary." },
        });
      }
    });

    expect(screen.getByText("Here is the summary.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Thinking…")).toBeNull());
  });

  it("keeps the same markdown node when persisted reasoning hydrates an identified live answer", async () => {
    let persistedMessages: Array<{
      id: string;
      role: "assistant";
      content: string;
      reasoning: string;
      timestamp: string;
    }> = [];
    mocks.listHermesSessionMessages.mockImplementation(async () => persistedMessages);
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), prompt: "inspect the renderer" }),
    );

    vi.useFakeTimers();
    try {
      render(<AgentWorkspace />);
      await settleUnderFakeTimers(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-2",
          text: "inspect the renderer",
        }),
      );

      act(() => {
        for (const handler of mocks.gatewayEventHandlers) {
          handler({
            type: "message.start",
            session_id: "runtime-session-2",
            payload: { message_id: "m1" },
          });
          handler({
            type: "message.delta",
            session_id: "runtime-session-2",
            payload: { message_id: "m1", delta: "Stable answer" },
          });
        }
      });
      await settleUnderFakeTimers(() =>
        expect(screen.getByText("Stable answer")).toBeInTheDocument(),
      );
      const firstMarkdown = screen.getByText("Stable answer").closest(".agent-markdown");
      expect(firstMarkdown).not.toBeNull();

      act(() => {
        for (const handler of mocks.gatewayEventHandlers) {
          handler({
            type: "message.complete",
            session_id: "runtime-session-2",
            payload: { message_id: "m1", text: "Stable answer complete" },
          });
        }
      });
      await settleUnderFakeTimers(() =>
        expect(screen.getByText("Stable answer complete")).toBeInTheDocument(),
      );
      const completedMarkdown = screen
        .getByText("Stable answer complete")
        .closest(".agent-markdown");
      expect(completedMarkdown).toBe(firstMarkdown);
      expect(completedMarkdown?.closest("article")).toHaveAttribute("data-status", "complete");

      persistedMessages = [
        {
          id: "m1",
          role: "assistant",
          content: "Stable answer complete plus",
          reasoning: "Checked the persisted result.",
          timestamp: "2026-06-04T10:00:01.000Z",
        },
      ];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      await settleUnderFakeTimers(() =>
        expect(screen.getByText("Stable answer complete plus")).toBeInTheDocument(),
      );

      expect(screen.getByText("Stable answer complete plus").closest(".agent-markdown")).toBe(
        firstMarkdown,
      );
    } finally {
      vi.useRealTimers();
    }
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
    expect(label.parentElement).toHaveClass("agent-reasoning-label-swap");
    expect(label.parentElement).toHaveAttribute("aria-hidden", "true");
    expect(details?.querySelector("summary")).toHaveAttribute("aria-label", "Thinking");

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
    expect(screen.getByText("Thought").parentElement).toHaveClass("agent-reasoning-label-swap");
    expect(screen.getByText("Thought").parentElement).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Thought").closest("summary")).toHaveAttribute("aria-label", "Thought");
    expect(screen.getByText("Thought").closest("details")).toHaveAttribute("open");

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "turn.completed",
          session_id: "runtime-session-2",
          payload: { status: "success" },
        });
      }
    });

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

  it("renders assistant text, tools, and reasoning in their canonical event order", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({
        createdAt: Date.now(),
        prompt: "inspect the project in order",
      }),
    );

    render(<AgentWorkspace />);

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "inspect the project in order",
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "message.start",
          session_id: "runtime-session-2",
          payload: { message_id: "m1" },
        });
        handler({
          type: "message.delta",
          session_id: "runtime-session-2",
          payload: { message_id: "m1", delta: "Opening result." },
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
        handler({
          type: "thinking.delta",
          session_id: "runtime-session-2",
          payload: { delta: "Checking the project state." },
        });
        handler({
          type: "tool.start",
          session_id: "runtime-session-2",
          payload: {
            tool_id: "tool-2",
            tool_name: "bash",
            command: "pnpm test",
          },
        });
        handler({
          type: "message.delta",
          session_id: "runtime-session-2",
          payload: { message_id: "m1", delta: "Middle result." },
        });
        handler({
          type: "thinking.delta",
          session_id: "runtime-session-2",
          payload: { delta: "Verifying the final state." },
        });
        handler({
          type: "message.delta",
          session_id: "runtime-session-2",
          payload: { message_id: "m1", delta: "Closing result." },
        });
      }
    });

    const opening = await screen.findByText("Opening result.");
    const middle = await screen.findByText("Middle result.");
    const closing = await screen.findByText("Closing result.");
    await waitFor(() => expect(document.querySelectorAll(".agent-tool-stack")).toHaveLength(2));
    await waitFor(() => expect(document.querySelectorAll(".agent-reasoning")).toHaveLength(2));
    const [firstTool, secondTool] = Array.from(
      document.querySelectorAll<HTMLElement>(".agent-tool-stack"),
    );
    const [firstThinking, secondThinking] = Array.from(
      document.querySelectorAll<HTMLElement>(".agent-reasoning"),
    );

    expect(firstTool).toHaveTextContent("Reading files");
    expect(secondTool).toHaveTextContent(/Running/);
    expect(firstThinking).toHaveTextContent("Checking the project state.");
    expect(secondThinking).toHaveTextContent("Verifying the final state.");
    expect(
      opening.compareDocumentPosition(firstTool as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      (firstTool as HTMLElement).compareDocumentPosition(firstThinking as HTMLElement) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      (firstThinking as HTMLElement).compareDocumentPosition(secondTool) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      (secondTool as HTMLElement).compareDocumentPosition(middle) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      middle.compareDocumentPosition(secondThinking as HTMLElement) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      (secondThinking as HTMLElement).compareDocumentPosition(closing) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("condenses long tool runs behind a count line while running rows stay visible (JUN-326)", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({
        createdAt: Date.now(),
        prompt: "audit the project",
      }),
    );

    render(<AgentWorkspace />);

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "audit the project",
      }),
    );

    const emit = (type: string, payload: Record<string, unknown>) => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({ type, session_id: "runtime-session-2", payload });
      }
    };

    act(() => {
      emit("tool.start", { tool_id: "tool-1", tool_name: "read_file", path: "notes.md" });
      emit("tool.complete", { tool_id: "tool-1", tool_name: "read_file", path: "notes.md" });
      emit("tool.start", { tool_id: "tool-2", tool_name: "bash", command: "./scripts/build.sh" });
      emit("tool.complete", {
        tool_id: "tool-2",
        tool_name: "bash",
        command: "./scripts/build.sh",
      });
      emit("tool.start", { tool_id: "tool-3", tool_name: "web_search", search_query: "june" });
      emit("tool.complete", {
        tool_id: "tool-3",
        tool_name: "web_search",
        search_query: "june",
      });
    });

    // At the threshold the stack still renders flat: three rows, no fold.
    expect(await screen.findByText("Reading files")).toBeInTheDocument();
    expect(screen.getByText("Running command")).toBeInTheDocument();
    expect(screen.getByText("Searching web")).toBeInTheDocument();
    expect(document.querySelector(".agent-tool-fold")).toBeNull();

    act(() => {
      emit("tool.start", { tool_id: "tool-4", tool_name: "fetch_url", url: "https://june.dev" });
      emit("tool.failed", {
        tool_id: "tool-4",
        tool_name: "fetch_url",
        url: "https://june.dev",
        text: "Request timed out.",
      });
      emit("tool.start", { tool_id: "tool-5", tool_name: "edit_file", path: "notes.md" });
    });

    // Past the threshold, the four settled calls fold behind one count line
    // that also carries the failed count; the fold starts collapsed.
    const foldName = await screen.findByText("4 actions");
    const fold = foldName.closest("details");
    expect(fold).toHaveClass("agent-tool-fold");
    expect(fold).not.toHaveAttribute("open");
    expect(within(fold as HTMLElement).getByText("1 failed")).toBeInTheDocument();

    // Settled rows (including the failure) live inside the fold and keep their
    // per-row status when expanded.
    expect(fold).toContainElement(screen.getByText("Reading files"));
    expect(fold).toContainElement(screen.getByText("Running command"));
    expect(fold).toContainElement(screen.getByText("Browsing"));
    expect(fold).toContainElement(screen.getByText("Failed"));

    // The running row stays outside the fold, spinner and all.
    const runningLabel = screen.getByText("Editing files");
    expect(fold).not.toContainElement(runningLabel);
    expect(runningLabel.closest(".agent-tool-stack")).toBeTruthy();
    expect(fold).not.toContainElement(screen.getByRole("status", { name: "Running" }));
  });

  it("holds space with a generation placeholder while an image tool runs and never paints streamed MEDIA text", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({
        createdAt: Date.now(),
        prompt: "make me a picture",
      }),
    );

    render(<AgentWorkspace />);

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "make me a picture",
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "message.start",
          session_id: "runtime-session-2",
        });
        // The pinned gateway announces the tool name while the model is still
        // streaming arguments, before execution has a stable tool id.
        handler({
          type: "tool.generating",
          session_id: "runtime-session-2",
          payload: {
            name: "generate_image",
          },
        });
        // Execution starts later with the stable id. This must promote the
        // early placeholder instead of opening a second canvas.
        handler({
          type: "tool.start",
          session_id: "runtime-session-2",
          payload: {
            tool_id: "tool-1",
            name: "generate_image",
            context: "a calm mountain lake at dawn",
          },
        });
        handler({
          type: "message.delta",
          session_id: "runtime-session-2",
          payload: {
            delta:
              "MEDIA:/Users/alex/Library/Application Support/June/generated-images/generated-ima",
          },
        });
      }
    });

    // The generation placeholder holds the image's slot while the tool runs.
    expect(await screen.findByRole("status", { name: "Generating image" })).toBeInTheDocument();
    expect(screen.getAllByRole("status", { name: "Generating image" })).toHaveLength(1);
    expect(screen.getByText("Generating image…")).toBeInTheDocument();
    expect(document.querySelector(".agent-generated-image-placeholder")).not.toBeNull();
    expect(document.querySelector("canvas.agent-generated-media-field")).not.toBeNull();
    expect(screen.getByText("Generating image…")).toHaveClass(
      "agent-generated-media-label",
      "text-shimmer",
      "shimmer",
    );
    expect(
      screen.getByText("Generating image…").closest(".agent-generated-media-status-bar"),
    ).not.toBeNull();
    expect(document.querySelector(".agent-generated-media-morph")).toBeNull();
    // The media canvas owns this running state, so the generic tool spinner is
    // neither painted nor announced alongside it.
    expect(screen.queryByRole("status", { name: "Running" })).not.toBeInTheDocument();
    // The raw MEDIA reference in the streamed delta never paints as prose
    // (regression: it used to show as a literal file line above the reply).
    expect(screen.queryByText(/MEDIA:/)).not.toBeInTheDocument();

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "lifecycle.complete",
          session_id: "runtime-session-2",
          payload: {},
        });
      }
    });
    // A terminal frame without message.complete must not reveal the raw delta
    // when it flips the accumulated text part from running to complete.
    expect(screen.queryByText(/MEDIA:/)).not.toBeInTheDocument();
    const mediaTurn = Array.from(document.querySelectorAll<HTMLElement>("article")).at(-1);
    expect(mediaTurn).toBeDefined();
    expect(
      within(mediaTurn as HTMLElement).queryByRole("button", { name: "Copy message" }),
    ).not.toBeInTheDocument();
  });

  it("keeps one placeholder per concurrent or subsequent image generation", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), prompt: "make three pictures" }),
    );
    render(<AgentWorkspace />);
    await waitFor(() => expect(mocks.gatewayRequest).toHaveBeenCalled());

    const emitToolStart = (toolId: string) => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "tool.start",
          session_id: "runtime-session-2",
          payload: { tool_id: toolId, tool_name: "generate_image" },
        });
      }
    };
    const emitToolComplete = (toolId: string, name: string, data: string) => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "tool.complete",
          session_id: "runtime-session-2",
          payload: {
            tool_id: toolId,
            tool_name: "generate_image",
            content: [
              { type: "image", data, mimeType: "image/png" },
              { type: "text", text: JSON.stringify({ filename: `${name}.png`, label: name }) },
            ],
          },
        });
      }
    };

    act(() => {
      emitToolStart("tool-1");
      emitToolStart("tool-2");
    });
    await waitFor(() =>
      expect(document.querySelectorAll(".agent-generated-image-placeholder")).toHaveLength(2),
    );

    act(() => emitToolComplete("tool-1", "first image", "Zmlyc3Q="));
    expect(await screen.findByRole("img", { name: "first image" })).toBeInTheDocument();
    expect(document.querySelectorAll(".agent-generated-image-placeholder")).toHaveLength(1);

    act(() => emitToolComplete("tool-2", "second image", "c2Vjb25k"));
    expect(await screen.findByRole("img", { name: "second image" })).toBeInTheDocument();
    expect(document.querySelector(".agent-generated-image-placeholder")).toBeNull();

    act(() => emitToolStart("tool-3"));
    await waitFor(() =>
      expect(document.querySelectorAll(".agent-generated-image-placeholder")).toHaveLength(1),
    );
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
    // The top-level Approve (approves once) and the scope menu's permanent
    // option are both live while the explanation is open.
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: /approve options/i }));
    expect(screen.getByRole("menuitem", { name: "Always approve" })).toBeEnabled();
    await user.keyboard("{Escape}");
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

  it("keeps approval cards on the runtime session while activity uses the stored session", async () => {
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
            request_id: "approval-runtime",
            description: "Security scan requires approval.",
            command: "npm run build",
            allow_permanent: true,
          },
        });
      }
    });

    expect(await screen.findByText("Approval required")).toBeInTheDocument();
    expect(hermesActivityStore.getRecord("runtime-session-2")).toBeUndefined();
    expect(hermesActivityStore.getRecord("session-2")?.phase).toBe("waiting");
    const [pendingRecord] = pendingActionStore.openRecords().filter((record) => {
      return record.requestId === "approval-runtime";
    });
    expect(pendingRecord?.sessionId).toBe("session-2");
    expect(
      pendingActionStore.openRecords().some((record) => record.sessionId === "runtime-session-2"),
    ).toBe(false);
    const projection = projectAgentActivityLevels(hermesActivityStore.getRecords());
    expect(projection.waitingSessionIds.has("session-2")).toBe(true);
    expect(projection.waitingSessionIds.has("runtime-session-2")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("approval.respond", {
        session_id: "runtime-session-2",
        request_id: "approval-runtime",
        choice: "once",
      }),
    );
    await waitFor(() =>
      expect(
        pendingActionStore.openRecords().some((record) => record.requestId === "approval-runtime"),
      ).toBe(false),
    );
    expect(hermesActivityStore.getRecord("session-2")?.phase).toBe("running");
  });

  it("keeps the session waiting until every distinct inbound approval resolves", async () => {
    const statusDetails: AgentSessionStatusDetail[] = [];
    const handleStatus = (event: Event) => {
      statusDetails.push((event as CustomEvent<AgentSessionStatusDetail>).detail);
    };
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), prompt: "connect Todoist" }),
    );
    render(<AgentWorkspace />);
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "connect Todoist",
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        for (const requestId of ["approval-a", "approval-b"]) {
          handler({
            type: "approval.request",
            session_id: "runtime-session-2",
            payload: {
              request_id: requestId,
              description: `Approve ${requestId}?`,
              allow_permanent: false,
            },
          });
        }
      }
    });

    expect(
      pendingActionStore
        .openRecords()
        .filter((record) => record.sessionId === "session-2" && record.action.kind === "approval"),
    ).toHaveLength(2);

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "approval.response",
          session_id: "runtime-session-2",
          payload: { request_id: "approval-a", choice: "once" },
        });
      }
    });

    expect(pendingActionStore.openRecords().map((record) => record.requestId)).toContain(
      "approval-b",
    );
    expect(pendingActionStore.openRecords().map((record) => record.requestId)).not.toContain(
      "approval-a",
    );
    expect(hermesActivityStore.getRecord("session-2")?.phase).toBe("waiting");
    expect(statusDetails.at(-1)).toEqual(
      expect.objectContaining({ sessionId: "session-2", status: "waitingForUser" }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "approval.response",
          session_id: "runtime-session-2",
          payload: { request_id: "approval-b", choice: "deny" },
        });
      }
    });

    expect(
      pendingActionStore.openRecords().some((record) => record.sessionId === "session-2"),
    ).toBe(false);
    expect(hermesActivityStore.getRecord("session-2")?.phase).toBe("running");
    expect(statusDetails.at(-1)).toEqual(
      expect.objectContaining({ sessionId: "session-2", status: "running" }),
    );
    window.removeEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
  });

  it("denies only the targeted approval and records the outcome", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), prompt: "connect Todoist" }),
    );
    render(<AgentWorkspace />);
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "connect Todoist",
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "approval.request",
          session_id: "runtime-session-2",
          payload: {
            request_id: "mcp-deny",
            description: "Connect Todoist?",
            allow_permanent: false,
          },
        });
      }
    });
    expect(await screen.findByText("Approval required")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Deny" }));

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("approval.respond", {
        session_id: "runtime-session-2",
        request_id: "mcp-deny",
        choice: "deny",
      }),
    );
    expect(await screen.findByText("Denied")).toBeInTheDocument();
    expect(pendingActionStore.openRecords().some((row) => row.requestId === "mcp-deny")).toBe(
      false,
    );
    expect(hermesActivityStore.getRecord("session-2")?.phase).toBe("running");
  });

  it("fails closed when a targeted approval is no longer pending", async () => {
    const statusDetails: AgentSessionStatusDetail[] = [];
    const handleStatus = (event: Event) => {
      statusDetails.push((event as CustomEvent<AgentSessionStatusDetail>).detail);
    };
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
    const user = userEvent.setup();
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.create") {
        return Promise.resolve({
          session_id: "runtime-session-2",
          stored_session_id: "session-2",
        });
      }
      if (method === "approval.respond") return Promise.resolve({ resolved: 0 });
      return Promise.resolve({});
    });
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), prompt: "connect Todoist" }),
    );
    render(<AgentWorkspace />);
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "connect Todoist",
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "approval.request",
          session_id: "runtime-session-2",
          payload: {
            request_id: "mcp-stale",
            description: "Connect Todoist?",
            allow_permanent: false,
          },
        });
      }
    });
    expect(await screen.findByText("Approval required")).toBeInTheDocument();
    expect(hermesActivityStore.getRecord("session-2")?.phase).toBe("waiting");
    await user.click(screen.getByRole("button", { name: "Approve" }));

    expect(await screen.findByText("Approval expired")).toBeInTheDocument();
    expect(
      await screen.findByText("This approval is no longer pending. June did not approve anything."),
    ).toBeInTheDocument();
    expect(pendingActionStore.openRecords().some((row) => row.requestId === "mcp-stale")).toBe(
      false,
    );
    expect(hermesActivityStore.getRecord("session-2")?.phase).toBe("running");
    expect(statusDetails.at(-1)).toEqual(
      expect.objectContaining({
        sessionId: "session-2",
        status: "running",
        summary: "June is working.",
      }),
    );
    window.removeEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
  });

  it.each([
    ["null", null],
    ["empty", {}],
    ["invalid", { resolved: 2 }],
  ])("keeps an approval pending when the gateway response is malformed: %s", async (responseKind, gatewayResponse) => {
    const requestId = `mcp-indeterminate-${responseKind}`;
    const user = userEvent.setup();
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.create") {
        return Promise.resolve({
          session_id: "runtime-session-2",
          stored_session_id: "session-2",
        });
      }
      if (method === "approval.respond") return Promise.resolve(gatewayResponse);
      return Promise.resolve({});
    });
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), prompt: "connect Todoist" }),
    );
    render(<AgentWorkspace />);
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "connect Todoist",
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "approval.request",
          session_id: "runtime-session-2",
          payload: {
            request_id: requestId,
            description: "Connect Todoist?",
            allow_permanent: false,
          },
        });
      }
    });
    expect(await screen.findByText("Approval required")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Approve" }));

    expect(
      await screen.findByText(
        "June could not confirm the approval outcome. Reconnect, then try again.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Approval expired")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled());
    expect(pendingActionStore.openRecords().some((row) => row.requestId === requestId)).toBe(true);
  });

  it("retires a timed-out approval without approving it", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), prompt: "connect Todoist" }),
    );
    render(<AgentWorkspace />);
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "connect Todoist",
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "approval.request",
          session_id: "runtime-session-2",
          payload: {
            request_id: "mcp-expired",
            description: "Connect Todoist?",
            allow_permanent: false,
          },
        });
      }
    });
    expect(await screen.findByText("Approval required")).toBeInTheDocument();

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "approval.expire",
          session_id: "runtime-session-2",
          payload: { request_id: "mcp-expired", reason: "timeout" },
        });
      }
    });

    expect(await screen.findByText("Approval expired")).toBeInTheDocument();
    expect(screen.getByText(/June did not approve anything/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(pendingActionStore.openRecords().some((row) => row.requestId === "mcp-expired")).toBe(
      false,
    );
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("approval.respond", expect.anything());
  });

  it("retires an approval across an unexpected close and does not reopen its replay", async () => {
    const statusDetails: AgentSessionStatusDetail[] = [];
    const handleStatus = (event: Event) => {
      statusDetails.push((event as CustomEvent<AgentSessionStatusDetail>).detail);
    };
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), prompt: "connect Todoist" }),
    );
    render(<AgentWorkspace />);
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "connect Todoist",
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "approval.request",
          session_id: "runtime-session-2",
          payload: {
            request_id: "mcp-reconnect",
            description: "Connect Todoist?",
            allow_permanent: false,
          },
        });
      }
    });
    expect(await screen.findByText("Approval required")).toBeInTheDocument();
    expect(hermesActivityStore.getRecord("session-2")?.phase).toBe("waiting");

    act(() => {
      for (const handler of [...mocks.gatewayCloseHandlers]) handler();
    });
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.resume", {
        session_id: "session-2",
        cols: 96,
      }),
    );
    expect(await screen.findByText("Approval expired")).toBeInTheDocument();
    expect(hermesActivityStore.getRecord("session-2")?.phase).toBe("running");
    expect(statusDetails).toContainEqual(
      expect.objectContaining({
        sessionId: "session-2",
        status: "running",
        summary: "June is working.",
      }),
    );
    const activityProjection = projectAgentActivityLevels(hermesActivityStore.getRecords());
    expect(activityProjection.waitingSessionIds.has("session-2")).toBe(false);
    expect(activityProjection.workingSessionIds.has("session-2")).toBe(true);
    const statusCountBeforeReplay = statusDetails.length;

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "approval.request",
          session_id: "runtime-session-1",
          payload: {
            request_id: "mcp-reconnect",
            description: "Connect Todoist?",
            allow_permanent: false,
          },
        });
      }
    });

    expect(screen.getAllByText("Approval expired")).toHaveLength(1);
    expect(screen.queryByText("Approval required")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(pendingActionStore.openRecords().some((row) => row.requestId === "mcp-reconnect")).toBe(
      false,
    );
    expect(hermesActivityStore.getRecord("session-2")?.phase).toBe("running");
    expect(
      statusDetails
        .slice(statusCountBeforeReplay)
        .some((detail) => detail.sessionId === "session-2" && detail.status === "waitingForUser"),
    ).toBe(false);
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("approval.respond", expect.anything());
    window.removeEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
  });

  it("retires a repeated legacy approval from the later Agent run on disconnect", async () => {
    const user = userEvent.setup();
    const approvalPayload = {
      description: "Connect Todoist?",
      allow_permanent: false,
    };
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), prompt: "connect Todoist" }),
    );
    render(<AgentWorkspace />);
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "connect Todoist",
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "approval.request",
          session_id: "runtime-session-2",
          payload: approvalPayload,
        });
      }
    });
    expect(await screen.findByText("Approval required")).toBeInTheDocument();
    const firstRecord = pendingActionStore
      .openRecords()
      .find((record) => record.action.kind === "approval");
    expect(firstRecord?.requestId).toMatch(/^legacy:approval\.request:/);

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "turn.completed",
          session_id: "runtime-session-2",
          payload: { status: "success" },
        });
      }
    });
    expect(await screen.findByText("Approval expired")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox"), "connect Todoist again");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "connect Todoist again",
      }),
    );
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "approval.request",
          session_id: "runtime-session-2",
          payload: approvalPayload,
        });
      }
    });

    expect(await screen.findByText("Approval required")).toBeInTheDocument();
    const secondRecord = pendingActionStore
      .openRecords()
      .find((record) => record.requestId === firstRecord?.requestId);
    expect(secondRecord?.approvalRunEpoch).not.toBe(firstRecord?.approvalRunEpoch);

    act(() => {
      for (const close of [...mocks.gatewayCloseHandlers]) close();
    });

    await waitFor(() => expect(screen.getAllByText("Approval expired")).toHaveLength(2));
    expect(screen.queryByText("Approval required")).toBeNull();
    expect(
      pendingActionStore
        .openRecords()
        .some((record) => record.requestId === firstRecord?.requestId),
    ).toBe(false);
  });

  it("keeps a later legacy approval actionable while the prior run response settles", async () => {
    const user = userEvent.setup();
    const approvalPayload = {
      description: "Connect Todoist?",
      allow_permanent: false,
    };
    let resolveFirstResponse: ((value: { resolved: number }) => void) | undefined;
    let approvalResponseCount = 0;
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.create") {
        return Promise.resolve({
          session_id: "runtime-session-2",
          stored_session_id: "session-2",
        });
      }
      if (method === "approval.respond") {
        approvalResponseCount += 1;
        if (approvalResponseCount === 1) {
          return new Promise((resolve) => {
            resolveFirstResponse = resolve;
          });
        }
        return Promise.resolve({ resolved: 1 });
      }
      return Promise.resolve({});
    });
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), prompt: "connect Todoist" }),
    );
    render(<AgentWorkspace />);
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "connect Todoist",
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "approval.request",
          session_id: "runtime-session-2",
          payload: approvalPayload,
        });
      }
    });
    await user.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(resolveFirstResponse).toBeTypeOf("function"));

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "turn.completed",
          session_id: "runtime-session-2",
          payload: { status: "success" },
        });
      }
    });
    expect(await screen.findByText("Approval expired")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox"), "connect Todoist again");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "connect Todoist again",
      }),
    );
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "approval.request",
          session_id: "runtime-session-2",
          payload: approvalPayload,
        });
      }
    });

    expect(await screen.findByRole("button", { name: "Approve" })).toBeEnabled();
    await act(async () => resolveFirstResponse?.({ resolved: 1 }));
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(approvalResponseCount).toBe(2));
    expect(await screen.findByText("Approved once")).toBeInTheDocument();
  });

  it("does not let a prior approval's late session-gone error scrub the later Agent run", async () => {
    const user = userEvent.setup();
    const approvalPayload = {
      description: "Connect Dropbox?",
      allow_permanent: false,
    };
    let rejectFirstResponse: ((error: Error) => void) | undefined;
    let approvalResponseCount = 0;
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.create") {
        return Promise.resolve({
          session_id: "runtime-session-2",
          stored_session_id: "session-2",
        });
      }
      if (method === "approval.respond") {
        approvalResponseCount += 1;
        if (approvalResponseCount === 1) {
          return new Promise((_resolve, reject) => {
            rejectFirstResponse = reject;
          });
        }
        return Promise.resolve({ resolved: 1 });
      }
      return Promise.resolve({});
    });
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), prompt: "connect Dropbox" }),
    );
    render(<AgentWorkspace />);
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "connect Dropbox",
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "approval.request",
          session_id: "runtime-session-2",
          payload: approvalPayload,
        });
      }
    });
    await user.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(rejectFirstResponse).toBeTypeOf("function"));

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "turn.completed",
          session_id: "runtime-session-2",
          payload: { status: "success" },
        });
      }
    });
    expect(await screen.findByText("Approval expired")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox"), "connect Dropbox again");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "connect Dropbox again",
      }),
    );
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "approval.request",
          session_id: "runtime-session-2",
          payload: approvalPayload,
        });
      }
    });

    const laterRecord = pendingActionStore
      .openRecords()
      .find((record) => record.action.kind === "approval");
    expect(laterRecord).toBeDefined();
    expect(await screen.findByRole("button", { name: "Approve" })).toBeEnabled();
    await act(async () =>
      rejectFirstResponse?.(
        new Error('Hermes API returned 404 Not Found: {"detail":"Session not found"}'),
      ),
    );

    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(
      pendingActionStore
        .openRecords()
        .some((record) => record.instanceId === laterRecord?.instanceId),
    ).toBe(true);
    expect(
      screen.queryByText("This session has ended, so the request can no longer be answered."),
    ).toBeNull();
  });

  it("answers an inline approval after its bounded pending-store projection is evicted", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), prompt: "connect the cap test provider" }),
    );
    render(<AgentWorkspace />);
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "connect the cap test provider",
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "approval.request",
          session_id: "runtime-session-2",
          payload: {
            request_id: "mcp-inline-store-evicted",
            description: "Connect the cap test provider?",
            allow_permanent: false,
          },
        });
      }
    });
    expect(await screen.findByRole("button", { name: "Approve" })).toBeEnabled();
    expect(
      pendingActionStore
        .openRecords()
        .some((record) => record.requestId === "mcp-inline-store-evicted"),
    ).toBe(true);

    try {
      act(() => {
        for (let index = 0; index < PENDING_ACTIONS_CAP; index += 1) {
          const pending = classifyHermesEvent({
            type: "approval.request",
            session_id: `approval-response-cap-session-${index}`,
            payload: {
              request_id: `approval-response-cap-request-${index}`,
              description: "Cap filler",
              allow_permanent: false,
            },
          });
          if (pending.kind !== "pending_action") throw new Error("Expected a pending action");
          pendingActionStore.record(pending, "sandboxed");
        }
      });
      expect(
        pendingActionStore
          .getRecords()
          .some((record) => record.requestId === "mcp-inline-store-evicted"),
      ).toBe(false);

      await user.click(screen.getByRole("button", { name: "Approve" }));
      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("approval.respond", {
          session_id: "runtime-session-2",
          request_id: "mcp-inline-store-evicted",
          choice: "once",
        }),
      );
      expect(await screen.findByText("Approved once")).toBeInTheDocument();
    } finally {
      act(() => {
        for (let index = 0; index < PENDING_ACTIONS_CAP; index += 1) {
          pendingActionStore.resolveSession(`approval-response-cap-session-${index}`);
        }
      });
    }
  });

  it("does not reopen a retired approval replay after its store tombstone is evicted", async () => {
    const statusDetails: AgentSessionStatusDetail[] = [];
    const handleStatus = (event: Event) => {
      statusDetails.push((event as CustomEvent<AgentSessionStatusDetail>).detail);
    };
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), prompt: "connect Todoist" }),
    );
    render(<AgentWorkspace />);
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "connect Todoist",
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "approval.request",
          session_id: "runtime-session-2",
          payload: {
            request_id: "mcp-evicted-tombstone",
            description: "Connect Todoist?",
            allow_permanent: false,
          },
        });
      }
    });
    expect(await screen.findByText("Approval required")).toBeInTheDocument();
    act(() => {
      for (const close of [...mocks.gatewayCloseHandlers]) close();
    });
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.resume", {
        session_id: "session-2",
        cols: 96,
      }),
    );
    expect(await screen.findByText("Approval expired")).toBeInTheDocument();

    act(() => {
      for (let index = 0; index < PENDING_ACTIONS_CAP; index += 1) {
        const runtimeSessionId = `approval-cap-session-${index}`;
        const requestId = `approval-cap-request-${index}`;
        const pending = classifyHermesEvent({
          type: "approval.request",
          session_id: runtimeSessionId,
          payload: {
            request_id: requestId,
            description: "Cap filler",
            allow_permanent: false,
          },
        });
        if (pending.kind !== "pending_action") throw new Error("Expected a pending action");
        pendingActionStore.record(pending, "sandboxed");
        pendingActionStore.resolveRequest(runtimeSessionId, requestId);
      }
    });
    expect(
      pendingActionStore.getRecords().some((row) => row.requestId === "mcp-evicted-tombstone"),
    ).toBe(false);
    const statusCountBeforeReplay = statusDetails.length;

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "approval.request",
          session_id: "runtime-session-1",
          payload: {
            request_id: "mcp-evicted-tombstone",
            description: "Connect Todoist?",
            allow_permanent: false,
          },
        });
      }
    });

    expect(screen.getAllByText("Approval expired")).toHaveLength(1);
    expect(screen.queryByText("Approval required")).toBeNull();
    expect(
      pendingActionStore.openRecords().some((row) => row.requestId === "mcp-evicted-tombstone"),
    ).toBe(false);
    expect(hermesActivityStore.getRecord("session-2")?.phase).toBe("running");
    expect(
      statusDetails
        .slice(statusCountBeforeReplay)
        .some((detail) => detail.sessionId === "session-2" && detail.status === "waitingForUser"),
    ).toBe(false);
    window.removeEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
  });

  it("retires an approval when its frame and close race activity projection", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), prompt: "connect Todoist" }),
    );
    render(<AgentWorkspace />);
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "connect Todoist",
      }),
    );

    // Activity rows are bounded independently of the semantic stream. Make
    // the projection idle, then deliver the approval and physical close in
    // one event-loop task before React can mirror the new waiting row into its refs.
    act(() => hermesActivityStore.clearSession("session-2"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
    );
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "approval.request",
          session_id: "runtime-session-2",
          payload: {
            request_id: "mcp-close-race",
            description: "Connect Todoist?",
            allow_permanent: false,
          },
        });
      }
      for (const close of [...mocks.gatewayCloseHandlers]) close();
    });

    expect(await screen.findByText("Approval expired")).toBeInTheDocument();
    expect(screen.queryByText("Approval required")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(pendingActionStore.openRecords().some((row) => row.requestId === "mcp-close-race")).toBe(
      false,
    );
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("session.resume", expect.anything());
  });

  it("retires a fresh approval when the gateway drops again during recovery", async () => {
    let resolveResume: ((value: { session_id: string }) => void) | undefined;
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.create") {
        return Promise.resolve({
          session_id: "runtime-session-2",
          stored_session_id: "session-2",
        });
      }
      if (method === "session.resume") {
        return new Promise((resolve) => {
          resolveResume = resolve;
        });
      }
      if (method === "approval.respond") return Promise.resolve({ resolved: 1 });
      return Promise.resolve({});
    });
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), prompt: "connect Todoist" }),
    );
    render(<AgentWorkspace />);
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "connect Todoist",
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "approval.request",
          session_id: "runtime-session-2",
          payload: {
            request_id: "mcp-first-drop",
            description: "Connect Todoist first?",
            allow_permanent: false,
          },
        });
      }
    });
    expect(await screen.findByText("Approval required")).toBeInTheDocument();

    act(() => {
      for (const close of [...mocks.gatewayCloseHandlers]) close();
    });
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.resume", {
        session_id: "session-2",
        cols: 96,
      }),
    );
    expect(await screen.findByText("Approval expired")).toBeInTheDocument();

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "approval.request",
          session_id: "runtime-session-2",
          payload: {
            request_id: "mcp-second-drop",
            description: "Connect Todoist second?",
            allow_permanent: false,
          },
        });
      }
    });
    expect(await screen.findByText("Approval required")).toBeInTheDocument();

    act(() => {
      for (const close of [...mocks.gatewayCloseHandlers]) close();
    });
    await act(async () => {
      resolveResume?.({ session_id: "runtime-session-3" });
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getAllByText("Approval expired")).toHaveLength(2));
    expect(screen.queryByText("Approval required")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(
      pendingActionStore.openRecords().some((row) => row.requestId === "mcp-second-drop"),
    ).toBe(false);
  });

  it("retires an approval across an intentional workspace remount", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), prompt: "connect Todoist" }),
    );
    const first = render(<AgentWorkspace />);
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "connect Todoist",
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "approval.request",
          session_id: "runtime-session-2",
          payload: {
            request_id: "mcp-remount",
            description: "Connect Todoist?",
            allow_permanent: false,
          },
        });
      }
    });
    expect(await screen.findByText("Approval required")).toBeInTheDocument();

    first.unmount();
    expect(mocks.gatewayInstances.some((gateway) => gateway.close.mock.calls.length > 0)).toBe(
      true,
    );
    render(<AgentWorkspace />);

    expect(await screen.findByText("Approval expired")).toBeInTheDocument();
    expect(screen.getByText(/June did not approve anything/)).toBeInTheDocument();
    expect(screen.queryByText("Approval required")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(pendingActionStore.openRecords().some((row) => row.requestId === "mcp-remount")).toBe(
      false,
    );
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("approval.respond", expect.anything());

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "approval.request",
          session_id: "runtime-session-2",
          payload: {
            request_id: "mcp-remount",
            description: "Connect Todoist?",
            allow_permanent: false,
          },
        });
      }
    });
    expect(screen.getAllByText("Approval expired")).toHaveLength(1);
    expect(screen.queryByText("Approval required")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("does not resurrect a completed Agent run when the workspace detaches", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), prompt: "connect Todoist" }),
    );
    const first = render(<AgentWorkspace />);
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "connect Todoist",
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "approval.request",
          session_id: "runtime-session-2",
          payload: {
            request_id: "mcp-completed-remount",
            description: "Connect Todoist?",
            allow_permanent: false,
          },
        });
        handler({
          type: "turn.completed",
          session_id: "runtime-session-2",
          payload: { status: "success" },
        });
      }
    });

    expect(await screen.findByText("Approval expired")).toBeInTheDocument();
    await waitFor(() => expect(mocks.markAgentRunSucceeded).toHaveBeenCalledTimes(1));

    // Activity rows are bounded independently of semantic stream history. A
    // later workspace detach must still observe the terminal stream edge.
    hermesActivityStore.clearSession("session-2");
    const statuses: AgentSessionStatusDetail[] = [];
    const handleStatus = (event: Event) => {
      statuses.push((event as CustomEvent<AgentSessionStatusDetail>).detail);
    };
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);

    first.unmount();

    expect(hermesActivityStore.getRecord("session-2")).toBeUndefined();
    expect(
      statuses.some((detail) => detail.sessionId === "session-2" && detail.status === "running"),
    ).toBe(false);

    render(<AgentWorkspace />);
    expect(await screen.findByText("Approval expired")).toBeInTheDocument();
    expect(screen.getAllByText("Approval expired")).toHaveLength(1);
    expect(screen.queryByText("Approval required")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    window.removeEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
  });

  it("retires an in-flight approval response without claiming its outcome after disconnect", async () => {
    const user = userEvent.setup();
    let rejectApproval: ((error: Error) => void) | undefined;
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
        return new Promise((_resolve, reject) => {
          rejectApproval = reject;
        });
      }
      return Promise.resolve({});
    });
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), prompt: "connect Todoist" }),
    );
    render(<AgentWorkspace />);
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "connect Todoist",
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "approval.request",
          session_id: "runtime-session-2",
          payload: {
            request_id: "mcp-in-flight",
            description: "Connect Todoist?",
            allow_permanent: false,
          },
        });
      }
    });
    expect(await screen.findByText("Approval required")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("approval.respond", {
        session_id: "runtime-session-2",
        request_id: "mcp-in-flight",
        choice: "once",
      }),
    );

    // The real gateway rejects pending RPCs immediately before invoking its
    // close handlers. The response may nevertheless have reached Hermes.
    act(() => {
      rejectApproval?.(new Error("Hermes gateway connection closed."));
      for (const handler of [...mocks.gatewayCloseHandlers]) handler();
    });

    expect(await screen.findByText("Approval outcome unknown")).toBeInTheDocument();
    expect(
      screen.getByText(
        /This approval is no longer actionable, but it may have already been applied/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Approval expired")).not.toBeInTheDocument();
    expect(screen.queryByText(/June did not approve anything/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(pendingActionStore.openRecords().some((row) => row.requestId === "mcp-in-flight")).toBe(
      false,
    );
  });

  it("keys inbound diagnostics by the stored session id", async () => {
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.create") {
        return Promise.resolve({
          session_id: "runtime-diagnostics-session",
          stored_session_id: "stored-diagnostics-session",
        });
      }
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      return Promise.resolve({});
    });
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({
        createdAt: Date.now(),
        prompt: "inspect diagnostics",
      }),
    );

    render(<AgentWorkspace />);

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-diagnostics-session",
        text: "inspect diagnostics",
      }),
    );
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "future.diagnostic",
          session_id: "runtime-diagnostics-session",
          payload: { detail: "unknown" },
        });
      }
    });

    expect(unsupportedEventStore.activeNotice("runtime-diagnostics-session")).toBeUndefined();
    expect(unsupportedEventStore.activeNotice("stored-diagnostics-session")?.type).toBe(
      "future.diagnostic",
    );
    expect(hermesTraceBuffer.entriesFor("runtime-diagnostics-session")).toHaveLength(0);
    const traceEntry = hermesTraceBuffer
      .entriesFor("stored-diagnostics-session")
      .find((entry) => entry.rawType === "future.diagnostic");
    expect(traceEntry).toBeDefined();
    expect(traceEntry?.sessionId).toBe("stored-diagnostics-session");
    expect(traceEntry?.runtimeSessionId).toBe("runtime-diagnostics-session");
  });

  it("keeps the opening text after more than 200 streamed deltas", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), prompt: "stream a long answer" }),
    );
    render(<AgentWorkspace />);
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "stream a long answer",
      }),
    );

    const chunks = Array.from({ length: 205 }, (_, index) => `chunk-${index}|`);
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "message.start",
          session_id: "runtime-session-2",
          payload: { message_id: "long-message" },
        });
        for (const chunk of chunks) {
          handler({
            type: "message.delta",
            session_id: "runtime-session-2",
            payload: { message_id: "long-message", delta: chunk },
          });
        }
      }
    });

    expect(await screen.findByText(chunks.join(""))).toBeInTheDocument();
  });

  it("keeps listening after message completion until one lifecycle terminal", async () => {
    const statuses: AgentSessionStatusDetail[] = [];
    const handleStatus = (event: Event) => {
      statuses.push((event as CustomEvent<AgentSessionStatusDetail>).detail);
    };
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), prompt: "finish the whole run" }),
    );
    render(<AgentWorkspace />);
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "finish the whole run",
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "message.start",
          session_id: "runtime-session-2",
          payload: { message_id: "m1" },
        });
        handler({
          type: "message.delta",
          session_id: "runtime-session-2",
          payload: { message_id: "m1", delta: "First answer." },
        });
        handler({
          type: "message.complete",
          session_id: "runtime-session-2",
          payload: { message_id: "m1", text: "First answer." },
        });
      }
    });

    expect(await screen.findByText("First answer.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop June" })).toBeInTheDocument();
    expect(mocks.gatewayEventHandlers.size).toBe(1);
    expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
    expect(statuses.some((detail) => detail.status === "completed")).toBe(false);

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "tool.start",
          session_id: "runtime-session-2",
          payload: { tool_id: "read-1", tool_name: "read_file", path: "README.md" },
        });
        handler({
          type: "message.start",
          session_id: "runtime-session-2",
          payload: { message_id: "m2" },
        });
        handler({
          type: "message.delta",
          session_id: "runtime-session-2",
          payload: { message_id: "m2", delta: "Continuation after the tool." },
        });
      }
    });

    expect(await screen.findByText("Reading files")).toBeInTheDocument();
    expect(await screen.findByText("Continuation after the tool.")).toBeInTheDocument();
    const retainedHandlers = [...mocks.gatewayEventHandlers];
    act(() => {
      for (const handler of retainedHandlers) {
        handler({
          type: "turn.completed",
          session_id: "runtime-session-2",
          payload: { status: "success" },
        });
      }
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
    );
    expect(mocks.markAgentRunSucceeded).toHaveBeenCalledTimes(1);
    act(() => {
      for (const handler of retainedHandlers) {
        handler({
          type: "turn.completed",
          session_id: "runtime-session-2",
          payload: { status: "success" },
        });
      }
    });
    expect(mocks.markAgentRunSucceeded).toHaveBeenCalledTimes(1);
    expect(statuses.some((detail) => detail.status === "completed")).toBe(true);
    window.removeEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
  });

  it("rebinds a recovered runtime listener without replaying its prefix", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), prompt: "survive reconnect" }),
    );
    render(<AgentWorkspace />);
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "survive reconnect",
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "message.start",
          session_id: "runtime-session-2",
          payload: { message_id: "m1" },
        });
        handler({
          type: "message.delta",
          session_id: "runtime-session-2",
          payload: { message_id: "m1", delta: "Hello " },
        });
      }
    });
    expect(await screen.findByText("Hello")).toBeInTheDocument();

    act(() => {
      for (const close of mocks.gatewayCloseHandlers) close();
    });
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.resume", {
        session_id: "session-2",
        cols: 96,
      }),
    );
    expect(mocks.gatewayEventHandlers.size).toBe(1);

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "message.start",
          session_id: "runtime-session-1",
          payload: { message_id: "m1" },
        });
        handler({
          type: "message.delta",
          session_id: "runtime-session-1",
          payload: { message_id: "m1", delta: "Hello " },
        });
        handler({
          type: "message.complete",
          session_id: "runtime-session-1",
          payload: { message_id: "m1", text: "Hello world" },
        });
      }
    });

    expect(await screen.findByText("Hello world")).toBeInTheDocument();
    expect(screen.queryByText("Hello Hello world")).toBeNull();
  });

  it("does not let gateway recovery resume over a newer cross-surface Agent run", async () => {
    let resumeCount = 0;
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        resumeCount += 1;
        return Promise.resolve({
          session_id: resumeCount === 1 ? "runtime-session-1" : "runtime-recovered",
        });
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={existingSession} />);
    const composer = await screen.findByRole("textbox", { name: "Message June" });

    await user.type(composer, "keep this run bound");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "keep this run bound",
      }),
    );
    await waitFor(() => expect(mocks.startAgentRunMonitoring).toHaveBeenCalledTimes(1));
    expect(resumeCount).toBe(1);
    const refreshesBeforeRecovery = mocks.listHermesSessionMessages.mock.calls.length;

    act(() => {
      // Recovery captures the Workspace's generation-one source synchronously,
      // then yields while reconnecting. A different surface can announce its
      // accepted generation before recovery is allowed to mutate the runtime.
      for (const close of [...mocks.gatewayCloseHandlers]) close();
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_STARTED_EVENT, {
          detail: {
            storedSessionId: "session-1",
            runMonitorGeneration: 2,
            runtimeSessionId: "runtime-note-chat",
            fullMode: false,
          },
        }),
      );
    });

    await waitFor(() =>
      expect(mocks.listHermesSessionMessages.mock.calls.length).toBeGreaterThan(
        refreshesBeforeRecovery,
      ),
    );
    expect(resumeCount).toBe(1);
    expect(mocks.gatewayEventHandlers.size).toBe(1);
  });

  it("does not resurrect a stopped run when gateway recovery resumes late", async () => {
    let resolveRecoveryResume: ((value: { session_id: string }) => void) | undefined;
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.create") {
        return Promise.resolve({
          session_id: "runtime-session-2",
          stored_session_id: "session-2",
        });
      }
      if (method === "session.resume") {
        return new Promise<{ session_id: string }>((resolve) => {
          resolveRecoveryResume = resolve;
        });
      }
      return Promise.resolve({});
    });
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), prompt: "survive a delayed recovery" }),
    );
    render(<AgentWorkspace />);

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "survive a delayed recovery",
      }),
    );
    act(() => {
      for (const close of mocks.gatewayCloseHandlers) close();
    });
    await waitFor(() => expect(resolveRecoveryResume).toBeTypeOf("function"));

    await userEvent.click(screen.getByRole("button", { name: "Stop June" }));
    await waitFor(() => expect(mocks.gatewayEventHandlers.size).toBe(0));
    mocks.markAgentRunSucceeded.mockClear();

    await act(async () => {
      resolveRecoveryResume?.({ session_id: "runtime-recovered-after-stop" });
    });

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.interrupt", {
        session_id: "runtime-recovered-after-stop",
      }),
    );
    expect(mocks.gatewayEventHandlers.size).toBe(0);
    expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Stop June" })).toBeNull();
  });

  it("treats lifecycle.complete as a terminal workspace edge", async () => {
    const statusDetails: AgentSessionStatusDetail[] = [];
    const handleStatus = (event: Event) => {
      statusDetails.push((event as CustomEvent<AgentSessionStatusDetail>).detail);
    };
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
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
    expect(mocks.gatewayEventHandlers.size).toBe(1);

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "lifecycle.complete",
          session_id: "runtime-session-2",
          payload: { status: "success" },
        });
      }
    });

    await waitFor(() =>
      expect(statusDetails).toContainEqual(
        expect.objectContaining({
          sessionId: "session-2",
          status: "completed",
          summary: "June finished.",
        }),
      ),
    );
    expect(mocks.gatewayEventHandlers.size).toBe(0);
    window.removeEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
  });

  it("does not arm readiness for a failure-flavored terminal frame", async () => {
    const statusDetails: AgentSessionStatusDetail[] = [];
    const handleStatus = (event: Event) => {
      statusDetails.push((event as CustomEvent<AgentSessionStatusDetail>).detail);
    };
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), prompt: "run the build" }),
    );

    render(<AgentWorkspace />);
    await waitFor(() =>
      expect(mocks.startAgentRunMonitoring).toHaveBeenCalledWith(
        expect.objectContaining({ storedSessionId: "session-2" }),
      ),
    );
    mocks.markAgentRunSucceeded.mockClear();
    mocks.releaseAgentRunSettlement.mockClear();

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "lifecycle.complete",
          session_id: "runtime-session-2",
          payload: { status: "timeout" },
        });
      }
    });

    expect(statusDetails).toContainEqual(
      expect.objectContaining({ sessionId: "session-2", status: "failed" }),
    );
    expect(mocks.cancelAgentRunMonitoring).toHaveBeenCalledWith("session-2", 1);
    expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
    expect(mocks.releaseAgentRunSettlement).not.toHaveBeenCalled();
    window.removeEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
  });

  it("hands an accepted run to app-lifetime settlement monitoring", async () => {
    vi.useFakeTimers();
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
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), prompt: "run the build" }),
    );

    try {
      render(<AgentWorkspace />);
      await settleUnderFakeTimers(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-2",
          text: "run the build",
        }),
      );
      expect(mocks.startAgentRunMonitoring).toHaveBeenCalledWith(
        expect.objectContaining({
          storedSessionId: "session-2",
          runtimeSessionId: "runtime-session-2",
          title: "Summarize Current Page",
          fullMode: false,
          settlementHeld: true,
          acceptedPrompt: {
            dispatchedAtMs: expect.any(Number),
            findPersistedUserIndex: expect.any(Function),
          },
        }),
      );

      act(() => {
        for (const handler of mocks.gatewayEventHandlers) {
          handler({
            type: "lifecycle.complete",
            session_id: "runtime-session-2",
            payload: { status: "success" },
          });
        }
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(mocks.markAgentRunSucceeded).toHaveBeenCalledWith("session-2", 1);
      expect(mocks.releaseAgentRunSettlement).toHaveBeenCalledWith("session-2", 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds monitor recovery to the current persisted prompt at dispatch time", async () => {
    const priorMessages = [
      {
        id: "prior-identical-user",
        role: "user" as const,
        content: "repeat the same task",
      },
      {
        id: "prior-identical-assistant",
        role: "assistant" as const,
        content: "Prior result.",
      },
    ];
    mocks.listHermesSessionMessages.mockResolvedValue(priorMessages);
    let resolveResume: ((value: { session_id: string }) => void) | undefined;
    const heldResume = new Promise<{ session_id: string }>((resolve) => {
      resolveResume = resolve;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") return heldResume;
      return Promise.resolve({});
    });

    const user = userEvent.setup();
    render(<AgentWorkspace initialSession={existingSession} />);
    await screen.findByText("Prior result.");
    const composer = screen.getByRole("textbox", { name: "Message June" });
    mocks.startAgentRunMonitoring.mockClear();
    const optimisticCreatedAtMs = Date.now();
    await user.type(composer, "repeat the same task");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.resume", {
        session_id: "session-1",
        cols: 96,
      }),
    );
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", expect.anything());

    await new Promise((resolve) => setTimeout(resolve, 10));
    const preflightReleasedAtMs = Date.now();
    await act(async () => resolveResume?.({ session_id: "runtime-session-1" }));
    await waitFor(() =>
      expect(mocks.startAgentRunMonitoring).toHaveBeenCalledWith(
        expect.objectContaining({ storedSessionId: "session-1" }),
      ),
    );

    const acceptedPrompt = mocks.startAgentRunMonitoring.mock.calls[0]?.[0]?.acceptedPrompt;
    expect(acceptedPrompt?.dispatchedAtMs).toBeGreaterThan(optimisticCreatedAtMs);
    expect(acceptedPrompt?.dispatchedAtMs).toBeGreaterThanOrEqual(preflightReleasedAtMs);
    expect(acceptedPrompt?.findPersistedUserIndex(priorMessages)).toBe(-1);
    expect(
      acceptedPrompt?.findPersistedUserIndex([
        ...priorMessages,
        {
          id: "current-identical-user",
          role: "user",
          content: "repeat the same task",
          timestamp: new Date().toISOString(),
        },
      ]),
    ).toBe(2);
  });

  it("releases an unqueued run for monitoring when the Agent view unmounts", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), prompt: "run the build" }),
    );
    const { unmount } = render(<AgentWorkspace />);

    await waitFor(() =>
      expect(mocks.startAgentRunMonitoring).toHaveBeenCalledWith(
        expect.objectContaining({
          storedSessionId: "session-2",
          runtimeSessionId: "runtime-session-2",
          settlementHeld: true,
        }),
      ),
    );
    unmount();

    expect(mocks.cancelAgentRunMonitoring).not.toHaveBeenCalledWith("session-2", 1);
    expect(mocks.releaseAgentRunSettlement).toHaveBeenCalledWith("session-2", 1);
  });

  it("keeps sudo and secret pending status copy generic", async () => {
    const statusDetails: AgentSessionStatusDetail[] = [];
    const handleStatus = (event: Event) => {
      statusDetails.push((event as CustomEvent<AgentSessionStatusDetail>).detail);
    };
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
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
          type: "sudo.request",
          session_id: "runtime-session-2",
          payload: {
            request_id: "sudo-copy",
            command: "npm run build",
          },
        });
        handler({
          type: "secret.request",
          session_id: "runtime-session-2",
          payload: {
            request_id: "secret-copy",
            key_name: "API_KEY",
          },
        });
      }
    });

    await waitFor(() =>
      expect(
        statusDetails
          .filter((detail) => detail.status === "waitingForUser")
          .map((detail) => ({
            sessionId: detail.sessionId,
            summary: detail.summary,
          })),
      ).toEqual([
        { sessionId: "session-2", summary: "June has a question." },
        { sessionId: "session-2", summary: "June has a question." },
      ]),
    );
    expect(statusDetails.some((detail) => detail.summary === "June needs approval.")).toBe(false);
    window.removeEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
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

    await user.click(screen.getByRole("button", { name: "Approve" }));

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

  it("does not resume a stored session to load usage during another surface's Agent run", async () => {
    const user = userEvent.setup();
    mocks.agentRunMonitorSnapshot.mockReturnValue({
      generation: 7,
      fullMode: false,
      phase: "active",
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-rebound" });
      }
      if (method === "session.usage") {
        return Promise.resolve({ context_used: 100, context_max: 1000 });
      }
      return Promise.resolve({});
    });

    render(<AgentWorkspace initialSession={existingSession} />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_STARTED_EVENT, {
          detail: {
            storedSessionId: "session-1",
            runMonitorGeneration: 7,
            fullMode: false,
          },
        }),
      );
    });

    await user.click(screen.getByRole("button", { name: "Session actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Usage" }));

    const panel = await screen.findByLabelText("Session usage");
    expect(
      await within(panel).findByText("Couldn't load usage for this session."),
    ).toBeInTheDocument();
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("session.resume", expect.anything());
  });

  it("keeps an in-flight usage dispatch alive through a Workspace remount", async () => {
    const user = userEvent.setup();
    let resolveUsage:
      | ((value: { model: string; context_used: number; context_max: number }) => void)
      | undefined;
    const heldUsage = new Promise<{
      model: string;
      context_used: number;
      context_max: number;
    }>((resolve) => {
      resolveUsage = resolve;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "session.usage") return heldUsage;
      return Promise.resolve({});
    });

    const first = render(<AgentWorkspace initialSession={existingSession} />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Session actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Usage" }));
    await waitFor(() => expect(resolveUsage).toBeTypeOf("function"));
    const firstGateway = mocks.gatewayInstances[0];
    expect(firstGateway).toBeDefined();

    first.unmount();
    render(<AgentWorkspace initialSession={existingSession} />);
    await screen.findByRole("textbox", { name: "Message June" });

    expect(firstGateway?.close).not.toHaveBeenCalled();
    let laterDispatchStarted = false;
    const laterDispatch = reserveHermesSessionDispatch("session-1").run(async () => {
      laterDispatchStarted = true;
    });
    await act(async () => Promise.resolve());
    expect(laterDispatchStarted).toBe(false);

    await act(async () =>
      resolveUsage?.({
        model: "zai-org-glm-5-2",
        context_used: 100,
        context_max: 1000,
      }),
    );
    await laterDispatch;
    expect(laterDispatchStarted).toBe(true);
    await waitFor(() => expect(firstGateway?.close).toHaveBeenCalledTimes(1));
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
    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_SETTLED_EVENT, {
          detail: {
            sessionId: "session-1",
            title: "Existing session",
            runMonitorGeneration: 1,
            summary: "June finished.",
          },
        }),
      );
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
    );

    // Between Agent runs, opening Usage may safely hit the stale runtime, get
    // "session not found", resume a fresh runtime, and retry.
    await user.click(screen.getByRole("button", { name: "Session actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Usage" }));

    // The panel resolves the raw model id against the catalog fixture, so the
    // display name renders, not "zai-org-glm-5-2". Scoped to the panel: the
    // composer's model pill shows the same name.
    const panel = await screen.findByLabelText("Session usage");
    expect(await within(panel).findByText("GLM 5.2")).toBeInTheDocument();
    // The redesigned meter splits the reading (used, then a muted "/ limit
    // tokens" span) and the percent into separate legend elements.
    expect(within(panel).getByText(/1,000 tokens/)).toBeInTheDocument();
    expect(within(panel).getByText(/^10%$/)).toBeInTheDocument();
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
        model: "__june_remote_generation__:zai-org-glm-5-2",
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

  it("marks a disappeared working session failed when no assistant reply persisted", async () => {
    const statusDetails: AgentSessionStatusDetail[] = [];
    const handleStatus = (event: Event) => {
      statusDetails.push((event as CustomEvent<AgentSessionStatusDetail>).detail);
    };
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
    // A recent trailing user message with no reply resumes the session as
    // working on mount — the exact state a dead run (provider failure, app
    // quit mid-turn) leaves behind.
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "user" as const,
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
      await settleUnderFakeTimers(() => expect(screen.getByText("Thinking…")).toBeInTheDocument());

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
      expect(screen.getByText("June stopped before replying.")).toBeInTheDocument();
      expect(statusDetails).toContainEqual(
        expect.objectContaining({
          sessionId: "session-1",
          status: "failed",
          summary: "June stopped before replying.",
        }),
      );
      expect(hermesActivityStore.getRecord("session-1")?.phase).toBe("error");
      expect(statusDetails).not.toContainEqual(
        expect.objectContaining({
          sessionId: "session-1",
          status: "completed",
          summary: "June stopped.",
        }),
      );
    } finally {
      window.removeEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
      vi.useRealTimers();
    }
  });

  it("keeps disappeared working sessions quiet when an assistant reply persisted", async () => {
    const statusDetails: AgentSessionStatusDetail[] = [];
    const handleStatus = (event: Event) => {
      statusDetails.push((event as CustomEvent<AgentSessionStatusDetail>).detail);
    };
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
    const userOnly = [
      {
        id: "m1",
        role: "user",
        content: "still waiting on this",
        timestamp: new Date().toISOString(),
      },
    ];
    let replyPersisted = false;
    const reply = {
      id: "m2",
      role: "assistant" as const,
      content: "Here is the answer.",
      timestamp: new Date().toISOString(),
    };
    // Order-independent: every load returns just the user message until the
    // reply lands in persistence, so the session stays stably "working" during
    // hydration and "Thinking…" never depends on which load resolves first.
    mocks.listHermesSessionMessages.mockImplementation(async () =>
      replyPersisted ? [...userOnly, reply] : [...userOnly],
    );
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.active_list") {
        return Promise.resolve({ sessions: [] });
      }
      return Promise.resolve({});
    });

    vi.useFakeTimers();
    try {
      render(<AgentWorkspace />);
      await settleUnderFakeTimers(() => expect(screen.getByText("Thinking…")).toBeInTheDocument());

      // The run actually finished — the reply is now persisted; the runtime
      // just forgot the session (active_list []). The next poll's refresh sees
      // it and dispatches exactly one "completed", never a "June stopped".
      replyPersisted = true;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });

      expect(screen.getByText("Here is the answer.")).toBeInTheDocument();
      expect(screen.queryByText("June stopped before replying.")).toBeNull();
      const terminal = statusDetails.filter(
        (detail) =>
          detail.sessionId === "session-1" &&
          (detail.status === "completed" || detail.status === "failed"),
      );
      // Exactly one terminal dispatch, from refreshHermesSession seeing the
      // reply — a second "June stopped." would overwrite the finished summary.
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({ status: "completed", summary: "June finished." });
    } finally {
      window.removeEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
      vi.useRealTimers();
    }
  });

  it("does not treat a persisted tool-call tail as an Agent run reply", async () => {
    let persistedMessages: Array<{
      id: string;
      role: "user" | "assistant" | "tool";
      content: unknown;
      timestamp: string;
      tool_calls?: unknown;
      tool_call_id?: string;
    }> = [];
    mocks.listHermesSessionMessages.mockImplementation(async () => persistedMessages);
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "session.active_list") {
        return Promise.resolve({ sessions: [] });
      }
      return Promise.resolve({});
    });

    vi.useFakeTimers();
    try {
      render(<AgentWorkspace initialSession={existingSession} />);
      await settleUnderFakeTimers(() =>
        expect(screen.getByRole("textbox", { name: "Message June" })).toBeInTheDocument(),
      );
      const composer = screen.getByRole("textbox", { name: "Message June" });
      fireEvent.paste(composer, {
        clipboardData: { getData: () => "search the launch notes" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await settleUnderFakeTimers(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text: "search the launch notes",
        }),
      );
      persistedMessages = [
        {
          id: "tool-tail-user",
          role: "user",
          content: "search the launch notes",
          timestamp: new Date().toISOString(),
        },
        {
          id: "tool-tail-assistant",
          role: "assistant",
          content: "I will search the notes now.",
          timestamp: new Date().toISOString(),
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "search_notes", arguments: '{"query":"launch"}' },
            },
          ],
        },
        {
          id: "tool-tail-result",
          role: "tool",
          content: "No matching notes",
          timestamp: new Date().toISOString(),
          tool_call_id: "call-1",
        },
      ];

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });

      expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
      expect(mocks.releaseAgentRunSettlement).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not turn a failed message completion into idle-reconciled success", async () => {
    const statusDetails: AgentSessionStatusDetail[] = [];
    const handleStatus = (event: Event) => {
      statusDetails.push((event as CustomEvent<AgentSessionStatusDetail>).detail);
    };
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
    let persistedMessages: Array<{
      id: string;
      role: "user" | "assistant";
      content: string;
      timestamp: string;
    }> = [];
    mocks.listHermesSessionMessages.mockImplementation(async () => persistedMessages);
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.create") {
        return Promise.resolve({
          session_id: "runtime-session-2",
          stored_session_id: "session-2",
        });
      }
      if (method === "session.active_list") {
        return Promise.resolve({ sessions: [] });
      }
      return Promise.resolve({});
    });
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), prompt: "run the failing task" }),
    );

    vi.useFakeTimers();
    try {
      render(<AgentWorkspace />);
      await settleUnderFakeTimers(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-2",
          text: "run the failing task",
        }),
      );

      act(() => {
        for (const handler of [...mocks.gatewayEventHandlers]) {
          handler({
            type: "message.start",
            session_id: "runtime-session-2",
            payload: { message_id: "failed-answer" },
          });
          handler({
            type: "message.complete",
            session_id: "runtime-session-2",
            payload: {
              message_id: "failed-answer",
              text: "Partial answer before failure.",
              status: "ERROR",
            },
          });
        }
      });
      persistedMessages = [
        {
          id: "user-message",
          role: "user",
          content: "run the failing task",
          timestamp: new Date().toISOString(),
        },
        {
          id: "failed-answer",
          role: "assistant",
          content: "Partial answer before failure.",
          timestamp: new Date().toISOString(),
        },
      ];

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });

      expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
      expect(mocks.releaseAgentRunSettlement).not.toHaveBeenCalled();
      expect(statusDetails).toContainEqual(
        expect.objectContaining({
          sessionId: "session-2",
          status: "failed",
        }),
      );

      mocks.markAgentRunSucceeded.mockClear();
      const composer = screen.getByRole("textbox", { name: "Message June" });
      fireEvent.paste(composer, {
        clipboardData: {
          getData: () => "run the succeeding task",
        },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await settleUnderFakeTimers(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-2",
          text: "run the succeeding task",
        }),
      );
      act(() => {
        for (const handler of [...mocks.gatewayEventHandlers]) {
          handler({
            type: "message.start",
            session_id: "runtime-session-2",
            payload: { message_id: "successful-answer" },
          });
          handler({
            type: "message.complete",
            session_id: "runtime-session-2",
            payload: {
              message_id: "successful-answer",
              text: "The second run succeeded.",
            },
          });
        }
      });
      persistedMessages = [
        ...persistedMessages,
        {
          id: "second-user-message",
          role: "user",
          content: "run the succeeding task",
          timestamp: new Date().toISOString(),
        },
        {
          id: "successful-answer",
          role: "assistant",
          content: "The second run succeeded.",
          timestamp: new Date().toISOString(),
        },
      ];

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });

      expect(mocks.markAgentRunSucceeded).toHaveBeenCalledTimes(1);
      expect(mocks.markAgentRunSucceeded).toHaveBeenCalledWith("session-2", 1);
      expect(statusDetails.at(-1)).toMatchObject({
        sessionId: "session-2",
        status: "completed",
      });
    } finally {
      window.removeEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
      vi.useRealTimers();
    }
  });

  it("does not carry a runtime miss from a completed Agent run into the next Agent run", async () => {
    let persistedMessages: Array<{
      id: string;
      role: "user" | "assistant";
      content: string;
      timestamp: string;
    }> = [];
    mocks.listHermesSessionMessages.mockImplementation(async () => persistedMessages);
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "session.active_list") {
        return Promise.resolve({ sessions: [] });
      }
      return Promise.resolve({});
    });

    vi.useFakeTimers();
    try {
      render(<AgentWorkspace initialSession={existingSession} />);
      await settleUnderFakeTimers(() =>
        expect(screen.getByRole("textbox", { name: "Message June" })).toBeInTheDocument(),
      );
      const composer = screen.getByRole("textbox", { name: "Message June" });
      fireEvent.paste(composer, {
        clipboardData: { getData: () => "finish run A" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await settleUnderFakeTimers(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text: "finish run A",
        }),
      );
      persistedMessages = [
        {
          id: "run-a-user",
          role: "user",
          content: "finish run A",
          timestamp: new Date().toISOString(),
        },
      ];

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      expect(
        mocks.gatewayRequest.mock.calls.filter(([method]) => method === "session.active_list"),
      ).toHaveLength(1);

      persistedMessages = [
        ...persistedMessages,
        {
          id: "run-a-assistant",
          role: "assistant",
          content: "Run A finished.",
          timestamp: new Date().toISOString(),
        },
      ];
      act(() => {
        for (const handler of [...mocks.gatewayEventHandlers]) {
          handler({
            type: "lifecycle.complete",
            session_id: "runtime-session-1",
            event_id: "run-a-terminal",
            payload: { status: "success" },
          });
        }
      });
      await settleUnderFakeTimers(() =>
        expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
      );

      fireEvent.paste(composer, {
        clipboardData: { getData: () => "keep run B working" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await settleUnderFakeTimers(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text: "keep run B working",
        }),
      );
      mocks.cancelAgentRunMonitoring.mockClear();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });

      expect(mocks.cancelAgentRunMonitoring).not.toHaveBeenCalledWith("session-1", 1);
      expect(screen.getByRole("button", { name: "Stop June" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a delayed run-A reconcile refresh settle run B", async () => {
    type PersistedMessage = {
      id: string;
      role: "user" | "assistant";
      content: string;
      timestamp: string;
    };
    const runAUser: PersistedMessage = {
      id: "delayed-run-a-user",
      role: "user",
      content: "start delayed run A",
      timestamp: new Date().toISOString(),
    };
    const runAAssistant: PersistedMessage = {
      id: "delayed-run-a-assistant",
      role: "assistant",
      content: "Run A eventually persisted.",
      timestamp: new Date().toISOString(),
    };
    let persistedMessages: PersistedMessage[] = [];
    let activeListCalls = 0;
    let staleRefreshWasIssued = false;
    let resolveStaleRefresh: ((messages: PersistedMessage[]) => void) | undefined;
    mocks.listHermesSessionMessages.mockImplementation(async () => {
      if (activeListCalls >= 2 && !staleRefreshWasIssued) {
        staleRefreshWasIssued = true;
        return new Promise<PersistedMessage[]>((resolve) => {
          resolveStaleRefresh = resolve;
        });
      }
      return persistedMessages;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "session.active_list") {
        activeListCalls += 1;
        return Promise.resolve({ sessions: [] });
      }
      return Promise.resolve({});
    });

    vi.useFakeTimers();
    try {
      render(<AgentWorkspace initialSession={existingSession} />);
      await settleUnderFakeTimers(() =>
        expect(screen.getByRole("textbox", { name: "Message June" })).toBeInTheDocument(),
      );
      const composer = screen.getByRole("textbox", { name: "Message June" });
      fireEvent.paste(composer, {
        clipboardData: { getData: () => "start delayed run A" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await settleUnderFakeTimers(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text: "start delayed run A",
        }),
      );
      persistedMessages = [runAUser];

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      expect(resolveStaleRefresh).toBeTypeOf("function");

      act(() => {
        for (const handler of [...mocks.gatewayEventHandlers]) {
          handler({
            type: "lifecycle.complete",
            session_id: "runtime-session-1",
            event_id: "delayed-run-a-terminal",
            payload: { status: "success" },
          });
        }
      });
      await act(async () => Promise.resolve());
      persistedMessages = [runAUser, runAAssistant];
      fireEvent.paste(composer, {
        clipboardData: { getData: () => "keep run B current" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await settleUnderFakeTimers(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text: "keep run B current",
        }),
      );
      mocks.markAgentRunSucceeded.mockClear();

      await act(async () => {
        resolveStaleRefresh?.([runAUser, runAAssistant]);
      });

      expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalledWith("session-1", 1);
      expect(screen.getByRole("button", { name: "Stop June" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let an unmounted reconciliation dispatch the remounted follow-up queue", async () => {
    type PersistedMessage = {
      id: string;
      role: "user" | "assistant";
      content: string;
      timestamp: string;
    };
    const persistedMessages: PersistedMessage[] = [
      {
        id: "reconcile-remount-user",
        role: "user",
        content: "finish before navigation",
        timestamp: new Date().toISOString(),
      },
      {
        id: "reconcile-remount-assistant",
        role: "assistant",
        content: "The first run finished while navigating.",
        timestamp: new Date().toISOString(),
      },
    ];
    let activeListCalls = 0;
    let staleRefreshWasIssued = false;
    let resolveStaleRefresh: ((messages: PersistedMessage[]) => void) | undefined;
    mocks.listHermesSessionMessages.mockImplementation(async () => {
      if (activeListCalls >= 2 && !staleRefreshWasIssued) {
        staleRefreshWasIssued = true;
        return new Promise<PersistedMessage[]>((resolve) => {
          resolveStaleRefresh = resolve;
        });
      }
      return activeListCalls === 0 ? [] : persistedMessages;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "session.active_list") {
        activeListCalls += 1;
        return Promise.resolve({ sessions: [] });
      }
      return Promise.resolve({});
    });

    vi.useFakeTimers();
    try {
      const first = render(<AgentWorkspace initialSession={existingSession} />);
      await settleUnderFakeTimers(() =>
        expect(screen.getByRole("textbox", { name: "Message June" })).toBeInTheDocument(),
      );
      const composer = screen.getByRole("textbox", { name: "Message June" });
      fireEvent.paste(composer, {
        clipboardData: { getData: () => "finish before navigation" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await settleUnderFakeTimers(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text: "finish before navigation",
        }),
      );
      await settleUnderFakeTimers(() =>
        expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
      );
      act(() => {
        mocks.eventHandlers.get("tauri://drag-drop")?.({
          payload: { paths: ["/Users/alex/Desktop/remounted-follow-up.pdf"] },
        });
      });
      await settleUnderFakeTimers(() =>
        expect(screen.getByText("remounted-follow-up.pdf")).toBeInTheDocument(),
      );
      fireEvent.paste(composer, {
        clipboardData: { getData: () => "send this exactly once after navigation" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Queue next message" }));
      await settleUnderFakeTimers(() =>
        expect(screen.getByText("send this exactly once after navigation")).toBeInTheDocument(),
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      expect(resolveStaleRefresh).toBeTypeOf("function");

      first.unmount();
      render(<AgentWorkspace initialSession={existingSession} />);
      await settleUnderFakeTimers(() =>
        expect(screen.getByText("send this exactly once after navigation")).toBeInTheDocument(),
      );
      mocks.markAgentRunSucceeded.mockClear();

      await act(async () => {
        resolveStaleRefresh?.(persistedMessages);
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
      expect(
        mocks.gatewayRequest.mock.calls.filter(
          ([method, params]) =>
            method === "prompt.submit" &&
            (params as { text?: string } | undefined)?.text ===
              "send this exactly once after navigation",
        ),
      ).toHaveLength(0);
      expect(screen.getByText("send this exactly once after navigation")).toBeInTheDocument();
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
      await settleUnderFakeTimers(() => expect(screen.getByText("Thinking…")).toBeInTheDocument());

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

  it("reserves the session dispatch order before skill preparation finishes", async () => {
    const user = userEvent.setup();
    let resolveSkillDocument: (document: {
      name: string;
      relativePath: string;
      content: string;
    }) => void = () => undefined;
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
    await user.type(screen.getByRole("textbox"), "/repo-build-pr preserve send order");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(mocks.getHermesBridgeSkill).toHaveBeenCalledWith("repo-build-pr"));

    const laterReservation = reserveHermesSessionDispatch("session-1");
    expect(laterReservation.queuedBehindPrior).toBe(true);
    const laterDispatch = vi.fn(async () => undefined);
    const later = laterReservation.run(laterDispatch);
    await Promise.resolve();
    expect(laterDispatch).not.toHaveBeenCalled();

    resolveSkillDocument({
      name: "repo-build-pr",
      relativePath: "repo-build-pr/SKILL.md",
      content: "# Repo build PR\n\nOpen a draft PR.",
    });

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith(
        "prompt.submit",
        expect.objectContaining({ text: expect.stringContaining("preserve send order") }),
      ),
    );
    await expect(later).resolves.toBeUndefined();
    expect(laterDispatch).toHaveBeenCalledOnce();
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
    const fileName = "sample-with-an-extraordinarily-long-generated-file-name.pdf";
    const samplePath = `/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace/${fileName}`;
    mocks.hermesBridgeFilesystemSnapshot.mockResolvedValue({
      roots: [
        {
          id: "workspace",
          label: "Workspace",
          path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace",
          description: "Hermes scratch files and generated outputs.",
          entries: [
            {
              name: fileName,
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
        content: `Done. The PDF is available as \`${fileName}\`.`,
        timestamp: "2026-06-04T18:39:00Z",
      },
    ]);

    render(<AgentWorkspace />);

    expect(await screen.findByLabelText("Generated files")).toBeInTheDocument();
    expect(screen.getAllByText(fileName).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: `Download ${fileName}` }));

    expect(mocks.downloadHermesBridgeFile).toHaveBeenCalledWith(samplePath);
    const toastMessage = await screen.findByLabelText(`Downloaded ${fileName}`);
    expect(toastMessage.querySelector(".june-download-toast-action")).toHaveTextContent(
      "Downloaded",
    );
    expect(toastMessage.querySelector(".june-download-toast-file")).toHaveAttribute(
      "title",
      fileName,
    );
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

  it("does not render a download card for a file already shown inline as generated media", async () => {
    // JUN-305: a generated image renders inline with its own open/download
    // affordances; a workspace-file card for the same file would duplicate it
    // (and could paint above the generation when an earlier turn names the
    // file), so the artifact assignment must skip media-claimed files.
    const generatedPath =
      "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace/generated-image-abc.png";
    mocks.hermesBridgeFilesystemSnapshot.mockResolvedValue({
      roots: [
        {
          id: "workspace",
          label: "Workspace",
          path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace",
          description: "Hermes scratch files and generated outputs.",
          entries: [
            {
              name: "generated-image-abc.png",
              path: generatedPath,
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
        content: "",
        timestamp: "2026-06-04T18:38:00Z",
        tool_calls: JSON.stringify([
          {
            id: "call-1",
            function: { name: "generate_image", arguments: { prompt: "a red bicycle" } },
          },
        ]),
      },
      {
        id: "message-2",
        role: "tool",
        tool_call_id: "call-1",
        tool_name: "generate_image",
        content: [
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          {
            type: "text",
            text: JSON.stringify({ filename: "generated-image-abc.png", label: "a red bicycle" }),
          },
        ],
        timestamp: "2026-06-04T18:39:00Z",
      },
      {
        id: "message-3",
        role: "assistant",
        content: "Saved it as generated-image-abc.png.",
        timestamp: "2026-06-04T18:40:00Z",
      },
    ]);

    render(<AgentWorkspace />);

    expect(await screen.findByRole("img", { name: "a red bicycle" })).toBeInTheDocument();
    expect(screen.queryByText("Working with images")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Generated files")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Download generated-image-abc.png" }),
    ).not.toBeInTheDocument();

    expect(screen.queryByRole("button", { name: /View files/ })).not.toBeInTheDocument();
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

  it("renders Hermes MEDIA image references as inline generated images", async () => {
    const user = userEvent.setup();
    const mediaPath =
      "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/image_cache/img_ce347dc6e27a.png";
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "message-1",
        role: "assistant",
        content: [
          "Here is the regenerated wolf:",
          "",
          `MEDIA:${mediaPath}`,
          "",
          "A majestic wolf rendered in a misty forest at dawn.",
        ].join("\n"),
        timestamp: "2026-06-04T18:39:00Z",
      },
    ]);

    render(<AgentWorkspace />);

    expect(await screen.findByText("Here is the regenerated wolf:")).toBeInTheDocument();
    const image = await screen.findByRole("img", { name: "Generated image" });
    expect(image).toHaveAttribute("src", "data:image/png;base64,cHJldmlldw==");
    expect(screen.queryByText(/MEDIA:/)).not.toBeInTheDocument();
    expect(mocks.hermesBridgeFilePreview).toHaveBeenCalledWith(mediaPath);

    const openImage = image.closest("button");
    expect(openImage).not.toBeNull();
    await user.click(openImage as HTMLButtonElement);
    const panel = await screen.findByRole("complementary", { name: "Files" });
    await user.click(within(panel).getByRole("button", { name: "All files" }));
    expect(within(panel).getByText("img_ce347dc6e27a.png")).toBeInTheDocument();
  });

  it("renders bare-filename MEDIA references as inline generated images", async () => {
    const user = userEvent.setup();
    // The june_image tool returns a plain `filename`, and the model echoes it as
    // `MEDIA:<filename>` rather than an absolute path. The bare reference must
    // still render inline (the backend resolves it against the image roots)
    // instead of leaking as visible text.
    const mediaName = "img_ae9ed1ffc669.png";
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "message-1",
        role: "assistant",
        content: ["Done! Here's the edited image:", "", `MEDIA:${mediaName}`].join("\n"),
        timestamp: "2026-06-04T18:39:00Z",
      },
    ]);

    render(<AgentWorkspace />);

    expect(await screen.findByText("Done! Here's the edited image:")).toBeInTheDocument();
    const image = await screen.findByRole("img", { name: "Generated image" });
    expect(image).toHaveAttribute("src", "data:image/png;base64,cHJldmlldw==");
    expect(screen.queryByText(/MEDIA:/)).not.toBeInTheDocument();
    // The bare filename is passed through to the bridge, which resolves it.
    expect(mocks.hermesBridgeFilePreview).toHaveBeenCalledWith(mediaName);

    const openImage = image.closest("button");
    expect(openImage).not.toBeNull();
    await user.click(openImage as HTMLButtonElement);
    const panel = await screen.findByRole("complementary", { name: "Files" });
    await user.click(within(panel).getByRole("button", { name: "All files" }));
    expect(within(panel).getByText(mediaName)).toBeInTheDocument();
  });

  it("does not remap a bare-filename MEDIA image to a same-named Workspace file", async () => {
    const user = userEvent.setup();
    const mediaName = "img_ae9ed1ffc669.png";
    const workspacePath =
      "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace/img_ae9ed1ffc669.png";
    mocks.hermesBridgeFilesystemSnapshot.mockResolvedValue({
      roots: [
        {
          id: "workspace",
          label: "Workspace",
          path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace",
          description: "Hermes scratch files and generated outputs.",
          entries: [
            {
              name: mediaName,
              path: workspacePath,
              kind: "file",
              size: 2048,
              modifiedAt: "2026-06-04T18:39:00Z",
            },
          ],
        },
        {
          id: "memory",
          label: "Memory",
          path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/memory",
          description: "Hermes memory files.",
          entries: [
            {
              name: mediaName,
              path: `/Users/alex/Library/Application Support/co.opensoftware.june/hermes/memory/${mediaName}`,
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
        content: `MEDIA:${mediaName}`,
        timestamp: "2026-06-04T18:39:00Z",
      },
    ]);

    render(<AgentWorkspace />);

    await screen.findByRole("img", { name: "Generated image" });
    await user.click(screen.getByRole("button", { name: "View files (1)" }));
    const panel = await screen.findByRole("complementary", { name: "Files" });
    await user.click(within(panel).getByText(mediaName));
    expect(mocks.hermesBridgeFilePreview).not.toHaveBeenCalledWith(workspacePath);
  });

  it("deduplicates absolute and signed bare references to the same generated image", async () => {
    const absolutePath = "/Users/alex/.hermes/image_cache/img_cff5d542a4d2.png";
    const signedName = "generated-image-abc.june-source-deadbeef.png";
    expect(generatedImagePathAliases(absolutePath, signedName)).toEqual([
      "img_cff5d542a4d2.png",
      "generated-image-abc.png",
    ]);
    expect(generatedImagePathAliases(signedName, signedName)).toEqual(["generated-image-abc.png"]);
    const envelope = {
      result: `MEDIA:${absolutePath}\n${JSON.stringify({ filename: signedName })}`,
      structuredContent: { filename: signedName, mimeType: "image/png" },
    };
    const wrappedResult = [
      '<untrusted_tool_result source="mcp_june_image_generate_image">',
      JSON.stringify(envelope),
      "</untrusted_tool_result>",
    ].join("\n");
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "message-1",
        role: "assistant",
        content: "",
        timestamp: "2026-06-04T18:39:00Z",
        tool_calls: JSON.stringify([
          {
            id: "call-1",
            function: { name: "mcp_june_image_generate_image", arguments: {} },
          },
        ]),
      },
      {
        id: "message-2",
        role: "tool",
        tool_call_id: "call-1",
        tool_name: "mcp_june_image_generate_image",
        content: wrappedResult,
        timestamp: "2026-06-04T18:39:01Z",
      },
      {
        id: "message-3",
        role: "user",
        content: "Show that image again.",
        timestamp: "2026-06-04T18:40:00Z",
      },
      {
        id: "message-4",
        role: "assistant",
        content: `MEDIA:${signedName}`,
        timestamp: "2026-06-04T18:41:00Z",
      },
    ]);

    render(<AgentWorkspace />);

    expect(await screen.findByRole("button", { name: "View files (1)" })).toBeInTheDocument();
  });

  it("keeps distinct cache images that share a generic display name", () => {
    const firstPath = "/Users/alex/.hermes/image_cache/img_first.png";
    const secondPath = "/Users/alex/.hermes/image_cache/img_second.png";
    expect(generatedImagePathAliases(firstPath, "output.png")).toEqual(["img_first.png"]);
    expect(generatedImagePathAliases(secondPath, "output.png")).toEqual(["img_second.png"]);
    expect(generatedImagePathAliases(firstPath, "output.png")).not.toEqual(
      generatedImagePathAliases(secondPath, "output.png"),
    );
  });

  it("does not register a pathless MCP image block by filename", async () => {
    const mediaName = "output.png";
    mocks.hermesBridgeFilesystemSnapshot.mockResolvedValue({
      roots: [
        {
          id: "workspace",
          label: "Workspace",
          path: "/workspace",
          description: "Hermes scratch files and generated outputs.",
          entries: [
            {
              name: mediaName,
              path: `/workspace/first/${mediaName}`,
              kind: "file",
              size: 2048,
              modifiedAt: "2026-06-04T18:39:00Z",
            },
            {
              name: mediaName,
              path: `/workspace/second/${mediaName}`,
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
        role: "tool",
        tool_name: "generate_image",
        content: [
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          { type: "text", text: JSON.stringify({ filename: mediaName }) },
        ],
        timestamp: "2026-06-04T18:39:00Z",
      },
    ]);

    render(<AgentWorkspace />);

    await screen.findByRole("img", { name: "Generated image" });
    expect(screen.queryByRole("button", { name: /View files/ })).not.toBeInTheDocument();
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

  it.each([
    {
      name: "titles an attachments-only new session from the attachment name",
      path: "/Users/alex/Desktop/quarterly—planning.PDF",
      title: "Quarterly-planning",
    },
    {
      name: "caps an attachments-only session title derived from a long filename",
      path: "/Users/alex/Desktop/this-is-a-very-long-attachment-name-that-exceeds-the-forty-eight-character-title-limit.pdf",
      title: "This-is-a-very-long-attachment-name-that-exceeds",
    },
    {
      name: "collapses filename whitespace in an attachments-only session title",
      path: "/Users/alex/Desktop/quarterly\n\tplanning\t notes.PDF",
      title: "Quarterly planning notes",
    },
  ])("$name", async ({ path, title }) => {
    const user = userEvent.setup();
    render(<AgentWorkspace />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new CustomEvent(AGENT_NEW_SESSION_EVENT));
    });
    expect(await screen.findByText(HERO_GREETING)).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );

    mocks.eventHandlers.get("tauri://drag-drop")?.({
      payload: {
        paths: [path],
      },
    });

    const startButton = screen.getByRole("button", { name: "Start session" });
    await waitFor(() => expect(startButton).not.toBeDisabled());
    await user.click(startButton);

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith(
        "session.create",
        expect.objectContaining({ title }),
      ),
    );
    expect(mocks.suggestAgentSessionTitle).not.toHaveBeenCalled();
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.queryByText("Untitled session")).toBeNull();
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
    // default through setVeniceModel.
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

  it("warns before sending composer text that exceeds the active model context", async () => {
    mocks.providerModelSettings.mockResolvedValue({
      settings: {
        transcriptionProvider: "venice",
        transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
        generationModel: "short-context",
      },
    });
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: "short-context",
      models: [
        {
          provider: "venice",
          id: "short-context",
          name: "Short context",
          modelType: "text",
          privacy: "private",
          contextTokens: 16,
          traits: [],
          capabilities: ["functionCalling"],
        },
        {
          provider: "venice",
          id: "long-context",
          name: "Long context",
          modelType: "text",
          privacy: "private",
          contextTokens: 256,
          traits: [],
          capabilities: ["functionCalling"],
        },
      ],
    });
    const user = userEvent.setup();

    render(<AgentWorkspace initialSession={existingSession} />);

    await findCurrentModelLabel("Short context");
    await user.type(screen.getByRole("textbox"), "a".repeat(100));
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText(/This message is about/)).toHaveTextContent(
      "over Short context's 16 token context window.",
    );
    expect(screen.getByRole("button", { name: "Proceed" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit message" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch to Long context" })).toBeInTheDocument();
    expect(mocks.gatewayRequest.mock.calls.some(([method]) => method === "prompt.submit")).toBe(
      false,
    );

    await user.click(screen.getByRole("button", { name: "Proceed" }));

    await waitFor(() =>
      expect(mocks.gatewayRequest.mock.calls.some(([method]) => method === "prompt.submit")).toBe(
        true,
      ),
    );
  });

  it("counts injected project context in the composer size warning", async () => {
    // Regression: prompt.submit prepends the `[June project context]` block for
    // a project-filed session, but the guard used to estimate the pre-injection
    // text. A short prompt that fits the model alone can go over once a project
    // with long instructions is injected, so the send bypassed the warning and
    // failed only after submit. The base prompt here is well under the 30-token
    // window; only the injected block tips it over.
    const sizeSession = {
      id: "session-size-guard",
      title: "Size guard session",
      preview: "",
      last_active: "2026-06-04T12:00:00Z",
    };
    mocks.providerModelSettings.mockResolvedValue({
      settings: {
        transcriptionProvider: "venice",
        transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
        generationModel: "short-context",
      },
    });
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: "short-context",
      models: [
        {
          provider: "venice",
          id: "short-context",
          name: "Short context",
          modelType: "text",
          privacy: "private",
          contextTokens: 30,
          traits: [],
          capabilities: ["functionCalling"],
        },
      ],
    });
    const user = userEvent.setup();

    render(
      <AgentWorkspace
        initialSession={sizeSession}
        sessionInProject
        projectContext={{
          id: "project-size-guard",
          name: "Launch",
          instructions:
            "Always surface launch risks, blockers, and the rollback plan in every reply, and keep the changelog and stakeholder list current across the whole release window.",
        }}
      />,
    );

    await findCurrentModelLabel("Short context");
    // ~16 chars => ~4 tokens on its own, comfortably under the 30-token window.
    await user.type(screen.getByRole("textbox"), "Ship the release");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText(/This message is about/)).toHaveTextContent(
      "over Short context's 30 token context window.",
    );
    expect(mocks.gatewayRequest.mock.calls.some(([method]) => method === "prompt.submit")).toBe(
      false,
    );
  });

  it("switches to a larger-context model from the oversize composer warning", async () => {
    let selectedModel = "short-context";
    const models = [
      {
        provider: "venice",
        id: "short-context",
        name: "Short context",
        modelType: "text",
        privacy: "private",
        contextTokens: 16,
        traits: [],
        capabilities: ["functionCalling"],
      },
      {
        provider: "venice",
        id: "long-context",
        name: "Long context",
        modelType: "text",
        privacy: "private",
        contextTokens: 256,
        traits: [],
        capabilities: ["functionCalling"],
      },
    ];
    mocks.providerModelSettings.mockImplementation(async () => ({
      settings: {
        transcriptionProvider: "venice",
        transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
        generationModel: selectedModel,
      },
    }));
    mocks.listVeniceModels.mockImplementation(async () => ({
      mode: "generation",
      modelType: "text",
      selectedModel,
      models,
    }));
    mocks.setVeniceModel.mockImplementation(async (_mode: string, modelId: string) => {
      selectedModel = modelId;
    });
    const user = userEvent.setup();

    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now() }),
    );
    mocks.listAgentTasks.mockResolvedValue({ items: [] });
    mocks.listHermesSessions.mockResolvedValue([]);
    render(<AgentWorkspace />);

    await screen.findByRole("button", { name: "Model: Short context" });
    await user.type(screen.getByRole("textbox"), "a".repeat(100));
    await user.click(screen.getByRole("button", { name: "Start session" }));
    await user.click(await screen.findByRole("button", { name: "Switch to Long context" }));

    await waitFor(() =>
      expect(mocks.setVeniceModel).toHaveBeenCalledWith("generation", "long-context"),
    );
    expect(await screen.findByRole("button", { name: "Model: Long context" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText(/This message is about/)).not.toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() =>
      expect(mocks.gatewayRequest.mock.calls.some(([method]) => method === "prompt.submit")).toBe(
        true,
      ),
    );
  });

  it("estimates skill-expanded composer prompts before sending", async () => {
    mocks.providerModelSettings.mockResolvedValue({
      settings: {
        transcriptionProvider: "venice",
        transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
        generationModel: "short-context",
      },
    });
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: "short-context",
      models: [
        {
          provider: "venice",
          id: "short-context",
          name: "Short context",
          modelType: "text",
          privacy: "private",
          contextTokens: 64,
          traits: [],
          capabilities: ["functionCalling"],
        },
      ],
    });
    mocks.hermesBridgeSkills.mockResolvedValue([
      {
        name: "large-skill",
        description: "Adds a large instruction block.",
        category: "Testing",
        enabled: true,
      },
    ]);
    mocks.getHermesBridgeSkill.mockResolvedValue({
      name: "large-skill",
      relativePath: "large-skill/SKILL.md",
      content: `# Large skill\n\n${"Follow this instruction. ".repeat(80)}`,
    });
    const user = userEvent.setup();

    render(<AgentWorkspace initialSession={existingSession} />);

    await findCurrentModelLabel("Short context");
    await user.type(screen.getByRole("textbox"), "/large-skill summarize");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText(/This message is about/)).toHaveTextContent(
      "over Short context's 64 token context window.",
    );
    expect(mocks.gatewayRequest.mock.calls.some(([method]) => method === "prompt.submit")).toBe(
      false,
    );
  });

  it("counts pending attachment size in the oversize composer estimate", async () => {
    mocks.providerModelSettings.mockResolvedValue({
      settings: {
        transcriptionProvider: "venice",
        transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
        generationModel: "short-context",
      },
    });
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: "short-context",
      models: [
        {
          provider: "venice",
          id: "short-context",
          name: "Short context",
          modelType: "text",
          privacy: "private",
          contextTokens: 100,
          traits: [],
          capabilities: ["functionCalling"],
        },
      ],
    });
    const user = userEvent.setup();

    render(<AgentWorkspace initialSession={existingSession} />);
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith("tauri://drag-drop", expect.any(Function)),
    );

    mocks.eventHandlers.get("tauri://drag-drop")?.({
      payload: {
        paths: ["/Users/alex/Desktop/large-notes.txt"],
      },
    });

    expect(await screen.findByText("large-notes.txt")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText(/This message is about/)).toHaveTextContent(
      "over Short context's 100 token context window.",
    );
    expect(mocks.gatewayRequest.mock.calls.some(([method]) => method === "prompt.submit")).toBe(
      false,
    );
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
    expect(screen.getByText("TXT")).toBeInTheDocument();
    expect(document.querySelector(".agent-attachment-file-icon")).not.toBeNull();
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

  it("generates an image from the /image slash command and renders it inline in the thread", async () => {
    mockGlmCapabilities(["functionCalling", "supportsVision"]);
    const user = userEvent.setup();
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    mocks.generateImage.mockResolvedValueOnce({
      imageBase64: "aGVsbG8=",
      mimeType: "image/png",
      model: "venice-sd35",
      provider: "venice",
    });
    mocks.importHermesBridgeFileBytes.mockResolvedValueOnce({
      name: "generated-image.png",
      path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace/uploads/generated-image.png",
      rootLabel: "Workspace",
      size: 5,
      previewDataUrl: "data:image/png;base64,preview",
    });

    const composer = await screen.findByRole("textbox");
    await user.type(composer, "/image a red bicycle");
    const form = document.querySelector(".agent-composer");
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);

    // The image renders inline in the assistant turn (loader -> image), shown
    // from the generated bytes directly — NOT dropped into the composer as an
    // attachment chip. Its alt text is the prompt, so it is also accessible.
    const image = await screen.findByRole("img", { name: "a red bicycle" });
    expect(image).toHaveAttribute("src", "data:image/png;base64,aGVsbG8=");
    expect(image.closest(".agent-generated-image-frame")).not.toBeNull();
    expect(document.querySelector(".agent-attachment-chip")).toBeNull();
    // The prompt went to generation (nothing pinned: the default settings mock
    // has no image model/safe mode, so the server resolves both); the decoded
    // bytes were imported into the workspace.
    expect(mocks.generateImage).toHaveBeenCalledWith(
      "a red bicycle",
      undefined,
      expect.any(String),
      undefined,
    );
    expect(mocks.importHermesBridgeFileBytes).toHaveBeenCalledWith(
      expect.stringMatching(/^generated-image-\d+\.png$/),
      expect.any(Uint8Array),
    );
  });

  it.each([
    {
      name: "safe mode off",
      settings: { imageSafeMode: false, imageSafeModePromptDismissed: false },
      heuristic: true,
    },
    {
      name: "prompt dismissed",
      settings: { imageSafeMode: true, imageSafeModePromptDismissed: true },
      heuristic: true,
    },
    {
      name: "heuristic false",
      settings: { imageSafeMode: true, imageSafeModePromptDismissed: false },
      heuristic: false,
    },
    {
      name: "settings read fails",
      settings: null,
      heuristic: true,
    },
  ])("skips the safe-mode consent dialog when %s", async ({ settings, heuristic }) => {
    mockGlmCapabilities(["functionCalling", "supportsVision"]);
    if (settings) {
      mockImageSettings(settings);
    }
    mocks.imagePromptMayBeExplicit.mockResolvedValue(heuristic);
    const user = userEvent.setup();
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    if (!settings) {
      mocks.providerModelSettings.mockRejectedValueOnce(new Error("settings unavailable"));
    }
    mocks.imagePromptMayBeExplicit.mockClear();
    mockImageGenerationSuccess();

    await user.type(await screen.findByRole("textbox"), "/image a red bicycle");
    fireEvent.submit(document.querySelector(".agent-composer") as HTMLFormElement);

    await screen.findByRole("img", { name: "a red bicycle" });
    expect(screen.queryByRole("dialog", { name: "Safe mode is on" })).not.toBeInTheDocument();
    expect(mocks.generateImage).toHaveBeenCalledTimes(1);
    if (settings?.imageSafeMode && !settings.imageSafeModePromptDismissed) {
      expect(mocks.imagePromptMayBeExplicit).toHaveBeenCalledWith("a red bicycle");
    } else {
      expect(mocks.imagePromptMayBeExplicit).not.toHaveBeenCalled();
    }
  });

  it("keeps safe mode on for an explicit /image prompt and persists don't ask again", async () => {
    mockGlmCapabilities(["functionCalling", "supportsVision"]);
    mockImageSettings({ imageSafeMode: true, imageSafeModePromptDismissed: false });
    mocks.imagePromptMayBeExplicit.mockResolvedValue(true);
    const user = userEvent.setup();
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    mockImageGenerationSuccess();

    await user.type(await screen.findByRole("textbox"), "/image a red bicycle");
    fireEvent.submit(document.querySelector(".agent-composer") as HTMLFormElement);

    const dialog = await screen.findByRole("dialog", { name: "Safe mode is on" });
    expect(within(dialog).getByRole("button", { name: "Keep safe mode on" })).toHaveFocus();
    await user.click(within(dialog).getByRole("checkbox", { name: "Don't ask again" }));
    await user.click(within(dialog).getByRole("button", { name: "Keep safe mode on" }));

    await screen.findByRole("img", { name: "a red bicycle" });
    expect(mocks.setImageSafeModePromptDismissed).toHaveBeenCalledWith(true);
    expect(mocks.setImageSafeMode).not.toHaveBeenCalled();
    expect(mocks.generateImage).toHaveBeenCalledWith(
      "a red bicycle",
      "venice-sd35",
      expect.any(String),
      true,
    );
  });

  it("turns safe mode off for an explicit /image prompt and pins generation off", async () => {
    mockGlmCapabilities(["functionCalling", "supportsVision"]);
    mockImageSettings({ imageSafeMode: true, imageSafeModePromptDismissed: false });
    mocks.imagePromptMayBeExplicit.mockResolvedValue(true);
    const user = userEvent.setup();
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    mockImageGenerationSuccess();

    await user.type(await screen.findByRole("textbox"), "/image a red bicycle");
    fireEvent.submit(document.querySelector(".agent-composer") as HTMLFormElement);

    const dialog = await screen.findByRole("dialog", { name: "Safe mode is on" });
    await user.click(within(dialog).getByRole("button", { name: "Turn off safe mode" }));

    await screen.findByRole("img", { name: "a red bicycle" });
    expect(mocks.setImageSafeMode).toHaveBeenCalledWith(false);
    expect(mocks.generateImage).toHaveBeenCalledWith(
      "a red bicycle",
      "venice-sd35",
      expect.any(String),
      false,
    );
  });

  it("dismisses safe-mode consent without creating an /image session or clearing the draft", async () => {
    mockGlmCapabilities(["functionCalling", "supportsVision"]);
    mockImageSettings({ imageSafeMode: true, imageSafeModePromptDismissed: false });
    mocks.imagePromptMayBeExplicit.mockResolvedValue(true);
    const user = userEvent.setup();
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    mocks.gatewayRequest.mockClear();

    await user.type(await screen.findByRole("textbox"), "/image a red bicycle");
    fireEvent.submit(document.querySelector(".agent-composer") as HTMLFormElement);

    await screen.findByRole("dialog", { name: "Safe mode is on" });
    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Safe mode is on" })).not.toBeInTheDocument(),
    );
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("session.create", expect.anything());
    expect(mocks.generateImage).not.toHaveBeenCalled();
    expect(await screen.findByRole("textbox")).toHaveTextContent("/image a red bicycle");
  });

  it("releases the session FIFO when unmounting during media consent", async () => {
    mockGlmCapabilities(["functionCalling", "supportsVision"]);
    mockImageSettings({ imageSafeMode: true, imageSafeModePromptDismissed: false });
    mocks.imagePromptMayBeExplicit.mockResolvedValue(true);
    const user = userEvent.setup();
    const view = render(<AgentWorkspace initialSession={existingSession} />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    await user.type(await screen.findByRole("textbox"), "/image a red bicycle");
    fireEvent.submit(document.querySelector(".agent-composer") as HTMLFormElement);
    await screen.findByRole("dialog", { name: "Safe mode is on" });

    view.unmount();
    const laterReservation = reserveHermesSessionDispatch("session-1");
    const laterDispatch = vi.fn(async () => undefined);
    await laterReservation.run(laterDispatch);
    expect(laterDispatch).toHaveBeenCalledOnce();
  });

  it("skips an explicit /video generation when the user keeps safe mode on", async () => {
    mockGlmCapabilities(["functionCalling"]);
    mockVideoSettings({ imageSafeMode: true, imageSafeModePromptDismissed: false });
    mocks.imagePromptMayBeExplicit.mockResolvedValue(true);
    const user = userEvent.setup();
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    mocks.gatewayRequest.mockClear();

    await user.type(await screen.findByRole("textbox"), "/video a nude scene");
    fireEvent.submit(document.querySelector(".agent-composer") as HTMLFormElement);

    const dialog = await screen.findByRole("dialog", { name: "Safe mode is on" });
    // The dedicated video dialog explains the skip semantics (Venice cannot
    // blur video, so there is no blurred fallback to offer) and leads with
    // "Skip this video" instead of the image dialog's "Keep safe mode on".
    expect(within(dialog).getByText(/Safe mode can't blur videos/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Skip this video" })).toHaveFocus();
    await user.click(within(dialog).getByRole("checkbox", { name: "Don't ask again" }));
    await user.click(within(dialog).getByRole("button", { name: "Skip this video" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Safe mode is on" })).not.toBeInTheDocument(),
    );
    expect(mocks.videoGenerate).not.toHaveBeenCalled();
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("session.create", expect.anything());
    expect(mocks.setImageSafeModePromptDismissed).toHaveBeenCalledWith(true);
    expect(mocks.setImageSafeMode).not.toHaveBeenCalled();
    // The draft survives the skip so the user can rephrase or change settings.
    expect(await screen.findByRole("textbox")).toHaveTextContent("/video a nude scene");
  });

  it("skips an explicit /video prompt with a notice when the consent dialog was dismissed for good", async () => {
    // "Don't ask again" opts out of the dialog, not out of safe mode: the
    // enforcement point for video is the gate itself, so an explicit prompt
    // still skips - with an inline notice instead of a question.
    mockGlmCapabilities(["functionCalling"]);
    mockVideoSettings({ imageSafeMode: true, imageSafeModePromptDismissed: true });
    mocks.imagePromptMayBeExplicit.mockResolvedValue(true);
    const user = userEvent.setup();
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    mocks.gatewayRequest.mockClear();

    await user.type(await screen.findByRole("textbox"), "/video a nude scene");
    fireEvent.submit(document.querySelector(".agent-composer") as HTMLFormElement);

    expect(
      await screen.findByText(
        "Safe mode is on, so this video was skipped. Turn safe mode off in Settings to generate it.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Safe mode is on" })).not.toBeInTheDocument();
    expect(mocks.videoGenerate).not.toHaveBeenCalled();
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("session.create", expect.anything());
  });

  it("turns safe mode off for an explicit /video prompt and generates", async () => {
    mockGlmCapabilities(["functionCalling"]);
    mockVideoSettings({ imageSafeMode: true, imageSafeModePromptDismissed: false });
    mocks.imagePromptMayBeExplicit.mockResolvedValue(true);
    mockVideoGenerationSuccess();
    const user = userEvent.setup();
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    await user.type(await screen.findByRole("textbox"), "/video a nude scene");
    fireEvent.submit(document.querySelector(".agent-composer") as HTMLFormElement);

    const dialog = await screen.findByRole("dialog", { name: "Safe mode is on" });
    await user.click(within(dialog).getByRole("button", { name: "Turn off safe mode" }));

    await screen.findByRole("button", { name: "Download video" });
    expect(mocks.setImageSafeMode).toHaveBeenCalledWith(false);
    expect(mocks.videoGenerate).toHaveBeenCalledTimes(1);
  });

  it("generates /video without consent when the prompt screens clean", async () => {
    mockGlmCapabilities(["functionCalling"]);
    mockVideoSettings({ imageSafeMode: true, imageSafeModePromptDismissed: false });
    mocks.imagePromptMayBeExplicit.mockResolvedValue(false);
    mockVideoGenerationSuccess();
    const user = userEvent.setup();
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    mocks.imagePromptMayBeExplicit.mockClear();

    await user.type(await screen.findByRole("textbox"), "/video a red bicycle");
    fireEvent.submit(document.querySelector(".agent-composer") as HTMLFormElement);

    await screen.findByRole("button", { name: "Download video" });
    expect(screen.queryByRole("dialog", { name: "Safe mode is on" })).not.toBeInTheDocument();
    expect(mocks.imagePromptMayBeExplicit).toHaveBeenCalledWith("a red bicycle");
    expect(mocks.videoGenerate).toHaveBeenCalledTimes(1);
  });

  it("removes the persisted /video pending turn after a terminal submit failure", async () => {
    mockGlmCapabilities(["functionCalling"]);
    mockVideoSettings({ imageSafeMode: false, imageSafeModePromptDismissed: false });
    mocks.videoGenerate.mockResolvedValueOnce({ jobId: "video-job-terminal" });
    mocks.videoStatus.mockResolvedValueOnce({
      status: "failed",
      reason: "provider rejected the video",
    });
    const user = userEvent.setup();
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    await user.type(await screen.findByRole("textbox"), "/video a red bicycle");
    fireEvent.submit(document.querySelector(".agent-composer") as HTMLFormElement);

    expect(await screen.findByText("provider rejected the video")).toBeInTheDocument();
    expect(storedVideoSlashTurnsForTest()).toEqual([]);
  });

  it("polls an already-paid video job after the last credit is spent", async () => {
    mockGlmCapabilities(["functionCalling"]);
    mockVideoSettings({ imageSafeMode: false, imageSafeModePromptDismissed: false });
    mocks.videoGenerate.mockResolvedValueOnce({ jobId: "video-job-last-credit" });
    mocks.videoStatus.mockRejectedValueOnce(new Error("video delivery unavailable"));
    const user = userEvent.setup();
    const view = render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    await user.type(await screen.findByRole("textbox"), "/video a red bicycle");
    fireEvent.submit(document.querySelector(".agent-composer") as HTMLFormElement);
    expect(await screen.findByText("video delivery unavailable")).toBeInTheDocument();
    const firstRequestId = mocks.videoGenerate.mock.calls[0]?.[0]?.requestId;
    expect(firstRequestId).toEqual(expect.any(String));

    view.rerender(
      <AgentWorkspace creditActionsDisabledReason="Add credits to use video generation." />,
    );

    mocks.videoStatus.mockResolvedValueOnce({
      status: "completed",
      path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/videos/generated-video-last-credit.mp4",
      mimeType: "video/mp4",
      sizeBytes: 5,
      model: "wan-2.2-a14b-text-to-video",
    });

    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(screen.getByText("Add credits to use video generation.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("button", { name: "Download video" })).toBeInTheDocument();
    expect(mocks.videoGenerate).toHaveBeenCalledOnce();
    expect(mocks.videoGenerate.mock.calls[0]?.[0]?.requestId).toBe(firstRequestId);
    expect(mocks.videoStatus).toHaveBeenLastCalledWith("video-job-last-credit");
  });

  it("keeps the persisted /video pending turn when the submit poll budget expires", async () => {
    mockGlmCapabilities(["functionCalling"]);
    mockVideoSettings({ imageSafeMode: false, imageSafeModePromptDismissed: false });
    mocks.videoGenerate.mockResolvedValueOnce({ jobId: "video-job-slow" });
    mocks.videoStatus.mockResolvedValue({
      status: "processing",
      averageExecutionMs: 920_000,
      executionMs: 900_000,
    });
    const user = userEvent.setup();
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await user.type(await screen.findByRole("textbox"), "/video a slow render");

    vi.useFakeTimers();
    try {
      fireEvent.submit(document.querySelector(".agent-composer") as HTMLFormElement);
      await settleUnderFakeTimers(() =>
        expect(screen.getByText("Generating video…")).toHaveClass("text-shimmer", "shimmer"),
      );
      // The note under the frame carries either the fallback copy or, once the
      // first status poll lands, the elapsed-time progress.
      expect(document.querySelector(".agent-generated-media-note")).not.toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(900_000);
      });

      expect(mocks.videoStatus).toHaveBeenCalledTimes(360);
      expect(storedVideoSlashTurnsForTest()).toEqual([
        expect.objectContaining({
          pending: true,
          jobId: "video-job-slow",
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes the persisted /video pending turn after a terminal resume failure", async () => {
    window.localStorage.setItem(
      "june:agent:video-slash-turns",
      JSON.stringify({
        "session-1": [
          {
            id: "video:session-1:1",
            prompt: "a stale render",
            path: "",
            name: "",
            createdAt: "2026-06-04T12:00:00.000Z",
            videoCreatedAt: "2026-06-04T12:00:00.001Z",
            pending: true,
            requestId: "video-request-stale",
            model: "wan-2.2-a14b-text-to-video",
            jobId: "video-job-stale",
          },
        ],
      }),
    );
    mocks.videoStatus.mockResolvedValueOnce({
      status: "failed",
      reason: "job expired",
    });

    render(<AgentWorkspace initialSession={existingSession} />);

    expect(await screen.findByText("job expired")).toBeInTheDocument();
    expect(storedVideoSlashTurnsForTest()).toEqual([]);
  });

  it("skips the /video prompt screen entirely when safe mode is off", async () => {
    mockGlmCapabilities(["functionCalling"]);
    mockVideoSettings({ imageSafeMode: false, imageSafeModePromptDismissed: false });
    mockVideoGenerationSuccess();
    const user = userEvent.setup();
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    mocks.imagePromptMayBeExplicit.mockClear();

    await user.type(await screen.findByRole("textbox"), "/video a red bicycle");
    fireEvent.submit(document.querySelector(".agent-composer") as HTMLFormElement);

    await screen.findByRole("button", { name: "Download video" });
    expect(mocks.imagePromptMayBeExplicit).not.toHaveBeenCalled();
  });

  it("carries /video fast-path context into the next message so a follow-up has it in context", async () => {
    // The /video fast path never invokes the model (skipPrompt), so without
    // the fold a follow-up reads as the first message of the conversation.
    // The context rides the next prompt.submit under --- Attached Context ---
    // (stripped from every user-bubble render) and is sent exactly once.
    mockGlmCapabilities(["functionCalling"]);
    mockVideoSettings({ imageSafeMode: false, imageSafeModePromptDismissed: false });
    mockVideoGenerationSuccess();
    const user = userEvent.setup();
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    await user.type(await screen.findByRole("textbox"), "/video puppies playing");
    fireEvent.submit(document.querySelector(".agent-composer") as HTMLFormElement);
    await screen.findByRole("button", { name: "Download video" });

    mocks.gatewayRequest.mockClear();
    await user.type(await screen.findByRole("textbox"), "add another puppy");
    const sendButton = screen.getByRole("button", { name: "Send message" });
    await waitFor(() => expect(sendButton).not.toBeDisabled());
    await user.click(sendButton);

    await waitFor(() =>
      expect(mocks.gatewayRequest.mock.calls.some(([method]) => method === "prompt.submit")).toBe(
        true,
      ),
    );
    const submitText = (
      mocks.gatewayRequest.mock.calls.find(([method]) => method === "prompt.submit")?.[1] as {
        text: string;
      }
    ).text;
    expect(submitText).toContain("add another puppy");
    expect(submitText).toContain("--- Attached Context ---");
    expect(submitText).toContain('"puppies playing"');
    expect(submitText).toContain("generated-video-1.mp4");
    expect(submitText).toContain("generate_video");

    // The fold is cleared once it rides a successful prompt: the stored turn
    // drops contextPending, so the next follow-up submits plain text.
    const stored = JSON.parse(
      window.localStorage.getItem("june:agent:video-slash-turns") ?? "{}",
    ) as Record<string, Array<{ contextPending?: boolean }>>;
    const storedTurns = Object.values(stored).flat();
    expect(storedTurns.length).toBeGreaterThan(0);
    expect(storedTurns.every((turn) => turn.contextPending === false)).toBe(true);
  });

  it("shows safe-mode consent when the agent image event arrives", async () => {
    mockImageSettings({ imageSafeMode: true, imageSafeModePromptDismissed: false });
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    await emitImageSafeModeConsent();

    const dialog = await screen.findByRole("dialog", { name: "Safe mode is on" });
    expect(
      within(dialog).getByText(/June is generating an image that may include adult content/i),
    ).toBeInTheDocument();
  });

  it("drops duplicate agent safe-mode consent events while the dialog is open", async () => {
    mockImageSettings({ imageSafeMode: true, imageSafeModePromptDismissed: false });
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    await emitImageSafeModeConsent("first prompt");
    await screen.findByRole("dialog", { name: "Safe mode is on" });
    mocks.providerModelSettings.mockClear();

    await emitImageSafeModeConsent("second prompt");

    expect(screen.getAllByRole("dialog", { name: "Safe mode is on" })).toHaveLength(1);
    expect(mocks.providerModelSettings).not.toHaveBeenCalled();
  });

  it("keeps safe mode on for an agent image event and persists don't ask again", async () => {
    mockImageSettings({ imageSafeMode: true, imageSafeModePromptDismissed: false });
    const user = userEvent.setup();
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    await emitImageSafeModeConsent();
    const dialog = await screen.findByRole("dialog", { name: "Safe mode is on" });
    await user.click(within(dialog).getByRole("checkbox", { name: "Don't ask again" }));
    await user.click(within(dialog).getByRole("button", { name: "Keep safe mode on" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Safe mode is on" })).not.toBeInTheDocument(),
    );
    expect(mocks.setImageSafeModePromptDismissed).toHaveBeenCalledWith(true);
    expect(mocks.setImageSafeMode).not.toHaveBeenCalled();
    expect(mocks.generateImage).not.toHaveBeenCalled();
  });

  it("turns safe mode off for an agent image event and persists don't ask again", async () => {
    mockImageSettings({ imageSafeMode: true, imageSafeModePromptDismissed: false });
    const user = userEvent.setup();
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    await emitImageSafeModeConsent();
    const dialog = await screen.findByRole("dialog", { name: "Safe mode is on" });
    await user.click(within(dialog).getByRole("checkbox", { name: "Don't ask again" }));
    await user.click(within(dialog).getByRole("button", { name: "Turn off safe mode" }));

    await waitFor(() => expect(mocks.setImageSafeMode).toHaveBeenCalledWith(false));
    expect(mocks.setImageSafeModePromptDismissed).toHaveBeenCalledWith(true);
    expect(mocks.generateImage).not.toHaveBeenCalled();
  });

  it("dismisses agent safe-mode consent without persisting a choice", async () => {
    mockImageSettings({ imageSafeMode: true, imageSafeModePromptDismissed: false });
    const user = userEvent.setup();
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    await emitImageSafeModeConsent();
    await screen.findByRole("dialog", { name: "Safe mode is on" });
    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Safe mode is on" })).not.toBeInTheDocument(),
    );
    expect(mocks.setImageSafeMode).not.toHaveBeenCalled();
    expect(mocks.setImageSafeModePromptDismissed).not.toHaveBeenCalled();
    expect(mocks.generateImage).not.toHaveBeenCalled();
  });

  it("drops stale agent safe-mode consent events when safe mode is already off", async () => {
    mockImageSettings({ imageSafeMode: false, imageSafeModePromptDismissed: false });
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    await emitImageSafeModeConsent();

    expect(screen.queryByRole("dialog", { name: "Safe mode is on" })).not.toBeInTheDocument();
    expect(mocks.setImageSafeMode).not.toHaveBeenCalled();
    expect(mocks.setImageSafeModePromptDismissed).not.toHaveBeenCalled();
  });

  it("reuses the failed /image request id when the user retries the same turn", async () => {
    mockGlmCapabilities(["functionCalling", "supportsVision"]);
    const user = userEvent.setup();
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    mocks.generateImage.mockRejectedValueOnce(new Error("gateway timeout")).mockResolvedValueOnce({
      imageBase64: "aGVsbG8=",
      mimeType: "image/png",
      model: "venice-sd35",
      provider: "venice",
    });
    mocks.importHermesBridgeFileBytes.mockResolvedValueOnce({
      name: "generated-image.png",
      path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace/uploads/generated-image.png",
      rootLabel: "Workspace",
      size: 5,
      previewDataUrl: "data:image/png;base64,preview",
    });

    await user.type(await screen.findByRole("textbox"), "/image a red bicycle");
    fireEvent.submit(document.querySelector(".agent-composer") as HTMLFormElement);

    expect(await screen.findByText("gateway timeout")).toBeInTheDocument();
    const firstRequestId = mocks.generateImage.mock.calls[0]?.[2];
    expect(firstRequestId).toEqual(expect.any(String));

    await user.click(screen.getByRole("button", { name: "Try again" }));

    await screen.findByRole("img", { name: "a red bicycle" });
    expect(mocks.generateImage).toHaveBeenCalledTimes(2);
    expect(mocks.generateImage.mock.calls[1]?.[2]).toBe(firstRequestId);
    expect(mocks.importHermesBridgeFileBytes).toHaveBeenCalledTimes(1);
  });

  it("replays an already-paid image request after the last credit is spent", async () => {
    mockGlmCapabilities(["functionCalling", "supportsVision"]);
    const user = userEvent.setup();
    const view = render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    mocks.generateImage.mockResolvedValue({
      imageBase64: "aGVsbG8=",
      mimeType: "image/png",
      model: "venice-sd35",
      provider: "venice",
    });
    mocks.importHermesBridgeFileBytes
      .mockRejectedValueOnce(new Error("image delivery unavailable"))
      .mockResolvedValueOnce({
        name: "generated-image.png",
        path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace/uploads/generated-image.png",
        rootLabel: "Workspace",
        size: 5,
        previewDataUrl: "data:image/png;base64,preview",
      });
    await user.type(await screen.findByRole("textbox"), "/image a red bicycle");
    fireEvent.submit(document.querySelector(".agent-composer") as HTMLFormElement);
    expect(await screen.findByText("image delivery unavailable")).toBeInTheDocument();
    const firstRequestId = mocks.generateImage.mock.calls[0]?.[2];
    expect(firstRequestId).toEqual(expect.any(String));

    view.rerender(
      <AgentWorkspace creditActionsDisabledReason="Add credits to use image generation." />,
    );

    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(screen.getByText("Add credits to use image generation.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    await screen.findByRole("img", { name: "a red bicycle" });
    expect(mocks.generateImage).toHaveBeenCalledTimes(2);
    expect(mocks.generateImage.mock.calls[1]?.[2]).toBe(firstRequestId);
  });

  it("replays the pinned image shape when settings change before retry", async () => {
    mockGlmCapabilities(["functionCalling", "supportsVision"]);
    const user = userEvent.setup();
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    // June API's replay ledger hashes model + safe mode into the requestId's
    // key, so the retry must resend the values the turn started with - not the
    // settings at retry time - or one visible turn becomes two charges.
    mocks.providerModelSettings.mockResolvedValue({
      settings: {
        transcriptionProvider: "venice",
        transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
        generationModel: "zai-org-glm-5-2",
        imageModel: "venice-sd35",
        imageSafeMode: false,
        imageSafeModePromptDismissed: false,
      },
    });
    mocks.generateImage.mockRejectedValueOnce(new Error("gateway timeout")).mockResolvedValueOnce({
      imageBase64: "aGVsbG8=",
      mimeType: "image/png",
      model: "venice-sd35",
      provider: "venice",
    });
    mocks.importHermesBridgeFileBytes.mockResolvedValueOnce({
      name: "generated-image.png",
      path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace/uploads/generated-image.png",
      rootLabel: "Workspace",
      size: 5,
      previewDataUrl: "data:image/png;base64,preview",
    });

    await user.type(await screen.findByRole("textbox"), "/image a red bicycle");
    fireEvent.submit(document.querySelector(".agent-composer") as HTMLFormElement);

    expect(await screen.findByText("gateway timeout")).toBeInTheDocument();
    expect(mocks.generateImage).toHaveBeenCalledWith(
      "a red bicycle",
      "venice-sd35",
      expect.any(String),
      false,
    );
    const firstRequestId = mocks.generateImage.mock.calls[0]?.[2];

    // Settings drift between the failed attempt and the retry.
    mocks.providerModelSettings.mockResolvedValue({
      settings: {
        transcriptionProvider: "venice",
        transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
        generationModel: "zai-org-glm-5-2",
        imageModel: "flux-2-pro",
        imageSafeMode: true,
        imageSafeModePromptDismissed: false,
      },
    });

    await user.click(screen.getByRole("button", { name: "Try again" }));

    await screen.findByRole("img", { name: "a red bicycle" });
    expect(mocks.generateImage).toHaveBeenCalledTimes(2);
    expect(mocks.generateImage.mock.calls[1]).toEqual([
      "a red bicycle",
      "venice-sd35",
      firstRequestId,
      false,
    ]);
  });

  it("restores a /image prompt and generated image above the preview cap with context after remount", async () => {
    mockGlmCapabilities(["functionCalling", "supportsVision"]);
    const user = userEvent.setup();
    const { unmount } = render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    mocks.generateImage.mockResolvedValueOnce({
      imageBase64: "aGVsbG8=",
      mimeType: "image/png",
      model: "venice-sd35",
      provider: "venice",
    });
    mocks.importHermesBridgeFileBytes.mockResolvedValueOnce({
      name: "generated-image.png",
      path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace/uploads/generated-image.png",
      rootLabel: "Workspace",
      size: 5,
      previewDataUrl: "data:image/png;base64,preview",
    });

    await user.type(await screen.findByRole("textbox"), "/image a red bicycle");
    fireEvent.submit(document.querySelector(".agent-composer") as HTMLFormElement);
    await screen.findByRole("img", { name: "a red bicycle" });
    expect(screen.getByText("a red bicycle")).toBeInTheDocument();

    unmount();
    resetAgentSessionContinuity();
    mocks.gatewayRequest.mockClear();
    mocks.hermesBridgeFilePreview.mockResolvedValue(null);
    mocks.hermesBridgeImageDataUrl.mockResolvedValue("data:image/png;base64,ZnVsbC1zaXpl");
    render(<AgentWorkspace />);

    expect(await screen.findByText("a red bicycle")).toBeInTheDocument();

    await user.type(await screen.findByRole("textbox"), "what do you think");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("image.attach_bytes", {
        session_id: "runtime-session-1",
        mime_type: "image/png",
        content_base64: "ZnVsbC1zaXpl",
        filename: "generated-image.png",
      }),
    );
    expect(mocks.hermesBridgeImageDataUrl).toHaveBeenCalledWith(
      "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace/uploads/generated-image.png",
    );
    const attachIndex = mocks.gatewayRequest.mock.calls.findIndex(
      ([method]) => method === "image.attach_bytes",
    );
    const submitIndex = mocks.gatewayRequest.mock.calls.findIndex(
      ([method]) => method === "prompt.submit",
    );
    expect(attachIndex).toBeGreaterThanOrEqual(0);
    expect(submitIndex).toBeGreaterThan(attachIndex);
  });

  it("recovers an interrupted /image turn after remount and retries with the same request id", async () => {
    mockGlmCapabilities(["functionCalling", "supportsVision"]);
    const user = userEvent.setup();
    const { unmount } = render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    mocks.providerModelSettings.mockResolvedValue({
      settings: {
        transcriptionProvider: "venice",
        transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
        generationModel: "zai-org-glm-5-2",
        imageModel: "venice-sd35",
        imageSafeMode: false,
        imageSafeModePromptDismissed: false,
      },
    });
    // The paid request never settles client-side - the app "exits" while the
    // generation is in flight, after June API may already have started work.
    mocks.generateImage.mockImplementationOnce(() => new Promise(() => {}));

    await user.type(await screen.findByRole("textbox"), "/image a red bicycle");
    fireEvent.submit(document.querySelector(".agent-composer") as HTMLFormElement);
    await waitFor(() => expect(mocks.generateImage).toHaveBeenCalledTimes(1));
    const firstRequestId = mocks.generateImage.mock.calls[0]?.[2];
    expect(firstRequestId).toEqual(expect.any(String));

    unmount();
    resetAgentSessionContinuity();
    render(<AgentWorkspace />);

    // The turn is restored as retryable instead of silently lost.
    expect(
      await screen.findByText("Generation was interrupted. Try again to resume."),
    ).toBeInTheDocument();

    mocks.generateImage.mockResolvedValueOnce({
      imageBase64: "aGVsbG8=",
      mimeType: "image/png",
      model: "venice-sd35",
      provider: "venice",
    });
    mocks.importHermesBridgeFileBytes.mockResolvedValueOnce({
      name: "generated-image.png",
      path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace/uploads/generated-image.png",
      rootLabel: "Workspace",
      size: 5,
      previewDataUrl: "data:image/png;base64,preview",
    });
    await user.click(screen.getByRole("button", { name: "Try again" }));

    // The retry replays the exact request June API hashed into its ledger key:
    // same request id, same pinned model and safe mode.
    await screen.findByRole("img", { name: "a red bicycle" });
    expect(mocks.generateImage).toHaveBeenCalledTimes(2);
    expect(mocks.generateImage.mock.calls[1]).toEqual([
      "a red bicycle",
      "venice-sd35",
      firstRequestId,
      false,
    ]);
  });

  it.each([
    "make it better",
    "change my mind",
    "let's try again",
    "new version of the doc",
  ])("submits generic image-session follow-up through the model instead of an image fast path: %s", async (followUp) => {
    mockGlmCapabilities(["functionCalling", "supportsVision"]);
    const user = userEvent.setup();
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    mocks.generateImage.mockResolvedValueOnce({
      imageBase64: "aGVsbG8=",
      mimeType: "image/png",
      model: "venice-sd35",
      provider: "venice",
    });
    mocks.importHermesBridgeFileBytes.mockResolvedValueOnce({
      name: "generated-image.png",
      path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace/uploads/generated-image.png",
      rootLabel: "Workspace",
      size: 5,
      previewDataUrl: "data:image/png;base64,preview",
    });

    await user.type(await screen.findByRole("textbox"), "/image a red bicycle");
    fireEvent.submit(document.querySelector(".agent-composer") as HTMLFormElement);
    await screen.findByRole("img", { name: "a red bicycle" });

    mocks.generateImage.mockClear();
    mocks.editImage.mockClear();
    mocks.gatewayRequest.mockClear();
    await user.type(await screen.findByRole("textbox"), followUp);
    const sendButton = screen.getByRole("button", { name: "Send message" });
    await waitFor(() => expect(sendButton).not.toBeDisabled());
    await user.click(sendButton);

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: `${followUp}\n\n--- Attached Context ---\nPrevious /image request: a red bicycle`,
      }),
    );
    expect(mocks.generateImage).not.toHaveBeenCalled();
    expect(mocks.editImage).not.toHaveBeenCalled();
  });

  it("keeps /image follow-ups in model context after an image-session follow-up", async () => {
    mockGlmCapabilities(["functionCalling", "supportsVision"]);
    const user = userEvent.setup();
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    mocks.generateImage.mockResolvedValueOnce({
      imageBase64: "aGVsbG8=",
      mimeType: "image/png",
      model: "venice-sd35",
      provider: "venice",
    });
    mocks.importHermesBridgeFileBytes.mockResolvedValueOnce({
      name: "generated-image.png",
      path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace/uploads/generated-image.png",
      rootLabel: "Workspace",
      size: 5,
      previewDataUrl: "data:image/png;base64,preview",
    });

    await user.type(await screen.findByRole("textbox"), "/image june the assistant");
    fireEvent.submit(document.querySelector(".agent-composer") as HTMLFormElement);
    await screen.findByRole("img", { name: "june the assistant" });

    mocks.gatewayRequest.mockClear();
    await user.type(await screen.findByRole("textbox"), "make it feel calmer");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("image.attach_bytes", {
        session_id: "runtime-session-1",
        mime_type: "image/png",
        content_base64: "aGVsbG8=",
        filename: "generated-image.png",
      }),
    );
    expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
      session_id: "runtime-session-1",
      text: "make it feel calmer\n\n--- Attached Context ---\nPrevious /image request: june the assistant",
    });
    const attachIndex = mocks.gatewayRequest.mock.calls.findIndex(
      ([method]) => method === "image.attach_bytes",
    );
    const submitIndex = mocks.gatewayRequest.mock.calls.findIndex(
      ([method]) => method === "prompt.submit",
    );
    expect(attachIndex).toBeGreaterThanOrEqual(0);
    expect(submitIndex).toBeGreaterThan(attachIndex);
  });

  it("blocks /image on a non-vision model until the user switches explicitly", async () => {
    mocks.listAgentTasks.mockResolvedValue({ items: [] });
    mocks.listHermesSessions.mockResolvedValue([]);
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
        capabilities: ["functionCalling", "supportsVision"],
      },
    ];
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: "zai-org-glm-5-2",
      models: catalog,
    });
    mocks.setVeniceModel.mockResolvedValue(undefined);
    mocks.generateImage.mockResolvedValueOnce({
      imageBase64: "aGVsbG8=",
      mimeType: "image/png",
      model: "venice-sd35",
      provider: "venice",
    });
    const user = userEvent.setup();
    render(<AgentWorkspace />);

    await user.type(await screen.findByRole("textbox"), "/image a red bicycle");
    expect(
      await screen.findByText(
        "GLM 5.2 can't read images. Switch to a vision model before using /image.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start session" })).toBeDisabled();

    fireEvent.submit(document.querySelector(".agent-composer") as HTMLFormElement);
    expect(mocks.setVeniceModel).not.toHaveBeenCalled();
    expect(mocks.generateImage).not.toHaveBeenCalled();

    mocks.providerModelSettings.mockResolvedValue({
      settings: {
        transcriptionProvider: "venice",
        transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
        generationModel: "kimi-k2-6",
      },
    });
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: "kimi-k2-6",
      models: catalog,
    });
    await user.click(screen.getByRole("button", { name: "Switch to Kimi K2.6" }));
    await waitFor(() =>
      expect(mocks.setVeniceModel).toHaveBeenCalledWith("generation", "kimi-k2-6"),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start session" })).not.toBeDisabled(),
    );
    fireEvent.submit(document.querySelector(".agent-composer") as HTMLFormElement);

    await screen.findByRole("img", { name: "a red bicycle" });
    expect(mocks.gatewayRequest).toHaveBeenCalledWith(
      "session.create",
      expect.objectContaining({ model: "__june_remote_generation__:kimi-k2-6" }),
    );
    expect(mocks.ensureHermesBridgeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-2",
        model: "__june_remote_generation__:kimi-k2-6",
      }),
    );
  });

  it("carries a /image fast-path image into the next message so a follow-up has it in context (JUN-171 Phase A)", async () => {
    // JUN-171: the /image image renders in-thread but must also enter the
    // model's session history, so a follow-up ("what do you think?") reaches the
    // model WITH the image. On a vision model the held image is sent via
    // image.attach_bytes before that follow-up's prompt.submit — and with NO
    // composer chip in between (it already renders in-thread).
    mockGlmCapabilities(["functionCalling", "supportsVision"]);
    const user = userEvent.setup();
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    mocks.generateImage.mockResolvedValueOnce({
      imageBase64: "aGVsbG8=",
      mimeType: "image/png",
      model: "venice-sd35",
      provider: "venice",
    });

    await user.type(await screen.findByRole("textbox"), "/image a red bicycle");
    fireEvent.submit(document.querySelector(".agent-composer") as HTMLFormElement);

    // The fast-path image renders in-thread with no composer chip.
    await screen.findByRole("img", { name: "a red bicycle" });
    expect(document.querySelector(".agent-attachment-chip")).toBeNull();
    // The /image itself never attaches (no prompt to carry it yet).
    expect(
      mocks.gatewayRequest.mock.calls.some(([method]) => method === "image.attach_bytes"),
    ).toBe(false);

    await user.type(await screen.findByRole("textbox"), "what do you think");
    const sendButton = screen.getByRole("button", { name: "Send message" });
    await waitFor(() => expect(sendButton).not.toBeDisabled());
    await user.click(sendButton);

    // The generated image lands in the session via image.attach_bytes, keyed to
    // the same session, before the follow-up prompt.submit.
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("image.attach_bytes", {
        session_id: "runtime-session-1",
        mime_type: "image/png",
        content_base64: "aGVsbG8=",
        filename: expect.stringMatching(/^generated-image-\d+\.png$/),
      }),
    );
    const attachIndex = mocks.gatewayRequest.mock.calls.findIndex(
      ([method]) => method === "image.attach_bytes",
    );
    const submitIndex = mocks.gatewayRequest.mock.calls.findIndex(
      ([method]) => method === "prompt.submit",
    );
    expect(attachIndex).toBeGreaterThanOrEqual(0);
    expect(submitIndex).toBeGreaterThan(attachIndex);
    // Attached exactly once — the held image is cleared after it goes through,
    // not re-sent.
    expect(
      mocks.gatewayRequest.mock.calls.filter(([method]) => method === "image.attach_bytes"),
    ).toHaveLength(1);
    expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
      session_id: "runtime-session-1",
      text: "what do you think\n\n--- Attached Context ---\nPrevious /image request: a red bicycle",
    });
  });

  it("attaches a /image fast-path image from generated bytes when preview is unavailable", async () => {
    mockGlmCapabilities(["functionCalling", "supportsVision"]);
    mocks.hermesBridgeFilePreview.mockResolvedValue(null);
    const user = userEvent.setup();
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    mocks.generateImage.mockResolvedValueOnce({
      imageBase64: "aGVsbG8=",
      mimeType: "image/png",
      model: "venice-sd35",
      provider: "venice",
    });

    await user.type(await screen.findByRole("textbox"), "/image a large red bicycle");
    fireEvent.submit(document.querySelector(".agent-composer") as HTMLFormElement);
    await screen.findByRole("img", { name: "a large red bicycle" });

    await user.type(await screen.findByRole("textbox"), "what do you think");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("image.attach_bytes", {
        session_id: "runtime-session-1",
        mime_type: "image/png",
        content_base64: "aGVsbG8=",
        filename: expect.stringMatching(/^generated-image-\d+\.png$/),
      }),
    );
  });

  it("keeps a held /image fast-path image when the follow-up submit fails", async () => {
    mockGlmCapabilities(["functionCalling", "supportsVision"]);
    let promptSubmitAttempts = 0;
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
      if (method === "prompt.submit") {
        promptSubmitAttempts += 1;
        if (promptSubmitAttempts === 1) {
          return Promise.reject(new Error("temporary submit failure"));
        }
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    mocks.generateImage.mockResolvedValueOnce({
      imageBase64: "aGVsbG8=",
      mimeType: "image/png",
      model: "venice-sd35",
      provider: "venice",
    });

    await user.type(await screen.findByRole("textbox"), "/image a red bicycle");
    fireEvent.submit(document.querySelector(".agent-composer") as HTMLFormElement);
    await screen.findByRole("img", { name: "a red bicycle" });

    await user.type(await screen.findByRole("textbox"), "what do you think");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(promptSubmitAttempts).toBe(1));

    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(promptSubmitAttempts).toBe(2));

    const attachCalls = mocks.gatewayRequest.mock.calls.filter(
      ([method]) => method === "image.attach_bytes",
    );
    expect(attachCalls).toHaveLength(2);
    for (const [, payload] of attachCalls) {
      expect(payload).toMatchObject({
        session_id: "runtime-session-1",
        mime_type: "image/png",
        content_base64: "aGVsbG8=",
      });
    }
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

  it("prefills the composer from a hero shortcut instead of auto-submitting", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now() }),
    );
    // rand() of 0 keeps the rotating hero suggestions in curated pool order,
    // so the leading window (incl. "Recap my notes") is what renders.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      render(<AgentWorkspace />);
      const user = userEvent.setup();

      await user.click(await screen.findByRole("button", { name: /Recap my notes/ }));

      // The click only stages the prompt: nothing may be submitted (and no
      // tokens spent) until the person sends it themselves.
      await waitFor(() =>
        expect(screen.getByRole("textbox")).toHaveTextContent(/action items still open/),
      );
      expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", expect.anything());

      // Staging a prompt counts as "composer has content": the chip row bows
      // out so a second click can't stage over the draft.
      const chips = document.querySelector(".agent-hero-chips");
      expect(chips).toHaveAttribute("data-hidden", "true");

      await user.click(screen.getByRole("button", { name: "Start session" }));

      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith(
          "prompt.submit",
          expect.objectContaining({
            text: expect.stringContaining("action items still open"),
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
      await waitFor(() =>
        expect(composer.textContent ?? "").toContain("Research a topic and write a short summary"),
      );
      // The <placeholder> brackets are authoring syntax; they must never render.
      expect(composer.textContent ?? "").not.toContain("<");
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
    // messages as a send June ignored), and the draft comes back.
    expect(document.querySelector(".agent-user-turn")).toBeNull();
    expect(composer).toHaveTextContent("are the subagents using my CLI?");
    // The previous turn is still running, so the live listener stays attached.
    expect(mocks.gatewayEventHandlers.size).toBe(1);
  });

  it("keeps the prior run authority when a later prompt is rejected as busy", async () => {
    type PersistedMessage = {
      id: string;
      role: "user" | "assistant";
      content: string;
      timestamp: string;
    };
    let persistedMessages: PersistedMessage[] = [];
    let promptSubmitCount = 0;
    const repeatedTimeout = {
      type: "lifecycle.complete",
      session_id: "runtime-session-1",
      payload: { status: "timeout" },
    };
    mocks.listHermesSessionMessages.mockImplementation(async () => persistedMessages);
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      if (method === "prompt.submit") {
        promptSubmitCount += 1;
        if (promptSubmitCount === 3) {
          for (const handler of [...mocks.gatewayEventHandlers]) handler(repeatedTimeout);
          return Promise.reject(new HermesGatewayError("session busy", 4009));
        }
        return Promise.resolve({});
      }
      if (method === "session.active_list") {
        return Promise.resolve({ sessions: [] });
      }
      return Promise.resolve({});
    });

    vi.useFakeTimers();
    try {
      render(<AgentWorkspace initialSession={existingSession} />);
      await settleUnderFakeTimers(() =>
        expect(screen.getByRole("textbox", { name: "Message June" })).toBeInTheDocument(),
      );
      const composer = screen.getByRole("textbox", { name: "Message June" });

      fireEvent.paste(composer, {
        clipboardData: { getData: () => "seed the repeated timeout" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await settleUnderFakeTimers(() => expect(promptSubmitCount).toBe(1));
      persistedMessages = [
        {
          id: "seed-timeout-user",
          role: "user",
          content: "seed the repeated timeout",
          timestamp: new Date().toISOString(),
        },
      ];
      act(() => {
        for (const handler of [...mocks.gatewayEventHandlers]) handler(repeatedTimeout);
      });
      await settleUnderFakeTimers(() =>
        expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
      );

      fireEvent.paste(composer, {
        clipboardData: { getData: () => "finish the accepted run" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await settleUnderFakeTimers(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text: "finish the accepted run",
        }),
      );
      expect([...mocks.gatewayEventHandlers][0]).toBeTypeOf("function");
      persistedMessages = [
        ...persistedMessages,
        {
          id: "accepted-run-user",
          role: "user",
          content: "finish the accepted run",
          timestamp: new Date().toISOString(),
        },
        {
          id: "accepted-run-assistant",
          role: "assistant",
          content: "The accepted run finished.",
          timestamp: new Date().toISOString(),
        },
      ];

      // Simulate a status projection that briefly looks settled while the
      // accepted runtime run and its listener are still authoritative.
      act(() => {
        hermesActivityStore.record(
          {
            kind: "lifecycle",
            sessionId: "session-1",
            flavor: "terminal",
            status: "completed",
            text: "",
            receivedAt: new Date().toISOString(),
          },
          "sandboxed",
        );
      });
      await settleUnderFakeTimers(() =>
        expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
      );

      fireEvent.paste(composer, {
        clipboardData: { getData: () => "this prompt must be rejected" },
      });
      mocks.preserveAgentRunTerminalEvidence.mockClear();
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await settleUnderFakeTimers(() => expect(promptSubmitCount).toBe(3));
      expect(mocks.preserveAgentRunTerminalEvidence).not.toHaveBeenCalled();
      await settleUnderFakeTimers(() =>
        expect(
          screen.getByText(/June is still working on the previous message/),
        ).toBeInTheDocument(),
      );

      const userTurns = Array.from(document.querySelectorAll(".agent-user-turn"));
      expect(
        userTurns.some((turn) => turn.textContent?.includes("this prompt must be rejected")),
      ).toBe(false);
      expect(composer).toHaveTextContent("this prompt must be rejected");
      expect(mocks.gatewayEventHandlers.size).toBe(1);
      mocks.markAgentRunSucceeded.mockClear();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });

      await settleUnderFakeTimers(() =>
        expect(mocks.markAgentRunSucceeded).toHaveBeenCalledWith("session-1", 1),
      );
      expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();
      expect(
        mocks.gatewayRequest.mock.calls.filter(([method]) => method === "prompt.submit"),
      ).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
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
    expect(screen.queryByRole("button", { name: "Send bug report" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Hermes gateway is not connected.")).toBeNull();
  });

  it("shows friendly, retryable copy for a Hermes 5xx from a session command (JUN-167)", async () => {
    const user = userEvent.setup();
    // A bare 500 reaches the bridge as `Hermes API returned 500: Internal
    // Server Error` (deduped from the doubled StatusCode Display) — the raw
    // string the user saw in the chat banner before this fix.
    mocks.listHermesSessionMessages.mockRejectedValue(
      new Error("Hermes API returned 500: Internal Server Error"),
    );

    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    // The banner shows the friendly line, never the raw wire error.
    expect(
      await screen.findByText("June ran into a problem with that request."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Hermes API returned 500/)).toBeNull();
    // A 5xx is a transient server fault, so the banner offers a retry (unlike a
    // one-off 4xx, which only offers dismiss), plus direct bug reporting.
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send bug report" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("June ran into a problem with that request.")).toBeNull();
  });

  it("sends the raw Hermes 5xx as a bug report from the error banner (JUN-167)", async () => {
    const user = userEvent.setup();
    mocks.submitIssueReport.mockResolvedValue({ received: true });
    mocks.listHermesSessionMessages.mockRejectedValue(
      new Error("Hermes API returned 500: Internal Server Error"),
    );

    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    expect(
      await screen.findByText("June ran into a problem with that request."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send bug report" }));

    await waitFor(() =>
      expect(mocks.submitIssueReport).toHaveBeenCalledWith({
        category: "bug",
        description: expect.stringContaining("Hermes API returned 500: Internal Server Error"),
        agentDiagnosis: undefined,
        attachmentNames: [],
        attachmentPaths: [],
        sessionId: "session-1",
      }),
    );
    expect(await screen.findByText(/Your report was sent to the June team/)).toBeInTheDocument();
  });

  it("confirms a no-session Hermes 5xx bug report after sending (JUN-167)", async () => {
    const user = userEvent.setup();
    mocks.submitIssueReport.mockResolvedValue({ received: true });
    mocks.listHermesSessions.mockRejectedValue(
      new Error("Hermes API returned 500: Internal Server Error"),
    );

    render(<AgentWorkspace />);
    expect(
      await screen.findByText("June ran into a problem with that request."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send bug report" }));

    await waitFor(() =>
      expect(mocks.submitIssueReport).toHaveBeenCalledWith({
        category: "bug",
        description: expect.stringContaining("Hermes API returned 500: Internal Server Error"),
        agentDiagnosis: undefined,
        attachmentNames: [],
        attachmentPaths: [],
      }),
    );
    expect(await screen.findByText(/Your report was sent to the June team/)).toBeInTheDocument();
  });

  it("re-fetches the transcript when Try again is clicked on a Hermes 5xx banner (JUN-167)", async () => {
    const user = userEvent.setup();
    mocks.listHermesSessionMessages.mockRejectedValue(
      new Error("Hermes API returned 500: Internal Server Error"),
    );

    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    expect(
      await screen.findByText("June ran into a problem with that request."),
    ).toBeInTheDocument();

    const callsBeforeRetry = mocks.listHermesSessionMessages.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Try again" }));

    // The retry actually re-runs the failed transcript load — not just a
    // reconnect that clears the banner and leaves the messages unfetched.
    await waitFor(() =>
      expect(mocks.listHermesSessionMessages.mock.calls.length).toBeGreaterThan(callsBeforeRetry),
    );
    // The 500 persists, so the friendly banner returns rather than leaving a
    // silently-empty transcript; the raw wire string never appears.
    expect(
      await screen.findByText("June ran into a problem with that request."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Hermes API returned 500/)).toBeNull();
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

  it("maps a Max-gated top-up failure to an upgrade message, not a raw error", async () => {
    const user = userEvent.setup();
    mocks.osAccountsUpgrade.mockRejectedValue({
      code: "top_up_requires_max",
      message: "Buying credits requires the Max plan.",
    });
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

    await screen.findByText(/June stopped because your balance ran out/);
    await user.click(screen.getByRole("button", { name: "Upgrade" }));

    expect(await screen.findByText("Upgrade to Max to keep using credits.")).toBeInTheDocument();
    expect(screen.queryByText("Buying credits requires the Max plan.")).toBeNull();
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
      // Scope to the gallery's inline composer pill: the busy notice now also
      // fires as a toast (.june-toast), so an unscoped text query can also match
      // a busy toast lingering from an earlier test.
      expect(
        screen.getByText(/June is still working on the previous message/, {
          selector: ".agent-composer-notice",
        }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Shimmer text lengths" })).toBeNull();
    } finally {
      // Always reset the module-level desired state — a failure here must not
      // leave the gallery on and cascade into later workspace mounts.
      act(() => void agentErrors(false));
    }
    await waitFor(() => expect(screen.queryByText("Agent error gallery")).toBeNull());
  });

  it("shows production shimmer across text lengths via the __agentGallery() dev handle", async () => {
    const agentGallery = (window as unknown as { __agentGallery: (show?: boolean) => string })
      .__agentGallery;
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    act(() => void agentGallery());

    try {
      expect(await screen.findByText("Agent response gallery")).toBeInTheDocument();
      const heading = screen.getByRole("heading", { name: "Shimmer text lengths" });
      const section = heading.closest("section");
      expect(section).not.toBeNull();

      const samples = Array.from(section?.querySelectorAll(".text-shimmer.shimmer") ?? []);
      const sampleTexts = [
        "Thinking…",
        "Generating image…",
        "Generating video, this can take a minute",
      ];
      expect(samples.map((sample) => sample.textContent)).toEqual(sampleTexts);
      for (const text of sampleTexts) {
        expect(within(section as HTMLElement).getByText(text)).toHaveClass(
          "text-shimmer",
          "shimmer",
        );
      }
      expect(section?.querySelector('[role="status"], [aria-live]')).toBeNull();

      const runningToolSection = screen
        .getByRole("heading", { name: "Thinking: in progress" })
        .closest("section");
      expect(runningToolSection).not.toBeNull();
      expect(
        within(runningToolSection as HTMLElement)
          .getByRole("status", { name: "Running" })
          .querySelector(".dot-spinner"),
      ).not.toBeNull();
    } finally {
      act(() => void agentGallery(false));
    }
    await waitFor(() => expect(screen.queryByText("Agent response gallery")).toBeNull());
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

  describe("session model switching", () => {
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

    it("keeps the open session model picker interactive", async () => {
      mocks.listVeniceModels.mockResolvedValue({
        mode: "generation",
        modelType: "text",
        selectedModel: "zai-org-glm-5-2",
        models: toolCapableCatalog,
      });
      const user = userEvent.setup();

      render(<AgentWorkspace initialSession={existingSession} />);

      await user.click(await screen.findByRole("button", { name: "Model: GLM 5.2" }));
      expect(await screen.findByRole("dialog", { name: "Choose text model" })).toBeInTheDocument();
    });

    it("does not switch the active agent run and applies the latest choice before the next prompt", async () => {
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
      await user.type(composer, "Work through the current response");
      await user.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text: "Work through the current response",
        }),
      );
      mocks.gatewayRequest.mockClear();

      await user.click(screen.getByRole("button", { name: "Model: GLM 5.2" }));
      const dialog = await screen.findByRole("dialog", { name: "Choose text model" });
      await user.click(within(dialog).getByRole("button", { name: "All models" }));
      const panel = await screen.findByRole("group", { name: "All text models" });
      await user.click(within(panel).getByRole("option", { name: /Kimi K2\.6/ }));

      expect(await screen.findByRole("button", { name: "Model: Kimi K2.6" })).toBeInTheDocument();
      expect(mocks.setVeniceModel).not.toHaveBeenCalled();
      expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("config.set", expect.anything());
      expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("session.interrupt", expect.anything());

      act(() => {
        for (const handler of mocks.gatewayEventHandlers) {
          handler({
            type: "message.complete",
            session_id: "runtime-session-1",
            payload: { text: "Current response finished." },
          });
          handler({
            type: "turn.completed",
            session_id: "runtime-session-1",
            payload: { status: "success" },
          });
        }
      });

      await user.type(composer, "Start the next response");
      await user.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("config.set", {
          session_id: "runtime-session-1",
          key: "model",
          value: "__june_remote_generation__:kimi-k2-6 --session",
          confirm_expensive_model: true,
        }),
      );
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "Start the next response",
      });
      const methods = mocks.gatewayRequest.mock.calls.map(([method]) => method);
      expect(methods.indexOf("config.set")).toBeLessThan(methods.lastIndexOf("prompt.submit"));
    });

    it("keeps a steer fallback on its Send-time model and leaves a later choice pending", async () => {
      mocks.listVeniceModels.mockResolvedValue({
        mode: "generation",
        modelType: "text",
        selectedModel: "zai-org-glm-5-2",
        models: toolCapableCatalog,
      });
      const user = userEvent.setup();
      render(<AgentWorkspace initialSession={existingSession} />);

      const composer = await screen.findByRole("textbox", { name: "Message June" });
      await user.type(composer, "Start the active agent run");
      await user.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text: "Start the active agent run",
        }),
      );
      mocks.gatewayRequest.mockClear();

      await user.click(screen.getByRole("button", { name: "Model: GLM 5.2" }));
      let dialog = await screen.findByRole("dialog", { name: "Choose text model" });
      await user.click(within(dialog).getByRole("button", { name: "All models" }));
      let panel = await screen.findByRole("group", { name: "All text models" });
      await user.click(within(panel).getByRole("option", { name: /Kimi K2\.6/ }));

      await user.type(composer, "Use Kimi if this becomes a follow-up");
      await user.click(screen.getByRole("button", { name: "Send to steer June" }));
      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.steer", {
          session_id: "session-1",
          text: "Use Kimi if this becomes a follow-up",
        }),
      );

      await user.click(screen.getByRole("button", { name: "Model: Kimi K2.6" }));
      dialog = await screen.findByRole("dialog", { name: "Choose text model" });
      await user.click(within(dialog).getByRole("button", { name: "All models" }));
      panel = await screen.findByRole("group", { name: "All text models" });
      await user.click(within(panel).getByRole("option", { name: /GLM 5\.2/ }));

      act(() => {
        for (const handler of mocks.gatewayEventHandlers) {
          handler({
            type: "lifecycle.complete",
            session_id: "runtime-session-1",
            event_id: "steer-model-active-run-complete",
            payload: { status: "success" },
          });
        }
      });
      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("config.set", {
          session_id: "runtime-session-1",
          key: "model",
          value: "__june_remote_generation__:kimi-k2-6 --session",
          confirm_expensive_model: true,
        }),
      );
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "Use Kimi if this becomes a follow-up",
      });

      act(() => {
        for (const handler of mocks.gatewayEventHandlers) {
          handler({
            type: "lifecycle.complete",
            session_id: "runtime-session-1",
            event_id: "steer-model-fallback-complete",
            payload: { status: "success" },
          });
        }
      });
      await user.type(composer, "Now use the later GLM choice");
      await user.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() => {
        const modelValues = mocks.gatewayRequest.mock.calls
          .filter(([method]) => method === "config.set")
          .map(([, params]) => params?.value);
        expect(modelValues).toEqual([
          "__june_remote_generation__:kimi-k2-6 --session",
          "__june_remote_generation__:zai-org-glm-5-2 --session",
        ]);
      });
    });

    it("keeps multiple steer fallbacks on their individual Send-time models", async () => {
      mocks.listVeniceModels.mockResolvedValue({
        mode: "generation",
        modelType: "text",
        selectedModel: "zai-org-glm-5-2",
        models: toolCapableCatalog,
      });
      const user = userEvent.setup();
      render(<AgentWorkspace initialSession={existingSession} />);

      const composer = await screen.findByRole("textbox", { name: "Message June" });
      await user.type(composer, "Start the active agent run");
      await user.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text: "Start the active agent run",
        }),
      );
      mocks.gatewayRequest.mockClear();

      await user.click(screen.getByRole("button", { name: "Model: GLM 5.2" }));
      let dialog = await screen.findByRole("dialog", { name: "Choose text model" });
      await user.click(within(dialog).getByRole("button", { name: "All models" }));
      let panel = await screen.findByRole("group", { name: "All text models" });
      await user.click(within(panel).getByRole("option", { name: /Kimi K2\.6/ }));
      await user.type(composer, "First fallback uses Kimi");
      await user.click(screen.getByRole("button", { name: "Send to steer June" }));

      await user.click(screen.getByRole("button", { name: "Model: Kimi K2.6" }));
      dialog = await screen.findByRole("dialog", { name: "Choose text model" });
      await user.click(within(dialog).getByRole("button", { name: "All models" }));
      panel = await screen.findByRole("group", { name: "All text models" });
      await user.click(within(panel).getByRole("option", { name: /GLM 5\.2/ }));
      await user.type(composer, "Second fallback uses GLM");
      await user.click(screen.getByRole("button", { name: "Send to steer June" }));
      await waitFor(() =>
        expect(
          mocks.gatewayRequest.mock.calls.filter(([method]) => method === "session.steer"),
        ).toHaveLength(2),
      );

      act(() => {
        for (const handler of mocks.gatewayEventHandlers) {
          handler({
            type: "lifecycle.complete",
            session_id: "runtime-session-1",
            event_id: "multi-model-active-run-complete",
            payload: { status: "success" },
          });
        }
      });
      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text: "First fallback uses Kimi",
        }),
      );
      expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "Second fallback uses GLM",
      });

      act(() => {
        for (const handler of mocks.gatewayEventHandlers) {
          handler({
            type: "lifecycle.complete",
            session_id: "runtime-session-1",
            event_id: "multi-model-first-fallback-complete",
            payload: { status: "success" },
          });
        }
      });
      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text: "Second fallback uses GLM",
        }),
      );
      const modelValues = mocks.gatewayRequest.mock.calls
        .filter(([method]) => method === "config.set")
        .map(([, params]) => params?.value);
      expect(modelValues).toEqual([
        "__june_remote_generation__:kimi-k2-6 --session",
        "__june_remote_generation__:zai-org-glm-5-2 --session",
      ]);
    });

    it("keeps a failed switch pending and never submits on the previous model", async () => {
      mocks.listVeniceModels.mockResolvedValue({
        mode: "generation",
        modelType: "text",
        selectedModel: "zai-org-glm-5-2",
        models: toolCapableCatalog,
      });
      const user = userEvent.setup();
      render(<AgentWorkspace initialSession={existingSession} />);

      await user.click(await screen.findByRole("button", { name: "Model: GLM 5.2" }));
      const dialog = await screen.findByRole("dialog", { name: "Choose text model" });
      await user.click(within(dialog).getByRole("button", { name: "All models" }));
      const panel = await screen.findByRole("group", { name: "All text models" });
      await user.click(within(panel).getByRole("option", { name: /Kimi K2\.6/ }));

      let rejectSwitch = true;
      mocks.gatewayRequest.mockImplementation((method: string) => {
        if (method === "session.resume") {
          return Promise.resolve({ session_id: "runtime-session-1" });
        }
        if (method === "config.set" && rejectSwitch) {
          return Promise.reject(new Error("Model switch unavailable"));
        }
        return Promise.resolve({});
      });
      const composer = screen.getByRole("textbox", { name: "Message June" });
      await user.type(composer, "Use the queued model");
      await user.click(screen.getByRole("button", { name: "Send message" }));

      expect(
        await screen.findByText("Model switch unavailable", { selector: "p" }),
      ).toBeInTheDocument();
      expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", expect.anything());
      expect(composer).toHaveTextContent("Use the queued model");

      rejectSwitch = false;
      await user.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text: "Use the queued model",
        }),
      );
      expect(
        mocks.gatewayRequest.mock.calls.filter(([method]) => method === "config.set"),
      ).toHaveLength(2);
    });

    it("keeps a newer draft while a delayed model switch failure remains retryable", async () => {
      mocks.listVeniceModels.mockResolvedValue({
        mode: "generation",
        modelType: "text",
        selectedModel: "zai-org-glm-5-2",
        models: toolCapableCatalog,
      });
      const user = userEvent.setup();
      render(<AgentWorkspace initialSession={existingSession} />);

      await user.click(await screen.findByRole("button", { name: "Model: GLM 5.2" }));
      const dialog = await screen.findByRole("dialog", { name: "Choose text model" });
      await user.click(within(dialog).getByRole("button", { name: "All models" }));
      const panel = await screen.findByRole("group", { name: "All text models" });
      await user.click(within(panel).getByRole("option", { name: /Kimi K2\.6/ }));

      let configAttempts = 0;
      let rejectDelayedSwitch: (reason?: unknown) => void = () => {};
      const delayedSwitch = new Promise<never>((_resolve, reject) => {
        rejectDelayedSwitch = reject;
      });
      mocks.gatewayRequest.mockImplementation((method: string) => {
        if (method === "session.resume") {
          return Promise.resolve({ session_id: "runtime-session-1" });
        }
        if (method === "config.set") {
          configAttempts += 1;
          if (configAttempts === 1) {
            return Promise.reject(new HermesGatewayError("session busy", 4009));
          }
          if (configAttempts === 2) return delayedSwitch;
        }
        return Promise.resolve({});
      });

      const composer = screen.getByRole("textbox", { name: "Message June" });
      await user.type(composer, "Send with Kimi");
      await user.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() => expect(configAttempts).toBe(2));

      await user.type(composer, "Keep this newer draft");
      await act(async () => {
        rejectDelayedSwitch(new Error("Model switch unavailable"));
      });

      expect(
        await screen.findByText("Model switch unavailable", { selector: "p" }),
      ).toBeInTheDocument();
      expect(composer).toHaveTextContent("Keep this newer draft");
      expect(screen.getByText("Send with Kimi")).toBeInTheDocument();
      expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", expect.anything());

      await user.click(screen.getByRole("button", { name: "Retry queued message" }));
      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-1",
          text: "Send with Kimi",
        }),
      );
      expect(composer).toHaveTextContent("Keep this newer draft");
    });

    it("keeps a failed new-session message retryable without replacing a newer draft", async () => {
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
      let rejectFirstCreate: (reason?: unknown) => void = () => undefined;
      const firstCreate = new Promise<never>((_resolve, reject) => {
        rejectFirstCreate = reject;
      });
      let createAttempts = 0;
      mocks.gatewayRequest.mockImplementation((method: string) => {
        if (method === "session.create") {
          createAttempts += 1;
          if (createAttempts === 1) return firstCreate;
          return Promise.resolve({
            session_id: "runtime-session-2",
            stored_session_id: "session-2",
          });
        }
        if (method === "session.resume") {
          return Promise.resolve({ session_id: "runtime-session-2" });
        }
        return Promise.resolve({});
      });
      const user = userEvent.setup();
      render(<AgentWorkspace />);

      let composer = await screen.findByRole("textbox", { name: "Message June" });
      await user.type(composer, "Original new-session message");
      await user.click(screen.getByRole("button", { name: "Start session" }));
      await waitFor(() => expect(createAttempts).toBe(1));

      composer = screen.getByRole("textbox", { name: "Message June" });
      await user.type(composer, "Newer draft stays here");
      await act(async () => {
        rejectFirstCreate(new Error("Session creation unavailable"));
      });

      expect(await screen.findByText("Original new-session message")).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "Up next" })).toBeInTheDocument();
      composer = screen.getByRole("textbox", { name: "Message June" });
      expect(composer).toHaveTextContent("Newer draft stays here");
      expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", expect.anything());

      await user.click(screen.getByRole("button", { name: "Retry queued message" }));
      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-2",
          text: "Original new-session message",
        }),
      );
      expect(composer).toHaveTextContent("Newer draft stays here");
    });

    it("captures an Auto preference in the session model without changing the global setting", async () => {
      const user = userEvent.setup();
      render(<AgentWorkspace initialSession={existingSession} />);

      await user.click(await screen.findByRole("button", { name: "Model: GLM 5.2" }));
      const dialog = await screen.findByRole("dialog", { name: "Choose text model" });
      await user.click(
        within(dialog).getByRole("switch", { name: "Choose the model automatically" }),
      );
      expect(dialog).toBeInTheDocument();
      await user.click(within(dialog).getByRole("button", { name: /Preference/ }));
      await user.click(await screen.findByRole("menuitemradio", { name: /Lower cost/ }));

      expect(mocks.setCostQuality).not.toHaveBeenCalled();
      expect(mocks.setVeniceModel).not.toHaveBeenCalled();
      const composer = screen.getByRole("textbox", { name: "Message June" });
      await user.type(composer, "Use lower-cost Auto next");
      await user.click(screen.getByRole("button", { name: "Send message" }));

      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("config.set", {
          session_id: "runtime-session-1",
          key: "model",
          value: "__june_auto_generation__:20 --session",
          confirm_expensive_model: true,
        }),
      );
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "Use lower-cost Auto next",
      });
    });

    it("can turn Auto off for a session before an empty model catalog loads", async () => {
      mocks.listVeniceModels.mockResolvedValue({
        mode: "generation",
        modelType: "text",
        selectedModel: "open-software/auto",
        models: [],
      });
      const user = userEvent.setup();
      render(
        <AgentWorkspace
          initialSession={{ ...existingSession, model: "__june_auto_generation__:100" }}
        />,
      );

      await user.click(await screen.findByRole("button", { name: "Model: Auto (Higher)" }));
      const dialog = await screen.findByRole("dialog", { name: "Choose text model" });
      const autoSwitch = within(dialog).getByRole("switch", {
        name: "Choose the model automatically",
      });
      expect(autoSwitch).toBeChecked();
      await user.click(autoSwitch);

      expect(dialog).toBeInTheDocument();
      expect(mocks.setCostQuality).not.toHaveBeenCalled();
      expect(mocks.setVeniceModel).not.toHaveBeenCalled();
      const composer = screen.getByRole("textbox", { name: "Message June" });
      await user.type(composer, "Use the factory fallback next");
      await user.click(screen.getByRole("button", { name: "Send message" }));

      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("config.set", {
          session_id: "runtime-session-1",
          key: "model",
          value: "__june_remote_generation__:zai-org-glm-5-2 --session",
          confirm_expensive_model: true,
        }),
      );
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
      await user.click(within(dialog).getByRole("button", { name: "All models" }));
      const panel = await screen.findByRole("group", { name: "All text models" });
      await user.click(within(panel).getByRole("option", { name: /Kimi K2\.6/ }));

      await waitFor(() =>
        expect(mocks.setVeniceModel).toHaveBeenCalledWith("generation", "kimi-k2-6"),
      );
      expect(
        await screen.findByText("Default model updated. It applies to new sessions."),
      ).toBeInTheDocument();
      // No live session, so nothing is dispatched to the gateway.
      expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("command.dispatch", expect.anything());
    });

    it("uses a new-session picker choice even while its settings save is still pending", async () => {
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
      let finishModelSave: (() => void) | undefined;
      const pendingModelSave = new Promise<void>((resolve) => {
        finishModelSave = resolve;
      });
      mocks.setVeniceModel.mockReturnValue(pendingModelSave);
      const user = userEvent.setup();
      render(<AgentWorkspace />);

      await user.click(await screen.findByRole("button", { name: "Model: GLM 5.2" }));
      const dialog = await screen.findByRole("dialog", { name: "Choose text model" });
      await user.click(within(dialog).getByRole("button", { name: "All models" }));
      const panel = await screen.findByRole("group", { name: "All text models" });
      await user.click(within(panel).getByRole("option", { name: /Kimi K2\.6/ }));
      expect(await screen.findByRole("button", { name: "Model: Kimi K2.6" })).toBeInTheDocument();
      expect(finishModelSave).toBeDefined();

      const composer = screen.getByRole("textbox", { name: "Message June" });
      await user.type(composer, "Start before settings finish");
      await user.click(screen.getByRole("button", { name: "Start session" }));

      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith(
          "session.create",
          expect.objectContaining({ model: "__june_remote_generation__:kimi-k2-6" }),
        ),
      );
      await act(async () => finishModelSave?.());
    });

    it("uses a newly chosen Auto preference before its settings save finishes", async () => {
      window.sessionStorage.setItem(
        AGENT_NEW_SESSION_PENDING_KEY,
        JSON.stringify({ createdAt: Date.now() }),
      );
      mocks.providerModelSettings.mockResolvedValue({
        settings: {
          transcriptionProvider: "venice",
          transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
          generationModel: "open-software/auto",
          costQuality: 100,
        },
      });
      mocks.listVeniceModels.mockResolvedValue({
        mode: "generation",
        modelType: "text",
        selectedModel: "open-software/auto",
        models: [
          {
            provider: "open-software",
            id: "open-software/auto",
            name: "Automatic private model",
            modelType: "text",
            privacy: "private",
            traits: [],
            capabilities: ["functionCalling"],
          },
        ],
      });
      let finishCostQualitySave: (() => void) | undefined;
      mocks.setCostQuality.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishCostQualitySave = () =>
              resolve({
                transcriptionProvider: "venice",
                transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
                generationModel: "open-software/auto",
                costQuality: 20,
              });
          }),
      );
      const user = userEvent.setup();
      render(<AgentWorkspace />);

      const composer = await screen.findByRole("textbox", { name: "Message June" });
      await user.click(await screen.findByRole("button", { name: "Model: Auto (Higher)" }));
      const dialog = await screen.findByRole("dialog", { name: "Choose text model" });
      await user.click(within(dialog).getByRole("button", { name: /Preference/ }));
      await user.click(await screen.findByRole("menuitemradio", { name: /Lower cost/ }));
      expect(mocks.setCostQuality).toHaveBeenCalledWith(20);
      expect(finishCostQualitySave).toBeDefined();
      await user.type(composer, "Start with this Auto preference");
      await user.click(screen.getByRole("button", { name: "Start session" }));

      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith(
          "session.create",
          expect.objectContaining({ model: "__june_auto_generation__:20" }),
        ),
      );
      await act(async () => finishCostQualitySave?.());
    });

    it.each([
      { command: "/image a red bicycle", resultRole: "img" as const, resultName: "a red bicycle" },
      {
        command: "/video a red bicycle",
        resultRole: "button" as const,
        resultName: "Download video",
      },
    ])("keeps a model picked after $command creates its session pending for the next text prompt", async ({
      command,
      resultRole,
      resultName,
    }) => {
      window.sessionStorage.setItem(
        AGENT_NEW_SESSION_PENDING_KEY,
        JSON.stringify({ createdAt: Date.now() }),
      );
      let selectedModel = "zai-org-glm-5-2";
      mocks.providerModelSettings.mockImplementation(async () => ({
        settings: {
          transcriptionProvider: "venice",
          transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
          generationProvider: "venice",
          generationModel: selectedModel,
          remoteGenerationModel: selectedModel,
          imageModel: "venice-sd35",
          videoModel: "wan-2.2-a14b-text-to-video",
          imageSafeMode: false,
          imageSafeModePromptDismissed: false,
        },
      }));
      mocks.listVeniceModels.mockImplementation(async () => ({
        mode: "generation",
        modelType: "text",
        selectedModel,
        models: toolCapableCatalog.map((model) => ({
          ...model,
          capabilities: [...model.capabilities, "supportsVision"],
        })),
      }));
      mocks.setVeniceModel.mockImplementation(async (_mode: string, modelId: string) => {
        selectedModel = modelId;
      });
      if (resultRole === "img") {
        mockImageGenerationSuccess();
      } else {
        mockVideoGenerationSuccess();
      }

      let releaseEnsure: (() => void) | undefined;
      const ensured = new Promise<Record<string, never>>((resolve) => {
        releaseEnsure = () => resolve({});
      });
      mocks.ensureHermesBridgeSession.mockImplementation(async ({ sessionId }) => {
        if (sessionId === "session-2") return ensured;
        return {};
      });

      const user = userEvent.setup();
      render(<AgentWorkspace />);

      const composer = await screen.findByRole("textbox", { name: "Message June" });
      await screen.findByRole("button", { name: "Model: GLM 5.2" });
      await user.type(composer, command);
      fireEvent.submit(document.querySelector(".agent-composer") as HTMLFormElement);

      // The media agent run owns the model that was selected at Send, even though
      // session persistence is deliberately held open below.
      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith(
          "session.create",
          expect.objectContaining({
            model: "__june_remote_generation__:zai-org-glm-5-2",
          }),
        ),
      );
      await waitFor(() => expect(releaseEnsure).toBeDefined());

      // This happens after session.create, but before skipPrompt selects and
      // returns the stored session. It must become that session's pending
      // next-run model rather than rewriting the media agent run.
      await user.click(screen.getByRole("button", { name: "Model: GLM 5.2" }));
      const dialog = await screen.findByRole("dialog", { name: "Choose text model" });
      await user.click(within(dialog).getByRole("button", { name: "All models" }));
      const panel = await screen.findByRole("group", { name: "All text models" });
      await user.click(within(panel).getByRole("option", { name: /Kimi K2\.6/ }));
      expect(await screen.findByRole("button", { name: "Model: Kimi K2.6" })).toBeInTheDocument();

      await act(async () => {
        releaseEnsure?.();
        await ensured;
      });
      await screen.findByRole(resultRole, { name: resultName });

      await user.type(screen.getByRole("textbox", { name: "Message June" }), "Use Kimi now");
      await user.click(screen.getByRole("button", { name: "Send message" }));

      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("config.set", {
          session_id: "runtime-session-2",
          key: "model",
          value: "__june_remote_generation__:kimi-k2-6 --session",
          confirm_expensive_model: true,
        }),
      );
      expect(mocks.gatewayRequest).toHaveBeenCalledWith(
        "prompt.submit",
        expect.objectContaining({
          session_id: "runtime-session-2",
          text: expect.stringContaining("Use Kimi now"),
        }),
      );
    });

    it("keeps tool-incapable models out of June's picker", async () => {
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

      window.sessionStorage.setItem(
        AGENT_NEW_SESSION_PENDING_KEY,
        JSON.stringify({ createdAt: Date.now() }),
      );
      render(<AgentWorkspace />);

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

  describe("local generation in the composer", () => {
    const remoteCatalog = [
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
    const localGeneration = {
      baseUrl: "http://localhost:11434/v1",
      modelId: "llama3.1:8b",
      apiKey: "",
    };

    function mockLocalActive(local = localGeneration) {
      mocks.providerModelSettings.mockResolvedValue({
        settings: {
          transcriptionProvider: "venice",
          transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
          generationProvider: "local",
          generationModel: local.modelId,
          remoteGenerationModel: "zai-org-glm-5-2",
          localGeneration: local,
        },
      });
      mocks.listVeniceModels.mockResolvedValue({
        mode: "generation",
        modelType: "text",
        selectedModel: "zai-org-glm-5-2",
        models: remoteCatalog,
      });
    }

    function mockRemoteWithLocalConfigured(local = localGeneration) {
      mocks.providerModelSettings.mockResolvedValue({
        settings: {
          transcriptionProvider: "venice",
          transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
          generationProvider: "venice",
          generationModel: "zai-org-glm-5-2",
          remoteGenerationModel: "zai-org-glm-5-2",
          localGeneration: local,
        },
      });
      mocks.listVeniceModels.mockResolvedValue({
        mode: "generation",
        modelType: "text",
        selectedModel: "zai-org-glm-5-2",
        models: remoteCatalog,
      });
    }

    function markNewSessionPending() {
      window.sessionStorage.setItem(
        AGENT_NEW_SESSION_PENDING_KEY,
        JSON.stringify({ createdAt: Date.now() }),
      );
    }

    async function openAllModels(user: ReturnType<typeof userEvent.setup>) {
      const dialog = await screen.findByRole("dialog", {
        name: "Choose text model",
      });
      await user.click(within(dialog).getByRole("button", { name: "All models" }));
      return screen.findByRole("group", { name: "All text models" });
    }

    it("shows the local option as the current model when local mode is on", async () => {
      mockLocalActive();
      markNewSessionPending();
      const user = userEvent.setup();
      render(<AgentWorkspace />);

      // The pill resolves to "Local: <id>", never the raw local id.
      await user.click(
        await screen.findByRole("button", {
          name: "Model: Local: llama3.1:8b",
        }),
      );
      const panel = await openAllModels(user);
      expect(
        within(panel).getByRole("option", { name: /Local: llama3\.1:8b/ }),
      ).toBeInTheDocument();
    });

    it("flips the global provider off local when a remote model is picked with no open session", async () => {
      mockLocalActive();
      mocks.setVeniceModel.mockResolvedValue(undefined);
      markNewSessionPending();
      const user = userEvent.setup();
      render(<AgentWorkspace />);

      await user.click(
        await screen.findByRole("button", {
          name: "Model: Local: llama3.1:8b",
        }),
      );
      const panel = await openAllModels(user);
      await user.click(within(panel).getByRole("option", { name: /Kimi K2\.6/ }));

      await waitFor(() =>
        expect(mocks.setVeniceModel).toHaveBeenCalledWith("generation", "kimi-k2-6"),
      );
      expect(mocks.setLocalGenerationEnabled).not.toHaveBeenCalled();
      expect(
        await screen.findByText("Default model updated. It applies to new sessions."),
      ).toBeInTheDocument();
    });

    it("enables local generation when the local option is picked with no open session", async () => {
      mockRemoteWithLocalConfigured();
      mocks.setLocalGenerationEnabled.mockResolvedValue(undefined);
      markNewSessionPending();
      const user = userEvent.setup();
      render(<AgentWorkspace />);

      await user.click(await screen.findByRole("button", { name: "Model: GLM 5.2" }));
      const panel = await openAllModels(user);
      await user.click(within(panel).getByRole("option", { name: /Local: llama3\.1:8b/ }));

      await waitFor(() => expect(mocks.setLocalGenerationEnabled).toHaveBeenCalledWith(true));
      expect(mocks.setVeniceModel).not.toHaveBeenCalled();
      expect(
        await screen.findByText("Default model updated. It applies to new sessions."),
      ).toBeInTheDocument();
    });

    it("queues local generation session-locally without changing the global provider", async () => {
      mockRemoteWithLocalConfigured();
      mocks.setLocalGenerationEnabled.mockResolvedValue(undefined);
      const user = userEvent.setup();
      render(<AgentWorkspace initialSession={existingSession} />);

      await user.click(await screen.findByRole("button", { name: "Model: GLM 5.2" }));
      const panel = await openAllModels(user);
      await user.click(within(panel).getByRole("option", { name: /Local: llama3\.1:8b/ }));

      expect(
        await screen.findByRole("button", { name: "Model: Local: llama3.1:8b" }),
      ).toBeInTheDocument();
      expect(mocks.setLocalGenerationEnabled).not.toHaveBeenCalled();
      expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("config.set", expect.anything());

      const composer = screen.getByRole("textbox", { name: "Message June" });
      await user.type(composer, "Use the local model next");
      await user.click(screen.getByRole("button", { name: "Send message" }));

      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("config.set", {
          session_id: "runtime-session-1",
          key: "model",
          value: "__june_local_generation__:llama3.1%3A8b --session",
          confirm_expensive_model: true,
        }),
      );
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "Use the local model next",
      });
      const methods = mocks.gatewayRequest.mock.calls.map(([method]) => method);
      expect(methods.indexOf("config.set")).toBeLessThan(methods.indexOf("prompt.submit"));
      expect(mocks.setLocalGenerationEnabled).not.toHaveBeenCalled();
    });

    it("keeps an explicit remote model remote when its raw id matches the local model", async () => {
      mockRemoteWithLocalConfigured();
      const collidingRemoteModel = {
        provider: "venice",
        id: localGeneration.modelId,
        name: "Remote Llama",
        modelType: "text",
        privacy: "private",
        traits: [],
        capabilities: ["functionCalling"],
      };
      mocks.listVeniceModels.mockResolvedValue({
        mode: "generation",
        modelType: "text",
        selectedModel: "zai-org-glm-5-2",
        models: [...remoteCatalog, collidingRemoteModel],
      });
      const user = userEvent.setup();
      render(<AgentWorkspace initialSession={existingSession} />);

      await user.click(await screen.findByRole("button", { name: "Model: GLM 5.2" }));
      const panel = await openAllModels(user);
      await user.click(within(panel).getByRole("option", { name: /Remote Llama/ }));

      expect(
        await screen.findByRole("button", { name: "Model: Remote Llama" }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Model: Local: llama3.1:8b" })).toBeNull();

      const composer = screen.getByRole("textbox", { name: "Message June" });
      await user.type(composer, "Keep this route remote");
      await user.click(screen.getByRole("button", { name: "Send message" }));

      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("config.set", {
          session_id: "runtime-session-1",
          key: "model",
          value: "__june_remote_generation__:llama3.1%3A8b --session",
          confirm_expensive_model: true,
        }),
      );
      expect(mocks.setLocalGenerationEnabled).not.toHaveBeenCalled();
      expect(mocks.setVeniceModel).not.toHaveBeenCalled();
    });

    it("keeps an open local session model switchable", async () => {
      mockLocalActive();
      mocks.setVeniceModel.mockResolvedValue(undefined);
      const user = userEvent.setup();
      render(<AgentWorkspace initialSession={existingSession} />);

      await user.click(await screen.findByRole("button", { name: "Model: Local: llama3.1:8b" }));
      expect(await screen.findByRole("dialog", { name: "Choose text model" })).toBeInTheDocument();
      expect(mocks.setVeniceModel).not.toHaveBeenCalled();
      expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("config.set", expect.anything());
    });

    it("preserves local provenance when creating a session in local mode", async () => {
      mockLocalActive();
      markNewSessionPending();
      const user = userEvent.setup();
      render(<AgentWorkspace />);

      // Settings are loaded once the pill resolves to the local option.
      await screen.findByRole("button", {
        name: "Model: Local: llama3.1:8b",
      });
      const composer = await screen.findByRole("textbox", {
        name: "Message June",
      });
      await user.type(composer, "hello local");
      await user.click(screen.getByRole("button", { name: "Start session" }));

      // The tagged id prevents a same-named remote model from stealing this
      // route. June's on-device proxy unwraps it before calling the endpoint.
      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith(
          "session.create",
          expect.objectContaining({
            model: "__june_local_generation__:llama3.1%3A8b",
          }),
        ),
      );
      await waitFor(() =>
        expect(mocks.ensureHermesBridgeSession).toHaveBeenCalledWith(
          expect.objectContaining({
            model: "__june_local_generation__:llama3.1%3A8b",
          }),
        ),
      );
    });

    it("requires a second selection to enable an off-device local endpoint from the composer", async () => {
      const offDeviceLocal = {
        baseUrl: "http://192.168.1.5:11434/v1",
        modelId: "llama3.1:8b",
        apiKey: "",
      };
      mockRemoteWithLocalConfigured(offDeviceLocal);
      mocks.setLocalGenerationEnabled.mockResolvedValue(undefined);
      markNewSessionPending();
      const user = userEvent.setup();
      render(<AgentWorkspace />);

      // First selection warns instead of enabling.
      await user.click(await screen.findByRole("button", { name: "Model: GLM 5.2" }));
      let panel = await openAllModels(user);
      await user.click(within(panel).getByRole("option", { name: /Local: llama3\.1:8b/ }));
      expect(
        await screen.findByText(
          "This endpoint is not on this machine. Requests will leave your device. Select the local model again to confirm.",
        ),
      ).toBeInTheDocument();
      expect(mocks.setLocalGenerationEnabled).not.toHaveBeenCalled();

      // Second selection confirms and enables.
      await user.click(await screen.findByRole("button", { name: "Model: GLM 5.2" }));
      panel = await openAllModels(user);
      await user.click(within(panel).getByRole("option", { name: /Local: llama3\.1:8b/ }));
      await waitFor(() => expect(mocks.setLocalGenerationEnabled).toHaveBeenCalledWith(true));
    });

    it("re-arms the off-device confirm after picking another model in between", async () => {
      const offDeviceLocal = {
        baseUrl: "http://192.168.1.5:11434/v1",
        modelId: "llama3.1:8b",
        apiKey: "",
      };
      mockRemoteWithLocalConfigured(offDeviceLocal);
      mocks.setVeniceModel.mockResolvedValue(undefined);
      markNewSessionPending();
      const user = userEvent.setup();
      render(<AgentWorkspace />);

      // Arm the confirm, then pick a remote model instead.
      await user.click(await screen.findByRole("button", { name: "Model: GLM 5.2" }));
      let panel = await openAllModels(user);
      await user.click(within(panel).getByRole("option", { name: /Local: llama3\.1:8b/ }));
      expect(mocks.setLocalGenerationEnabled).not.toHaveBeenCalled();
      await user.click(await screen.findByRole("button", { name: "Model: GLM 5.2" }));
      panel = await openAllModels(user);
      await user.click(within(panel).getByRole("option", { name: /Kimi K2\.6/ }));
      await waitFor(() =>
        expect(mocks.setVeniceModel).toHaveBeenCalledWith("generation", "kimi-k2-6"),
      );

      // The stood-down confirm means the next local selection warns again.
      // (The changed-settings reload resets the pill to the mocked backend
      // state, GLM 5.2; findByRole waits for that refresh to land.)
      await user.click(await screen.findByRole("button", { name: "Model: GLM 5.2" }));
      panel = await openAllModels(user);
      await user.click(within(panel).getByRole("option", { name: /Local: llama3\.1:8b/ }));
      expect(
        await screen.findByText(
          "This endpoint is not on this machine. Requests will leave your device. Select the local model again to confirm.",
        ),
      ).toBeInTheDocument();
      expect(mocks.setLocalGenerationEnabled).not.toHaveBeenCalled();
    });
  });
});
