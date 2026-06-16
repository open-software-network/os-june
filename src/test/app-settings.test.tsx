import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppSettings } from "../components/settings/AppSettings";
import type { DictationSettingsDto } from "../lib/tauri";
import { APP_COMMIT_HASH, APP_VERSION } from "../app/build-info";
import { AGENT_HUD_ENABLED_KEY } from "../lib/agent-hud-settings";
import { PROVIDER_MODEL_SETTINGS_CHANGED_EVENT } from "../lib/model-privacy";

const mocks = vi.hoisted(() => ({
  dictationSettings: vi.fn(),
  dictationHelperCommand: vi.fn(),
  localAudioFileSrc: vi.fn(),
  providerModelSettings: vi.fn(),
  listVeniceModels: vi.fn(),
  setVeniceModel: vi.fn(),
  openPrivacySettings: vi.fn(),
  setDictationShortcut: vi.fn(),
  setDictationMicrophone: vi.fn(),
  setDictationLanguage: vi.fn(),
  osAccountsLogin: vi.fn(),
  osAccountsCancelLogin: vi.fn(),
  osAccountsLogout: vi.fn(),
  osAccountsTopUp: vi.fn(),
  hermesBridgeSkills: vi.fn(),
  hermesBridgeToolsets: vi.fn(),
  hermesBridgeMessagingPlatforms: vi.fn(),
  hermesBridgeFilesystemSnapshot: vi.fn(),
  toggleHermesBridgeSkill: vi.fn(),
  toggleHermesBridgeToolset: vi.fn(),
  updateHermesBridgeMessagingPlatform: vi.fn(),
  agentHudShow: vi.fn(),
  agentHudHide: vi.fn(),
  hermesAgentCliAccess: vi.fn(),
  setHermesAgentCliAccess: vi.fn(),
  listDictionaryEntries: vi.fn(),
  createDictionaryEntry: vi.fn(),
  updateDictionaryEntry: vi.fn(),
  deleteDictionaryEntry: vi.fn(),
  scribeOpenVerifyPage: vi.fn(),
  listen: vi.fn(),
  eventHandler: undefined as ((event: { payload: string }) => void) | undefined,
}));

vi.mock("../lib/tauri", () => ({
  dictationSettings: mocks.dictationSettings,
  dictationHelperCommand: mocks.dictationHelperCommand,
  localAudioFileSrc: mocks.localAudioFileSrc,
  providerModelSettings: mocks.providerModelSettings,
  listVeniceModels: mocks.listVeniceModels,
  setVeniceModel: mocks.setVeniceModel,
  openPrivacySettings: mocks.openPrivacySettings,
  setDictationShortcut: mocks.setDictationShortcut,
  setDictationMicrophone: mocks.setDictationMicrophone,
  setDictationLanguage: mocks.setDictationLanguage,
  osAccountsLogin: mocks.osAccountsLogin,
  osAccountsCancelLogin: mocks.osAccountsCancelLogin,
  osAccountsLogout: mocks.osAccountsLogout,
  osAccountsTopUp: mocks.osAccountsTopUp,
  hermesBridgeSkills: mocks.hermesBridgeSkills,
  hermesBridgeToolsets: mocks.hermesBridgeToolsets,
  hermesBridgeMessagingPlatforms: mocks.hermesBridgeMessagingPlatforms,
  hermesBridgeFilesystemSnapshot: mocks.hermesBridgeFilesystemSnapshot,
  toggleHermesBridgeSkill: mocks.toggleHermesBridgeSkill,
  toggleHermesBridgeToolset: mocks.toggleHermesBridgeToolset,
  updateHermesBridgeMessagingPlatform:
    mocks.updateHermesBridgeMessagingPlatform,
  agentHudShow: mocks.agentHudShow,
  agentHudHide: mocks.agentHudHide,
  hermesAgentCliAccess: mocks.hermesAgentCliAccess,
  setHermesAgentCliAccess: mocks.setHermesAgentCliAccess,
  listDictionaryEntries: mocks.listDictionaryEntries,
  createDictionaryEntry: mocks.createDictionaryEntry,
  updateDictionaryEntry: mocks.updateDictionaryEntry,
  deleteDictionaryEntry: mocks.deleteDictionaryEntry,
  scribeOpenVerifyPage: mocks.scribeOpenVerifyPage,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

const baseSettings: DictationSettingsDto = {
  pushToTalkShortcut: {
    keyCode: 0x02,
    code: "KeyD",
    label: "Ctrl+Opt+D",
    pressCount: 1,
    modifiers: {
      command: false,
      control: true,
      option: true,
      shift: false,
      function: false,
    },
  },
  toggleShortcut: {
    keyCode: 0x11,
    code: "KeyT",
    label: "Ctrl+Opt+T",
    pressCount: 1,
    modifiers: {
      command: false,
      control: true,
      option: true,
      shift: false,
      function: false,
    },
  },
  microphone: {},
  style: "standard",
  language: undefined,
};

const signedInAccount = {
  signedIn: true,
  configured: true,
  user: {
    id: "usr_123",
    handle: "junho",
    email: "junho@example.com",
    displayName: "Junho",
  },
  balance: { usdMillis: 1200 },
};

function stubNavigatorPlatform(platform: string, userAgent: string) {
  const ownPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");
  const ownUserAgent = Object.getOwnPropertyDescriptor(navigator, "userAgent");
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    get: () => platform,
  });
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    get: () => userAgent,
  });
  return () => {
    if (ownPlatform) {
      Object.defineProperty(navigator, "platform", ownPlatform);
    } else {
      Reflect.deleteProperty(navigator, "platform");
    }
    if (ownUserAgent) {
      Object.defineProperty(navigator, "userAgent", ownUserAgent);
    } else {
      Reflect.deleteProperty(navigator, "userAgent");
    }
  };
}

describe("AppSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.eventHandler = undefined;
    mocks.dictationSettings.mockResolvedValue({ settings: baseSettings });
    mocks.localAudioFileSrc.mockImplementation((path) => `asset://${path}`);
    mocks.setDictationLanguage.mockImplementation(async (language) => ({
      ...baseSettings,
      language,
    }));
    mocks.listDictionaryEntries.mockResolvedValue([]);
    mocks.scribeOpenVerifyPage.mockResolvedValue(undefined);
    mocks.providerModelSettings.mockResolvedValue({
      settings: {
        transcriptionProvider: "venice",
        transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
        generationModel: "zai-org-glm-5-2",
      },
    });
    mocks.listVeniceModels.mockImplementation(async (mode) => ({
      mode,
      modelType: mode === "transcription" ? "asr" : "text",
      selectedModel:
        mode === "transcription"
          ? "nvidia/parakeet-tdt-0.6b-v3"
          : "zai-org-glm-5-2",
      models:
        mode === "transcription"
          ? [
              {
                provider: "venice",
                id: "nvidia/parakeet-tdt-0.6b-v3",
                name: "Parakeet",
                modelType: "asr",
                description: "Speech-to-text model for transcribing audio.",
                privacy: "private",
                priceUnit: "seconds",
                creditsPerMillionSeconds: 100000,
                contextTokens: 8192,
                traits: ["default"],
                capabilities: [],
              },
              {
                provider: "openai",
                id: "gpt-4o-mini-transcribe",
                name: "GPT-4o mini Transcribe",
                modelType: "asr",
                description: "Fast OpenAI speech-to-text model.",
                privacy: "OpenAI",
                pricing: { display: "$0.003/min audio" },
                contextTokens: 16000,
                traits: ["prompt"],
                capabilities: [],
              },
              {
                provider: "openai",
                id: "gpt-4o-transcribe",
                name: "GPT-4o Transcribe",
                modelType: "asr",
                description: "Large transcription model.",
                privacy: "OpenAI",
                pricing: { display: "$0.006/min audio" },
                contextTokens: 16000,
                traits: ["prompt"],
                capabilities: [],
              },
            ]
          : [
              {
                provider: "venice",
                id: "zai-org-glm-5-2",
                name: "GLM 5.2",
                modelType: "text",
                description: "Latest GLM text model for writing notes.",
                privacy: "private",
                priceUnit: "tokens",
                inputCreditsPerMillionTokens: 1750,
                outputCreditsPerMillionTokens: 5500,
                contextTokens: 200000,
                traits: [],
                capabilities: ["supportsFunctionCalling"],
              },
              {
                provider: "venice",
                id: "kimi-k2-6",
                name: "Kimi K2.6",
                modelType: "text",
                description:
                  "Open-weights model built for long tool-driven tasks.",
                privacy: "private",
                priceUnit: "tokens",
                inputCreditsPerMillionTokens: 850,
                outputCreditsPerMillionTokens: 4660,
                contextTokens: 256000,
                traits: [],
                capabilities: ["supportsFunctionCalling"],
              },
              {
                provider: "venice",
                id: "zai-org-glm-5-1",
                name: "GLM 5.1",
                modelType: "text",
                description: "Text model for writing notes.",
                privacy: "private",
                priceUnit: "tokens",
                inputCreditsPerMillionTokens: 1000,
                outputCreditsPerMillionTokens: 3200,
                contextTokens: 32768,
                traits: [],
                capabilities: ["supportsFunctionCalling"],
              },
              {
                provider: "venice",
                id: "venice-uncensored",
                name: "Venice Uncensored",
                modelType: "text",
                description: "Uncensored text model.",
                privacy: "private",
                pricing: { input: { usd: 0.2 }, output: { usd: 0.8 } },
                contextTokens: 65536,
                traits: ["anonymized", "uncensored"],
                capabilities: ["supportsFunctionCalling"],
              },
              {
                provider: "venice",
                id: "e2ee-private",
                name: "E2EE Private",
                modelType: "text",
                description: "End-to-end encrypted text model.",
                privacy: "e2ee",
                pricing: { input: { usd: 0.3 }, output: { usd: 1.2 } },
                contextTokens: 32768,
                traits: ["e2ee"],
                capabilities: [],
              },
              {
                provider: "venice",
                id: "anonymous-only",
                name: "Anonymous Only",
                modelType: "text",
                description: "Anonymizes prompts before upstream inference.",
                privacy: "anonymous",
                pricing: { input: { usd: 0.1 }, output: { usd: 0.4 } },
                contextTokens: 32768,
                traits: [],
                capabilities: [],
              },
            ],
    }));
    mocks.setVeniceModel.mockImplementation(async (mode, modelId) => ({
      transcriptionProvider:
        mode === "transcription" && modelId.startsWith("gpt-")
          ? "openai"
          : "venice",
      transcriptionModel:
        mode === "transcription" ? modelId : "nvidia/parakeet-tdt-0.6b-v3",
      generationModel: mode === "generation" ? modelId : "zai-org-glm-5-2",
    }));
    mocks.dictationHelperCommand.mockResolvedValue(undefined);
    mocks.openPrivacySettings.mockResolvedValue(undefined);
    mocks.agentHudShow.mockResolvedValue(undefined);
    mocks.agentHudHide.mockResolvedValue(undefined);
    mocks.hermesAgentCliAccess.mockResolvedValue({ enabled: false });
    mocks.setHermesAgentCliAccess.mockImplementation(
      async (enabled: boolean) => ({ enabled }),
    );
    mocks.setDictationShortcut.mockImplementation(async (kind, shortcut) => ({
      ...baseSettings,
      ...(kind === "toggle"
        ? { toggleShortcut: shortcut }
        : { pushToTalkShortcut: shortcut }),
    }));
    mocks.setDictationMicrophone.mockImplementation(async (id, name) => ({
      ...baseSettings,
      microphone: { id, name },
    }));
    mocks.hermesBridgeSkills.mockResolvedValue([]);
    mocks.hermesBridgeToolsets.mockResolvedValue([]);
    mocks.hermesBridgeMessagingPlatforms.mockResolvedValue({ platforms: [] });
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
              path: "/Users/junho/Library/Application Support/co.opensoftware.scribe/hermes/workspace/sample.pdf",
              kind: "file",
              size: 1700,
              modifiedAt: "2026-06-04T18:39:00Z",
            },
          ],
        },
        {
          id: "memory",
          label: "Memory",
          path: "/Users/junho/Library/Application Support/co.opensoftware.scribe/hermes/memory",
          description: "Persistent Hermes memory files and stores.",
          entries: [
            {
              name: "USER.md",
              path: "/Users/junho/Library/Application Support/co.opensoftware.scribe/hermes/memory/USER.md",
              kind: "file",
              size: 39,
              modifiedAt: "2026-06-04T18:47:00Z",
            },
          ],
        },
        {
          id: "logs",
          label: "Logs",
          path: "/tmp/hermes/logs",
          description: "Internal logs.",
          entries: [],
        },
      ],
    });
    mocks.listen.mockImplementation((_event, handler) => {
      mocks.eventHandler = handler;
      return Promise.resolve(vi.fn());
    });
  });

  it("opens OS Accounts from Add funds in billing settings", async () => {
    const user = userEvent.setup();
    render(
      <AppSettings
        account={signedInAccount}
        accountLoading={false}
        sourceMode="microphoneOnly"
        checkingSourceReadiness={false}
        onAccountChanged={vi.fn()}
        onAccountRefresh={vi.fn()}
        onSourceModeChange={vi.fn()}
        onEnableSystemAudio={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Billing" }));
    await user.click(screen.getByRole("button", { name: "Add funds" }));
    expect(mocks.osAccountsTopUp).toHaveBeenCalledTimes(1);
  });

  it("updates dictation microphone and note recording source", async () => {
    const user = userEvent.setup();
    const onSourceModeChange = vi.fn();
    render(
      <AppSettings
        account={signedInAccount}
        accountLoading={false}
        sourceMode="microphoneOnly"
        checkingSourceReadiness={false}
        onAccountChanged={vi.fn()}
        onAccountRefresh={vi.fn()}
        onSourceModeChange={onSourceModeChange}
        onEnableSystemAudio={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(mocks.dictationHelperCommand).toHaveBeenCalledWith({
        type: "list_microphones",
      }),
    );
    mocks.eventHandler?.({
      payload: JSON.stringify({
        type: "microphone_devices",
        payload: {
          devices: [{ id: "usb", name: "USB Mic" }],
          defaultDevice: { id: "built-in", name: "MacBook Pro Microphone" },
        },
      }),
    });

    await user.click(screen.getByRole("tab", { name: "Audio" }));
    expect(
      screen.getByText("Auto-detect uses MacBook Pro Microphone."),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /Auto-detect|USB Mic/ }),
    );
    await user.click(await screen.findByRole("option", { name: "USB Mic" }));

    expect(mocks.setDictationMicrophone).toHaveBeenCalledWith("usb", "USB Mic");
    await waitFor(() =>
      expect(
        screen.getByText("Input device used for dictation."),
      ).toBeInTheDocument(),
    );

    await user.click(
      screen.getByRole("switch", { name: "Capture system audio for notes" }),
    );
    expect(onSourceModeChange).toHaveBeenCalledWith("microphonePlusSystem");
  });

  it("records a local microphone test sample and renders playback", async () => {
    const user = userEvent.setup();
    render(
      <AppSettings
        account={signedInAccount}
        accountLoading={false}
        sourceMode="microphoneOnly"
        checkingSourceReadiness={false}
        onAccountChanged={vi.fn()}
        onAccountRefresh={vi.fn()}
        onSourceModeChange={vi.fn()}
        onEnableSystemAudio={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Audio" }));
    await user.click(screen.getByRole("button", { name: "Start test" }));

    expect(mocks.dictationHelperCommand).toHaveBeenCalledWith({
      type: "start_mic_test",
      durationSeconds: 5,
    });
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();

    mocks.eventHandler?.({
      payload: JSON.stringify({
        type: "mic_test_level",
        payload: { level: "0.72" },
      }),
    });
    await waitFor(() =>
      expect(
        screen.getByRole("progressbar", { name: "Microphone test level" }),
      ).toHaveAttribute("aria-valuenow", "72"),
    );

    mocks.eventHandler?.({
      payload: JSON.stringify({
        type: "mic_test_ready",
        payload: {
          path: "/tmp/os-scribe-mic-test.m4a",
          durationMs: 5000,
          observedAudioLevel: "0.72",
        },
      }),
    });

    expect(
      await screen.findByText("Sample ready. Check volume."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Play microphone test sample" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start over" }),
    ).toBeInTheDocument();

    const play = vi
      .spyOn(window.HTMLMediaElement.prototype, "play")
      .mockImplementation(function (this: HTMLMediaElement) {
        this.dispatchEvent(new Event("play"));
        return Promise.resolve();
      });
    await user.click(
      screen.getByRole("button", { name: "Play microphone test sample" }),
    );

    expect(play).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByRole("slider", {
        name: "Microphone test playback progress",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start over" })).toBeDisabled();

    play.mockRestore();
  });

  it("starts a new microphone test from an existing sample", async () => {
    const user = userEvent.setup();
    render(
      <AppSettings
        account={signedInAccount}
        accountLoading={false}
        sourceMode="microphoneOnly"
        checkingSourceReadiness={false}
        onAccountChanged={vi.fn()}
        onAccountRefresh={vi.fn()}
        onSourceModeChange={vi.fn()}
        onEnableSystemAudio={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Audio" }));
    await user.click(screen.getByRole("button", { name: "Start test" }));
    mocks.eventHandler?.({
      payload: JSON.stringify({
        type: "mic_test_ready",
        payload: {
          path: "/tmp/os-scribe-mic-test.m4a",
          durationMs: 5000,
          observedAudioLevel: "0.72",
        },
      }),
    });

    await user.click(await screen.findByRole("button", { name: "Start over" }));
    expect(mocks.dictationHelperCommand).toHaveBeenCalledWith({
      type: "discard_mic_test",
    });
    expect(mocks.dictationHelperCommand).toHaveBeenCalledWith({
      type: "start_mic_test",
      durationSeconds: 5,
    });
  });

  it("resets microphone test state when microphone selection changes", async () => {
    const user = userEvent.setup();
    render(
      <AppSettings
        account={signedInAccount}
        accountLoading={false}
        sourceMode="microphoneOnly"
        checkingSourceReadiness={false}
        onAccountChanged={vi.fn()}
        onAccountRefresh={vi.fn()}
        onSourceModeChange={vi.fn()}
        onEnableSystemAudio={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Audio" }));
    mocks.eventHandler?.({
      payload: JSON.stringify({
        type: "microphone_devices",
        payload: { devices: [{ id: "usb", name: "USB Mic" }] },
      }),
    });
    await user.click(screen.getByRole("button", { name: "Start test" }));
    mocks.eventHandler?.({
      payload: JSON.stringify({
        type: "mic_test_ready",
        payload: {
          path: "/tmp/os-scribe-mic-test.m4a",
          durationMs: 5000,
          observedAudioLevel: "0.72",
        },
      }),
    });
    expect(
      await screen.findByRole("button", {
        name: "Play microphone test sample",
      }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /Auto-detect|USB Mic/ }),
    );
    await user.click(await screen.findByRole("option", { name: "USB Mic" }));

    expect(mocks.dictationHelperCommand).toHaveBeenCalledWith({
      type: "discard_mic_test",
    });
    expect(mocks.setDictationMicrophone).toHaveBeenCalledWith("usb", "USB Mic");
    expect(
      screen.getByRole("button", { name: "Start test" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Play microphone test sample" }),
    ).toBeNull();
  });

  it("resets microphone test state when leaving audio settings", async () => {
    const user = userEvent.setup();
    render(
      <AppSettings
        account={signedInAccount}
        accountLoading={false}
        sourceMode="microphoneOnly"
        checkingSourceReadiness={false}
        onAccountChanged={vi.fn()}
        onAccountRefresh={vi.fn()}
        onSourceModeChange={vi.fn()}
        onEnableSystemAudio={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Audio" }));
    await user.click(screen.getByRole("button", { name: "Start test" }));
    mocks.eventHandler?.({
      payload: JSON.stringify({
        type: "mic_test_ready",
        payload: {
          path: "/tmp/os-scribe-mic-test.m4a",
          durationMs: 5000,
          observedAudioLevel: "0.72",
        },
      }),
    });
    expect(
      await screen.findByRole("button", {
        name: "Play microphone test sample",
      }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Dictation" }));
    await waitFor(() =>
      expect(mocks.dictationHelperCommand).toHaveBeenCalledWith({
        type: "discard_mic_test",
      }),
    );

    await user.click(screen.getByRole("tab", { name: "Audio" }));
    expect(
      screen.getByRole("button", { name: "Start test" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Play microphone test sample" }),
    ).toBeNull();
  });

  it("saves the default transcription language", async () => {
    const user = userEvent.setup();
    render(
      <AppSettings
        account={signedInAccount}
        accountLoading={false}
        sourceMode="microphoneOnly"
        checkingSourceReadiness={false}
        onAccountChanged={vi.fn()}
        onAccountRefresh={vi.fn()}
        onSourceModeChange={vi.fn()}
        onEnableSystemAudio={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Dictation" }));
    const language = await screen.findByRole("button", {
      name: "Default transcription language",
    });

    await user.click(language);
    expect(screen.getByRole("option", { name: "Vietnamese" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    await user.click(await screen.findByRole("option", { name: "Vietnamese" }));

    expect(mocks.setDictationLanguage).toHaveBeenCalledWith("vi");
    await waitFor(() => expect(language).toHaveTextContent("Vietnamese"));
  });

  it("lists system permissions with status and manage actions", async () => {
    const user = userEvent.setup();
    const onEnableMicrophone = vi.fn();
    const onEnableAccessibility = vi.fn();
    const onEnableSystemAudio = vi.fn();
    render(
      <AppSettings
        account={signedInAccount}
        accountLoading={false}
        sourceMode="microphoneOnly"
        sourceReadiness={{
          sourceMode: "microphonePlusSystem",
          ready: false,
          checkedAt: "2026-06-08T12:00:00Z",
          sources: [
            {
              source: "microphone",
              required: true,
              ready: false,
              permissionState: "denied",
              deviceAvailable: false,
              captureAvailable: false,
              recoveryAction: "openMicrophoneSettings",
            },
            {
              source: "system",
              required: true,
              ready: false,
              permissionState: "denied",
              deviceAvailable: true,
              captureAvailable: false,
              recoveryAction: "openSystemAudioSettings",
            },
          ],
        }}
        checkingSourceReadiness={false}
        microphonePermissionStatus="denied"
        accessibilityPermissionStatus="missing"
        onAccountChanged={vi.fn()}
        onAccountRefresh={vi.fn()}
        onSourceModeChange={vi.fn()}
        onEnableMicrophone={onEnableMicrophone}
        onEnableAccessibility={onEnableAccessibility}
        onEnableSystemAudio={onEnableSystemAudio}
      />,
    );

    const microphoneRow = screen
      .getByText("Microphone")
      .closest(".settings-row");
    const accessibilityRow = screen
      .getByText("Accessibility")
      .closest(".settings-row");
    const systemAudioRow = screen
      .getByText("System audio")
      .closest(".settings-row");

    expect(microphoneRow).not.toBeNull();
    expect(accessibilityRow).not.toBeNull();
    expect(systemAudioRow).not.toBeNull();
    expect(
      within(microphoneRow as HTMLElement).getByLabelText("Blocked"),
    ).toBeInTheDocument();
    expect(
      within(accessibilityRow as HTMLElement).getByLabelText("Needs access"),
    ).toBeInTheDocument();
    expect(
      within(systemAudioRow as HTMLElement).getByLabelText("Blocked"),
    ).toBeInTheDocument();

    await user.click(
      within(microphoneRow as HTMLElement).getByRole("button", {
        name: "Manage Microphone permission",
      }),
    );
    await user.click(
      within(accessibilityRow as HTMLElement).getByRole("button", {
        name: "Manage Accessibility permission",
      }),
    );
    await user.click(
      within(systemAudioRow as HTMLElement).getByRole("button", {
        name: "Manage System audio permission",
      }),
    );

    expect(onEnableMicrophone).toHaveBeenCalledTimes(1);
    expect(onEnableAccessibility).toHaveBeenCalledTimes(1);
    expect(onEnableSystemAudio).toHaveBeenCalledTimes(1);
  });

  it("only lists microphone permissions on Windows", async () => {
    const restoreNavigator = stubNavigatorPlatform(
      "Win32",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    );
    const onEnableMicrophone = vi.fn();
    const onEnableAccessibility = vi.fn();
    const onEnableSystemAudio = vi.fn();

    try {
      render(
        <AppSettings
          account={signedInAccount}
          accountLoading={false}
          sourceMode="microphoneOnly"
          sourceReadiness={{
            sourceMode: "microphonePlusSystem",
            ready: false,
            checkedAt: "2026-06-08T12:00:00Z",
            sources: [
              {
                source: "microphone",
                required: true,
                ready: false,
                permissionState: "denied",
                deviceAvailable: false,
                captureAvailable: false,
                recoveryAction: "openMicrophoneSettings",
              },
              {
                source: "system",
                required: true,
                ready: false,
                permissionState: "denied",
                deviceAvailable: true,
                captureAvailable: false,
                recoveryAction: "openSystemAudioSettings",
              },
            ],
          }}
          checkingSourceReadiness={false}
          microphonePermissionStatus="denied"
          accessibilityPermissionStatus="missing"
          onAccountChanged={vi.fn()}
          onAccountRefresh={vi.fn()}
          onSourceModeChange={vi.fn()}
          onEnableMicrophone={onEnableMicrophone}
          onEnableAccessibility={onEnableAccessibility}
          onEnableSystemAudio={onEnableSystemAudio}
        />,
      );

      expect(
        screen.getByText("Access used for recording audio."),
      ).toBeInTheDocument();
      expect(screen.getByText("Microphone")).toBeInTheDocument();
      expect(screen.queryByText("Accessibility")).not.toBeInTheDocument();
      expect(screen.queryByText("System audio")).not.toBeInTheDocument();

      const microphoneRow = screen
        .getByText("Microphone")
        .closest(".settings-row");
      expect(microphoneRow).not.toBeNull();
      await userEvent.click(
        within(microphoneRow as HTMLElement).getByRole("button", {
          name: "Manage Microphone permission",
        }),
      );

      expect(onEnableMicrophone).toHaveBeenCalledTimes(1);
      expect(onEnableAccessibility).not.toHaveBeenCalled();
      expect(onEnableSystemAudio).not.toHaveBeenCalled();

      await userEvent.click(screen.getByRole("tab", { name: "Audio" }));
      expect(
        screen.queryByRole("switch", {
          name: "Capture system audio for notes",
        }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", {
          name: "Start test",
        }),
      ).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole("tab", { name: "Shortcuts" }));
      expect(
        screen.getByText("Dictation shortcuts unavailable"),
      ).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
    } finally {
      restoreNavigator();
    }
  });

  it("records push-to-talk and toggle dictation shortcuts in settings", async () => {
    const user = userEvent.setup();
    render(
      <AppSettings
        account={signedInAccount}
        accountLoading={false}
        sourceMode="microphoneOnly"
        checkingSourceReadiness={false}
        onAccountChanged={vi.fn()}
        onAccountRefresh={vi.fn()}
        onSourceModeChange={vi.fn()}
        onEnableSystemAudio={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Shortcuts" }));
    expect(await screen.findByText("Push to talk")).toBeInTheDocument();
    expect(screen.getByText("Toggle dictation")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Dictation activation mode"),
    ).not.toBeInTheDocument();

    const changeButtons = await screen.findAllByRole("button", {
      name: "Change",
    });
    await user.click(changeButtons[0]);
    await waitFor(() =>
      expect(mocks.dictationHelperCommand).toHaveBeenCalledWith({
        type: "start_shortcut_capture",
        pressCount: 1,
      }),
    );
    mocks.eventHandler?.({
      payload: JSON.stringify({
        type: "shortcut_captured",
        payload: {
          shortcut: {
            code: "Fn",
            label: "Fn",
            modifiers: {
              command: false,
              control: false,
              option: false,
              shift: false,
              function: true,
            },
            pressCount: 1,
          },
        },
      }),
    });

    await waitFor(() =>
      expect(mocks.setDictationShortcut).toHaveBeenCalledWith("push_to_talk", {
        code: "Fn",
        label: "Fn",
        modifiers: {
          command: false,
          control: false,
          option: false,
          shift: false,
          function: true,
        },
        pressCount: 1,
      }),
    );

    await user.click(
      (await screen.findAllByRole("button", { name: "Change" }))[0],
    );
    await waitFor(() =>
      expect(mocks.dictationHelperCommand).toHaveBeenCalledWith({
        type: "start_shortcut_capture",
        pressCount: 1,
      }),
    );
    mocks.eventHandler?.({
      payload: JSON.stringify({
        type: "shortcut_captured",
        payload: {
          shortcut: {
            code: "Modifiers",
            label: "Ctrl+Opt",
            modifiers: {
              command: false,
              control: true,
              option: true,
              shift: false,
              function: false,
            },
            pressCount: 1,
          },
        },
      }),
    });

    await waitFor(() =>
      expect(mocks.setDictationShortcut).toHaveBeenCalledWith("push_to_talk", {
        code: "Modifiers",
        label: "Ctrl+Opt",
        modifiers: {
          command: false,
          control: true,
          option: true,
          shift: false,
          function: false,
        },
        pressCount: 1,
      }),
    );

    await user.click(
      (await screen.findAllByRole("button", { name: "Change" }))[1],
    );
    await waitFor(() =>
      expect(mocks.dictationHelperCommand).toHaveBeenCalledWith({
        type: "start_shortcut_capture",
        pressCount: 1,
      }),
    );
    mocks.eventHandler?.({
      payload: JSON.stringify({
        type: "shortcut_captured",
        payload: {
          shortcut: {
            code: "Digit1",
            label: "Ctrl+1",
            modifiers: {
              command: false,
              control: true,
              option: false,
              shift: false,
              function: false,
            },
            pressCount: 1,
          },
        },
      }),
    });

    await waitFor(() =>
      expect(mocks.setDictationShortcut).toHaveBeenCalledWith("toggle", {
        code: "Digit1",
        label: "Ctrl+1",
        modifiers: {
          command: false,
          control: true,
          option: false,
          shift: false,
          function: false,
        },
        pressCount: 1,
      }),
    );
  });

  it("captures a key chord from DOM keydown without the helper seeing keys", async () => {
    // Key chords are read from the focused window's DOM: that is what lets
    // the helper drop its keyDown monitors, whose presence triggered the
    // macOS Input Monitoring ("keylogger") prompt on first launch.
    const user = userEvent.setup();
    render(
      <AppSettings
        account={signedInAccount}
        accountLoading={false}
        sourceMode="microphoneOnly"
        checkingSourceReadiness={false}
        onAccountChanged={vi.fn()}
        onAccountRefresh={vi.fn()}
        onSourceModeChange={vi.fn()}
        onEnableSystemAudio={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Shortcuts" }));
    const changeButtons = await screen.findAllByRole("button", {
      name: "Change",
    });
    await user.click(changeButtons[0]);
    await waitFor(() =>
      expect(mocks.dictationHelperCommand).toHaveBeenCalledWith({
        type: "start_shortcut_capture",
        pressCount: 1,
      }),
    );

    fireEvent.keyDown(window, {
      key: "p",
      code: "KeyP",
      ctrlKey: true,
      altKey: true,
    });

    await waitFor(() =>
      expect(mocks.setDictationShortcut).toHaveBeenCalledWith("push_to_talk", {
        code: "KeyP",
        label: "Ctrl+Opt+P",
        modifiers: {
          command: false,
          control: true,
          option: true,
          shift: false,
          function: false,
        },
        pressCount: 1,
      }),
    );
    // The chord was decided in the DOM, so the helper capture gets cancelled.
    expect(mocks.dictationHelperCommand).toHaveBeenCalledWith({
      type: "cancel_shortcut_capture",
    });
  });

  it("resets customized dictation shortcuts and hides reset for defaults", async () => {
    const user = userEvent.setup();
    mocks.dictationSettings.mockResolvedValue({
      settings: {
        ...baseSettings,
        pushToTalkShortcut: {
          keyCode: 0x23,
          code: "KeyP",
          label: "Ctrl+P",
          pressCount: 1,
          modifiers: {
            command: false,
            control: true,
            option: false,
            shift: false,
            function: false,
          },
        },
      },
    });

    render(
      <AppSettings
        account={signedInAccount}
        accountLoading={false}
        sourceMode="microphoneOnly"
        checkingSourceReadiness={false}
        onAccountChanged={vi.fn()}
        onAccountRefresh={vi.fn()}
        onSourceModeChange={vi.fn()}
        onEnableSystemAudio={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Shortcuts" }));

    expect(
      await screen.findByRole("button", {
        name: "Reset Push to talk shortcut to default",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "Reset Toggle dictation shortcut to default",
      }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", {
        name: "Reset Push to talk shortcut to default",
      }),
    );

    await waitFor(() =>
      expect(mocks.setDictationShortcut).toHaveBeenCalledWith("push_to_talk", {
        keyCode: 0x02,
        code: "KeyD",
        label: "Ctrl+Opt+D",
        pressCount: 1,
        modifiers: {
          command: false,
          control: true,
          option: true,
          shift: false,
          function: false,
        },
      }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("button", {
          name: "Reset Push to talk shortcut to default",
        }),
      ).not.toBeInTheDocument(),
    );
  });

  it("does not show reset for legacy default shortcuts without key codes", async () => {
    const user = userEvent.setup();
    const { keyCode: _pushKeyCode, ...legacyPushToTalkShortcut } =
      baseSettings.pushToTalkShortcut;
    const { keyCode: _toggleKeyCode, ...legacyToggleShortcut } =
      baseSettings.toggleShortcut;

    mocks.dictationSettings.mockResolvedValue({
      settings: {
        ...baseSettings,
        pushToTalkShortcut: legacyPushToTalkShortcut,
        toggleShortcut: legacyToggleShortcut,
      },
    });

    render(
      <AppSettings
        account={signedInAccount}
        accountLoading={false}
        sourceMode="microphoneOnly"
        checkingSourceReadiness={false}
        onAccountChanged={vi.fn()}
        onAccountRefresh={vi.fn()}
        onSourceModeChange={vi.fn()}
        onEnableSystemAudio={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Shortcuts" }));
    expect(await screen.findByText("Push to talk")).toBeInTheDocument();
    expect(screen.getByText("Toggle dictation")).toBeInTheDocument();

    expect(
      screen.queryByRole("button", {
        name: "Reset Push to talk shortcut to default",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "Reset Toggle dictation shortcut to default",
      }),
    ).not.toBeInTheDocument();
  });

  it("loads Venice model options and saves selected models", async () => {
    const user = userEvent.setup();
    const modelChanged = vi.fn();
    window.addEventListener(
      PROVIDER_MODEL_SETTINGS_CHANGED_EVENT,
      modelChanged,
    );

    try {
      render(
        <AppSettings
          account={signedInAccount}
          accountLoading={false}
          sourceMode="microphoneOnly"
          checkingSourceReadiness={false}
          onAccountChanged={vi.fn()}
          onAccountRefresh={vi.fn()}
          onSourceModeChange={vi.fn()}
          onEnableSystemAudio={vi.fn()}
        />,
      );

      await waitFor(() =>
        expect(mocks.listVeniceModels).toHaveBeenCalledWith("transcription"),
      );
      await user.click(screen.getByRole("tab", { name: "Models" }));
      await user.click(
        await screen.findByRole("button", {
          name: "Change transcription model",
        }),
      );
      expect(
        await screen.findByRole("option", { name: /Parakeet/ }),
      ).toBeInTheDocument();
      // The non-suggested catalog lives under the All tab.
      await user.click(screen.getByRole("tab", { name: "All" }));
      expect(
        screen.getAllByText("$0.0001 per second audio").length,
      ).toBeGreaterThan(0);
      expect(screen.getAllByText("$0.003/min audio").length).toBeGreaterThan(0);
      await user.click(
        await screen.findByRole("option", { name: /GPT-4o Transcribe/ }),
      );
      expect(mocks.setVeniceModel).toHaveBeenCalledWith(
        "transcription",
        "gpt-4o-transcribe",
      );
      expect(modelChanged).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: {
            mode: "transcription",
            modelId: "gpt-4o-transcribe",
          },
        }),
      );

      await user.click(
        screen.getByRole("button", {
          name: "Change text model",
        }),
      );
      await user.click(screen.getByRole("tab", { name: "All" }));
      expect(
        screen.getAllByText("$1.00 input / $3.20 output per 1M tokens").length,
      ).toBeGreaterThan(0);
      expect(screen.getAllByText("Private mode").length).toBeGreaterThan(0);
      expect(screen.getByText("Anonymous mode")).toBeInTheDocument();
      expect(screen.queryByText("Anon")).not.toBeInTheDocument();
      await user.click(
        await screen.findByRole("option", { name: /Venice Uncensored/ }),
      );
      expect(mocks.setVeniceModel).toHaveBeenCalledWith(
        "generation",
        "venice-uncensored",
      );
      expect(modelChanged).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: {
            mode: "generation",
            modelId: "venice-uncensored",
          },
        }),
      );
    } finally {
      window.removeEventListener(
        PROVIDER_MODEL_SETTINGS_CHANGED_EVENT,
        modelChanged,
      );
    }
  });

  it("defaults the model picker to curated suggestions", async () => {
    const user = userEvent.setup();
    render(
      <AppSettings
        account={signedInAccount}
        accountLoading={false}
        sourceMode="microphoneOnly"
        checkingSourceReadiness={false}
        onAccountChanged={vi.fn()}
        onAccountRefresh={vi.fn()}
        onSourceModeChange={vi.fn()}
        onEnableSystemAudio={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("tab", { name: "Models" }));
    await user.click(
      await screen.findByRole("button", { name: "Change text model" }),
    );

    // Suggested is the default view: only the curated picks present in the
    // catalog show, each with its recommendation reason.
    expect(
      await screen.findByRole("option", { name: /GLM 5\.2/ }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("option", { name: /GLM 5\.1/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /Kimi K2\.6/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /Venice Uncensored/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Default pick/)).toBeInTheDocument();

    // All shows the full catalog, without recommendation copy.
    await user.click(screen.getByRole("tab", { name: "All" }));
    expect(
      screen.getByRole("option", { name: /Venice Uncensored/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Default pick/)).not.toBeInTheDocument();

    // Searching looks across the whole catalog even from Suggested, and a
    // suggested pick stays selectable.
    await user.click(screen.getByRole("tab", { name: "Suggested" }));
    await user.type(screen.getByLabelText("Search models"), "uncensored");
    expect(
      screen.getByRole("option", { name: /Venice Uncensored/ }),
    ).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Search models"));
    await user.click(screen.getByRole("option", { name: /GLM 5\.1/ }));
    expect(mocks.setVeniceModel).toHaveBeenCalledWith(
      "generation",
      "zai-org-glm-5-1",
    );
  });

  it("blocks selecting a text model that cannot use tools", async () => {
    // June's agent works through tool calls — a tool-less model (Venice's
    // E2EE models) bricks it, so the picker must not let it be selected.
    const user = userEvent.setup();
    render(
      <AppSettings
        account={signedInAccount}
        accountLoading={false}
        sourceMode="microphoneOnly"
        checkingSourceReadiness={false}
        onAccountChanged={vi.fn()}
        onAccountRefresh={vi.fn()}
        onSourceModeChange={vi.fn()}
        onEnableSystemAudio={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("tab", { name: "Models" }));
    await user.click(
      await screen.findByRole("button", { name: "Change text model" }),
    );
    // Tool-less models are not suggested, so judge them on the All tab.
    await user.click(await screen.findByRole("tab", { name: "All" }));

    const toolless = await screen.findByRole("option", {
      name: /E2EE Private/,
    });
    expect(toolless).toHaveAttribute("aria-disabled", "true");
    expect(screen.getAllByText("No tools").length).toBeGreaterThan(0);

    await user.click(toolless);
    expect(mocks.setVeniceModel).not.toHaveBeenCalled();

    // Tool-capable models stay selectable.
    await user.click(screen.getByRole("option", { name: /Venice Uncensored/ }));
    expect(mocks.setVeniceModel).toHaveBeenCalledWith(
      "generation",
      "venice-uncensored",
    );
  });

  it("shows app build metadata", async () => {
    render(
      <AppSettings
        account={signedInAccount}
        accountLoading={false}
        sourceMode="microphoneOnly"
        checkingSourceReadiness={false}
        onAccountChanged={vi.fn()}
        onAccountRefresh={vi.fn()}
        onSourceModeChange={vi.fn()}
        onEnableSystemAudio={vi.fn()}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "About" }));
    expect(await screen.findByText("Release version")).toBeInTheDocument();
    expect(screen.getByText(APP_VERSION)).toBeInTheDocument();
    expect(screen.getByText("Commit")).toBeInTheDocument();
    expect(screen.getByText(APP_COMMIT_HASH)).toBeInTheDocument();
  });

  it("opens the server attestation page from About through Rust", async () => {
    // Not an anchor: the webview drops target="_blank" navigations, so the
    // button must invoke the scribe_open_verify_page command instead.
    render(
      <AppSettings
        account={signedInAccount}
        accountLoading={false}
        sourceMode="microphoneOnly"
        checkingSourceReadiness={false}
        onAccountChanged={vi.fn()}
        onAccountRefresh={vi.fn()}
        onSourceModeChange={vi.fn()}
        onEnableSystemAudio={vi.fn()}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "About" }));
    await user.click(
      await screen.findByRole("button", { name: "Verify server" }),
    );
    expect(mocks.scribeOpenVerifyPage).toHaveBeenCalledOnce();
  });

  it("replays onboarding from About in dev builds", async () => {
    // vitest runs with import.meta.env.DEV = true, so the dev-only row shows.
    window.localStorage.setItem("june.onboarding.completedVersion", "99");
    const reload = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload },
    });
    try {
      render(
        <AppSettings
          account={signedInAccount}
          accountLoading={false}
          sourceMode="microphoneOnly"
          checkingSourceReadiness={false}
          onAccountChanged={vi.fn()}
          onAccountRefresh={vi.fn()}
          onSourceModeChange={vi.fn()}
          onEnableSystemAudio={vi.fn()}
        />,
      );

      const user = userEvent.setup();
      await user.click(screen.getByRole("tab", { name: "About" }));
      await user.click(
        await screen.findByRole("button", { name: "Replay onboarding" }),
      );

      // The completion flag is gone and the app reloads into the wizard.
      expect(
        window.localStorage.getItem("june.onboarding.completedVersion"),
      ).toBeNull();
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it("shows agent workspace and memory files inside Agent settings", async () => {
    const user = userEvent.setup();
    render(
      <AppSettings
        account={signedInAccount}
        accountLoading={false}
        sourceMode="microphoneOnly"
        checkingSourceReadiness={false}
        onAccountChanged={vi.fn()}
        onAccountRefresh={vi.fn()}
        onSourceModeChange={vi.fn()}
        onEnableSystemAudio={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Agent" }));
    await user.click(screen.getByRole("button", { name: "Files" }));

    expect(await screen.findByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("Memory")).toBeInTheDocument();
    expect(screen.getByText("sample.pdf")).toBeInTheDocument();
    expect(screen.getByText("USER.md")).toBeInTheDocument();
    expect(screen.queryByText("Logs")).toBeNull();
  });

  it("toggles the agent HUD from Agent settings", async () => {
    const user = userEvent.setup();
    render(
      <AppSettings
        account={signedInAccount}
        accountLoading={false}
        sourceMode="microphoneOnly"
        checkingSourceReadiness={false}
        onAccountChanged={vi.fn()}
        onAccountRefresh={vi.fn()}
        onSourceModeChange={vi.fn()}
        onEnableSystemAudio={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Agent" }));
    const hudSwitch = await screen.findByRole("switch", {
      name: "Show sessions HUD",
    });

    expect(hudSwitch).toHaveAttribute("aria-checked", "true");

    await user.click(hudSwitch);
    expect(localStorage.getItem(AGENT_HUD_ENABLED_KEY)).toBe("false");
    expect(mocks.agentHudHide).toHaveBeenCalledTimes(1);

    await user.click(hudSwitch);
    expect(localStorage.getItem(AGENT_HUD_ENABLED_KEY)).toBe("true");
    expect(mocks.agentHudShow).toHaveBeenCalledTimes(1);
  });

  it("opts into agent CLI access from Agent settings", async () => {
    const user = userEvent.setup();
    render(
      <AppSettings
        account={signedInAccount}
        accountLoading={false}
        sourceMode="microphoneOnly"
        checkingSourceReadiness={false}
        onAccountChanged={vi.fn()}
        onAccountRefresh={vi.fn()}
        onSourceModeChange={vi.fn()}
        onEnableSystemAudio={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Agent" }));
    const cliSwitch = await screen.findByRole("switch", {
      name: "Allow agent CLI access",
    });
    // The disclosure names the deferred-execution risk, not just the benefit.
    expect(screen.getByText(/runs outside June's sandbox/)).toBeInTheDocument();

    await waitFor(() => expect(cliSwitch).toBeEnabled());
    expect(cliSwitch).toHaveAttribute("aria-checked", "false");

    await user.click(cliSwitch);
    await waitFor(() =>
      expect(mocks.setHermesAgentCliAccess).toHaveBeenCalledWith(true),
    );
    expect(cliSwitch).toHaveAttribute("aria-checked", "true");

    await user.click(cliSwitch);
    await waitFor(() =>
      expect(mocks.setHermesAgentCliAccess).toHaveBeenCalledWith(false),
    );
    expect(cliSwitch).toHaveAttribute("aria-checked", "false");
  });
});
