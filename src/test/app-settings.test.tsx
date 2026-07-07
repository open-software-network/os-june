import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppSettings } from "../components/settings/AppSettings";
import type { AccountStatus, DictationSettingsDto } from "../lib/tauri";
import { APP_COMMIT_HASH, APP_VERSION } from "../app/build-info";
import { AGENT_HUD_ENABLED_KEY } from "../lib/agent-hud-settings";
import { MESSAGING_PLATFORMS_LOAD_TIMEOUT_MS } from "../lib/hermes-messaging";
import { PROVIDER_MODEL_SETTINGS_CHANGED_EVENT } from "../lib/model-privacy";

const mocks = vi.hoisted(() => ({
  dictationSettings: vi.fn(),
  dictationHotkeyStatus: vi.fn(),
  dictationHelperCommand: vi.fn(),
  localAudioFileSrc: vi.fn(),
  providerModelSettings: vi.fn(),
  p3aSettings: vi.fn(),
  setP3aEnabled: vi.fn(),
  listVeniceModels: vi.fn(),
  setVeniceModel: vi.fn(),
  setVeniceApiKey: vi.fn(),
  clearVeniceApiKey: vi.fn(),
  setImageSafeMode: vi.fn(),
  setImageSafeModePromptDismissed: vi.fn(),
  saveLocalGenerationSettings: vi.fn(),
  setLocalGenerationEnabled: vi.fn(),
  probeLocalGenerationEndpoint: vi.fn(),
  openPrivacySettings: vi.fn(),
  setDictationShortcut: vi.fn(),
  setDictationMicrophone: vi.fn(),
  setDictationLanguage: vi.fn(),
  osAccountsLogin: vi.fn(),
  osAccountsCancelLogin: vi.fn(),
  osAccountsLogout: vi.fn(),
  osAccountsOpenPortal: vi.fn(),
  osAccountsUpgrade: vi.fn(),
  osAccountsChangePlan: vi.fn(),
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
  juneOpenCommunityPage: vi.fn(),
  juneOpenVerifyPage: vi.fn(),
  getReleaseChannel: vi.fn(),
  setReleaseChannel: vi.fn(),
  reconcileToStable: vi.fn(),
  listen: vi.fn(),
  eventHandler: undefined as ((event: { payload: string }) => void) | undefined,
}));

vi.mock("../lib/updater", () => ({
  getReleaseChannel: mocks.getReleaseChannel,
  setReleaseChannel: mocks.setReleaseChannel,
  reconcileToStable: mocks.reconcileToStable,
}));

// Pin a prerelease build so the leave-rc reconcile offer can be exercised; the
// About meta rows read these same mocked constants.
vi.mock("../app/build-info", () => ({
  APP_VERSION: "9.9.9-rc.2",
  APP_COMMIT_HASH: "abc1234",
}));

vi.mock("../lib/tauri", () => ({
  JUNE_COMMUNITY_URL: "https://t.me/osjune",
  dictationHotkeyStatus: mocks.dictationHotkeyStatus,
  dictationSettings: mocks.dictationSettings,
  dictationHelperCommand: mocks.dictationHelperCommand,
  localAudioFileSrc: mocks.localAudioFileSrc,
  providerModelSettings: mocks.providerModelSettings,
  p3aSettings: mocks.p3aSettings,
  setP3aEnabled: mocks.setP3aEnabled,
  listVeniceModels: mocks.listVeniceModels,
  setVeniceModel: mocks.setVeniceModel,
  setVeniceApiKey: mocks.setVeniceApiKey,
  clearVeniceApiKey: mocks.clearVeniceApiKey,
  setImageSafeMode: mocks.setImageSafeMode,
  setImageSafeModePromptDismissed: mocks.setImageSafeModePromptDismissed,
  saveLocalGenerationSettings: mocks.saveLocalGenerationSettings,
  setLocalGenerationEnabled: mocks.setLocalGenerationEnabled,
  probeLocalGenerationEndpoint: mocks.probeLocalGenerationEndpoint,
  openPrivacySettings: mocks.openPrivacySettings,
  setDictationShortcut: mocks.setDictationShortcut,
  setDictationMicrophone: mocks.setDictationMicrophone,
  setDictationLanguage: mocks.setDictationLanguage,
  osAccountsLogin: mocks.osAccountsLogin,
  osAccountsCancelLogin: mocks.osAccountsCancelLogin,
  osAccountsLogout: mocks.osAccountsLogout,
  osAccountsOpenPortal: mocks.osAccountsOpenPortal,
  osAccountsUpgrade: mocks.osAccountsUpgrade,
  osAccountsChangePlan: mocks.osAccountsChangePlan,
  hermesBridgeSkills: mocks.hermesBridgeSkills,
  hermesBridgeToolsets: mocks.hermesBridgeToolsets,
  hermesBridgeMessagingPlatforms: mocks.hermesBridgeMessagingPlatforms,
  hermesBridgeFilesystemSnapshot: mocks.hermesBridgeFilesystemSnapshot,
  toggleHermesBridgeSkill: mocks.toggleHermesBridgeSkill,
  toggleHermesBridgeToolset: mocks.toggleHermesBridgeToolset,
  updateHermesBridgeMessagingPlatform: mocks.updateHermesBridgeMessagingPlatform,
  agentHudShow: mocks.agentHudShow,
  agentHudHide: mocks.agentHudHide,
  hermesAgentCliAccess: mocks.hermesAgentCliAccess,
  setHermesAgentCliAccess: mocks.setHermesAgentCliAccess,
  listDictionaryEntries: mocks.listDictionaryEntries,
  createDictionaryEntry: mocks.createDictionaryEntry,
  updateDictionaryEntry: mocks.updateDictionaryEntry,
  deleteDictionaryEntry: mocks.deleteDictionaryEntry,
  juneOpenCommunityPage: mocks.juneOpenCommunityPage,
  juneOpenVerifyPage: mocks.juneOpenVerifyPage,
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
    handle: "alex",
    email: "alex@example.com",
    displayName: "Alex",
  },
  balance: { usdMillis: 1200, usageRemainingPercent: 100 },
};

// Mirrors the backend's local-generation state across the split
// save/enable/disable commands so the mocks can return a coherent settings
// snapshot regardless of call order.
type LocalGenerationState = {
  baseUrl: string;
  modelId: string;
  apiKey: string;
  enabled: boolean;
};

let localState: LocalGenerationState;

function buildProviderSettings() {
  return {
    transcriptionProvider: "venice",
    generationProvider: localState.enabled ? "local" : "venice",
    transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
    generationModel: localState.enabled ? localState.modelId : "zai-org-glm-5-2",
    remoteGenerationModel: "zai-org-glm-5-2",
    imageModel: "venice-sd35",
    veniceApiKeyConfigured: false,
    localGeneration: {
      baseUrl: localState.baseUrl,
      modelId: localState.modelId,
      apiKey: localState.apiKey,
    },
    imageSafeMode: true,
    imageSafeModePromptDismissed: false,
  };
}

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
    localState = { baseUrl: "", modelId: "", apiKey: "", enabled: false };
    mocks.eventHandler = undefined;
    mocks.dictationSettings.mockResolvedValue({ settings: baseSettings });
    mocks.dictationHotkeyStatus.mockResolvedValue({
      type: "hotkey_trigger_ready",
      payload: { shortcut: baseSettings.pushToTalkShortcut },
    });
    mocks.localAudioFileSrc.mockImplementation((path) => `asset://${path}`);
    mocks.setDictationLanguage.mockImplementation(async (language) => ({
      ...baseSettings,
      language,
    }));
    mocks.listDictionaryEntries.mockResolvedValue([]);
    mocks.juneOpenCommunityPage.mockResolvedValue(undefined);
    mocks.juneOpenVerifyPage.mockResolvedValue(undefined);
    mocks.getReleaseChannel.mockResolvedValue("stable");
    mocks.setReleaseChannel.mockResolvedValue(undefined);
    mocks.reconcileToStable.mockResolvedValue(null);
    mocks.providerModelSettings.mockResolvedValue({
      settings: {
        transcriptionProvider: "venice",
        generationProvider: "venice",
        transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
        generationModel: "zai-org-glm-5-2",
        remoteGenerationModel: "zai-org-glm-5-2",
        imageModel: "venice-sd35",
        veniceApiKeyConfigured: false,
        localGeneration: {
          baseUrl: "",
          modelId: "",
          apiKey: "",
        },
        imageSafeMode: true,
        imageSafeModePromptDismissed: false,
      },
    });
    mocks.p3aSettings.mockResolvedValue({
      settings: { enabled: false, consentVersion: 1, consentedAtWeek: null },
    });
    mocks.setP3aEnabled.mockImplementation((enabled: boolean) =>
      Promise.resolve({
        settings: {
          enabled,
          consentVersion: 1,
          consentedAtWeek: enabled ? "2026-W28" : null,
        },
      }),
    );
    mocks.listVeniceModels.mockImplementation(async (mode) => ({
      mode,
      modelType: mode === "transcription" ? "asr" : "text",
      selectedModel: mode === "transcription" ? "nvidia/parakeet-tdt-0.6b-v3" : "zai-org-glm-5-2",
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
                description: "Open-weights model built for long tool-driven tasks.",
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
        mode === "transcription" && modelId.startsWith("gpt-") ? "openai" : "venice",
      generationProvider: "venice",
      transcriptionModel: mode === "transcription" ? modelId : "nvidia/parakeet-tdt-0.6b-v3",
      generationModel: mode === "generation" ? modelId : "zai-org-glm-5-2",
      remoteGenerationModel: mode === "generation" ? modelId : "zai-org-glm-5-2",
      imageModel: mode === "image" ? modelId : "venice-sd35",
      veniceApiKeyConfigured: false,
      localGeneration: {
        baseUrl: localState.baseUrl,
        modelId: localState.modelId,
        apiKey: localState.apiKey,
      },
      imageSafeMode: true,
      imageSafeModePromptDismissed: false,
    }));
    mocks.setImageSafeMode.mockImplementation(async (enabled: boolean) => ({
      ...buildProviderSettings(),
      imageSafeMode: enabled,
    }));
    mocks.setVeniceApiKey.mockResolvedValue({
      ...buildProviderSettings(),
      veniceApiKeyConfigured: true,
    });
    mocks.clearVeniceApiKey.mockResolvedValue({
      ...buildProviderSettings(),
      veniceApiKeyConfigured: false,
    });
    mocks.saveLocalGenerationSettings.mockImplementation(async ({ baseUrl, modelId, apiKey }) => {
      localState = { ...localState, baseUrl, modelId, apiKey };
      return buildProviderSettings();
    });
    mocks.setLocalGenerationEnabled.mockImplementation(async (enabled: boolean) => {
      localState = { ...localState, enabled };
      return buildProviderSettings();
    });
    mocks.probeLocalGenerationEndpoint.mockResolvedValue({ models: [] });
    mocks.dictationHelperCommand.mockResolvedValue(undefined);
    mocks.openPrivacySettings.mockResolvedValue(undefined);
    mocks.osAccountsLogin.mockResolvedValue(signedInAccount);
    mocks.osAccountsCancelLogin.mockResolvedValue(undefined);
    mocks.osAccountsLogout.mockResolvedValue(undefined);
    mocks.osAccountsOpenPortal.mockResolvedValue(undefined);
    mocks.osAccountsUpgrade.mockResolvedValue(undefined);
    mocks.osAccountsChangePlan.mockResolvedValue({
      subscribed: true,
      plan: "max",
      status: "active",
    });
    mocks.agentHudShow.mockResolvedValue(undefined);
    mocks.agentHudHide.mockResolvedValue(undefined);
    mocks.hermesAgentCliAccess.mockResolvedValue({ enabled: false });
    mocks.setHermesAgentCliAccess.mockImplementation(async (enabled: boolean) => ({ enabled }));
    mocks.setDictationShortcut.mockImplementation(async (kind, shortcut) => ({
      ...baseSettings,
      ...(kind === "toggle" ? { toggleShortcut: shortcut } : { pushToTalkShortcut: shortcut }),
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
          path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace",
          description: "Hermes scratch files and generated outputs.",
          entries: [
            {
              name: "sample.pdf",
              path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/workspace/sample.pdf",
              kind: "file",
              size: 1700,
              modifiedAt: "2026-06-04T18:39:00Z",
            },
          ],
        },
        {
          id: "memory",
          label: "Memory",
          path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/memory",
          description: "Persistent Hermes memory files and stores.",
          entries: [
            {
              name: "USER.md",
              path: "/Users/alex/Library/Application Support/co.opensoftware.june/hermes/memory/USER.md",
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

  it("opens checkout from Upgrade in billing settings", async () => {
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
    await user.click(screen.getByRole("button", { name: "Upgrade to Pro" }));
    expect(mocks.osAccountsUpgrade).toHaveBeenCalledTimes(1);
    expect(mocks.osAccountsUpgrade).toHaveBeenCalledWith("pro");
  });

  it("opens Max checkout from Upgrade to Max in billing settings", async () => {
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
    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    expect(mocks.osAccountsUpgrade).toHaveBeenCalledTimes(1);
    expect(mocks.osAccountsUpgrade).toHaveBeenCalledWith("max");
  });

  it("shows and saves anonymous usage statistics in Privacy settings", async () => {
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
        activeTab="privacy"
        onTabChange={vi.fn()}
      />,
    );

    await screen.findByRole("heading", { name: "Privacy" });
    const toggle = screen.getByRole("switch", { name: "Share anonymous usage statistics" });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    await user.click(toggle);

    await waitFor(() => expect(mocks.setP3aEnabled).toHaveBeenCalledWith(true));
    expect(
      await screen.findByText("Anonymous usage statistics are on for this device."),
    ).toBeInTheDocument();
    expect(screen.getByText("2026-W28")).toBeInTheDocument();
  });

  it("shows usage remaining as a percentage instead of dollars", async () => {
    const user = userEvent.setup();
    render(
      <AppSettings
        account={{
          ...signedInAccount,
          balance: {
            credits: 1200,
            usdMillis: 1200,
            usageRemainingPercent: 64,
          },
        }}
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

    expect(screen.getByRole("heading", { name: "Billing" })).toBeInTheDocument();
    expect(screen.getByText("64%")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Free plan" })).toBeInTheDocument();
    expect(screen.getByText("Usage remaining")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Usage remaining" })).toHaveAttribute(
      "aria-valuenow",
      "64",
    );
    expect(screen.queryByText("$1.20")).not.toBeInTheDocument();
  });

  it("changes the accent color through the appearance picker", () => {
    vi.useFakeTimers();
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

      // The accessible name carries the current selection so screen readers
      // announce the active accent, not just the static "Accent color" label.
      const trigger = (label: string) =>
        screen.getByRole("button", { name: `Accent color: ${label}` });
      expect(trigger("Clay")).toHaveTextContent("Clay");

      // Pick a non-default accent from the shared select popover.
      fireEvent.click(trigger("Clay"));
      fireEvent.click(screen.getByRole("option", { name: "Rose" }));
      act(() => {
        vi.advanceTimersByTime(320);
      });

      expect(localStorage.getItem("os-june:brand")).toBe("rose");
      expect(trigger("Rose")).toHaveTextContent("Rose");

      // Re-selecting the default from the list is the reset (no separate
      // button), mirroring how the language picker's "Auto-detect" works.
      fireEvent.click(trigger("Rose"));
      fireEvent.click(screen.getByRole("option", { name: "Clay" }));
      act(() => {
        vi.advanceTimersByTime(320);
      });

      expect(localStorage.getItem("os-june:brand")).toBe("clay");
      expect(trigger("Clay")).toHaveTextContent("Clay");
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to subscription plan credits when balance has no usage percentage", async () => {
    const user = userEvent.setup();
    render(
      <AppSettings
        account={{
          ...signedInAccount,
          balance: {
            credits: 4676,
            usdMillis: 4676,
          },
          subscription: {
            subscribed: true,
            status: "active",
            planCredits: 20000,
          },
        }}
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

    expect(screen.getByText("23%")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pro plan" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Usage remaining" })).toHaveAttribute(
      "aria-valuenow",
      "23",
    );
  });

  it("falls back to the free grant for unsubscribed accounts without usage percentage", async () => {
    const user = userEvent.setup();
    render(
      <AppSettings
        account={{
          ...signedInAccount,
          balance: {
            credits: 1943,
            usdMillis: 1943,
          },
          subscription: {
            subscribed: false,
            status: undefined,
            planCredits: undefined,
          },
        }}
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

    expect(screen.getByText("97%")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Free plan" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Usage remaining" })).toHaveAttribute(
      "aria-valuenow",
      "97",
    );
  });

  it("runs sign-in, cancel, and sign-out actions from account settings", async () => {
    const user = userEvent.setup();
    const onAccountChanged = vi.fn();
    render(
      <AppSettings
        account={{ signedIn: false, configured: true }}
        accountLoading={false}
        sourceMode="microphoneOnly"
        checkingSourceReadiness={false}
        onAccountChanged={onAccountChanged}
        onAccountRefresh={vi.fn()}
        onSourceModeChange={vi.fn()}
        onEnableSystemAudio={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Sign in with OpenSoftware" }));
    await waitFor(() => expect(mocks.osAccountsLogin).toHaveBeenCalledOnce());
    expect(onAccountChanged).toHaveBeenCalledWith(signedInAccount);
    expect(await screen.findByText("Signed in as Alex.")).toBeInTheDocument();

    mocks.osAccountsLogin.mockReset();
    let rejectLogin: (error: Error) => void = () => undefined;
    mocks.osAccountsLogin.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectLogin = reject;
        }),
    );
    await user.click(screen.getByRole("button", { name: "Sign in with OpenSoftware" }));
    expect(await screen.findByRole("button", { name: "Cancel" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.osAccountsCancelLogin).toHaveBeenCalledOnce();
    rejectLogin(new Error("Login canceled"));
    expect(await screen.findByRole("button", { name: "Sign in with OpenSoftware" })).toBeEnabled();

    const signedOut = vi.fn();
    render(
      <AppSettings
        account={signedInAccount}
        accountLoading={false}
        sourceMode="microphoneOnly"
        checkingSourceReadiness={false}
        onAccountChanged={signedOut}
        onAccountRefresh={vi.fn()}
        onSourceModeChange={vi.fn()}
        onEnableSystemAudio={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(mocks.osAccountsLogout).toHaveBeenCalledWith({ clearBrowserSession: true });
    expect(signedOut).toHaveBeenCalledWith({
      signedIn: false,
      configured: signedInAccount.configured,
    });
    expect(await screen.findByText("Signed out.")).toBeInTheDocument();
  });

  it("opens the account portal and refreshes billing from billing settings", async () => {
    const user = userEvent.setup();
    const onAccountRefresh = vi.fn().mockResolvedValue(signedInAccount);
    render(
      <AppSettings
        account={{
          ...signedInAccount,
          subscription: {
            subscribed: true,
            status: "active",
            currentPeriodEnd: "2027-02-03T00:00:00Z",
          },
        }}
        accountLoading={false}
        sourceMode="microphoneOnly"
        checkingSourceReadiness={false}
        onAccountChanged={vi.fn()}
        onAccountRefresh={onAccountRefresh}
        onSourceModeChange={vi.fn()}
        onEnableSystemAudio={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Billing" }));
    await user.click(screen.getByRole("button", { name: "Manage billing" }));
    expect(mocks.osAccountsOpenPortal).toHaveBeenCalledOnce();
    expect(
      await screen.findByText("Opened your account portal in the browser."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Refresh usage" }));
    await waitFor(() => expect(onAccountRefresh).toHaveBeenCalledOnce());
  });

  it("shows billing recovery for past-due subscriptions with credits", async () => {
    const user = userEvent.setup();
    render(
      <AppSettings
        account={{
          ...signedInAccount,
          balance: {
            credits: 1200,
            usdMillis: 1200,
            usageRemainingPercent: 100,
          },
          subscription: {
            subscribed: true,
            status: "past_due",
          },
        }}
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

    expect(screen.getByRole("heading", { name: "Pro plan" })).toBeInTheDocument();
    expect(screen.getByText("Update billing in your account portal.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Manage billing" }));
    expect(mocks.osAccountsOpenPortal).toHaveBeenCalledOnce();
    expect(
      await screen.findByText("Opened your account portal in the browser."),
    ).toBeInTheDocument();
  });

  it("treats subscribed accounts as paid when status is absent", async () => {
    const user = userEvent.setup();
    render(
      <AppSettings
        account={{
          ...signedInAccount,
          balance: {
            credits: 1200,
            usdMillis: 1200,
            usageRemainingPercent: 100,
          },
          subscription: { subscribed: true },
        }}
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

    expect(screen.getByRole("heading", { name: "Pro plan" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage billing" })).toBeInTheDocument();
    // Pro subscribers can upgrade in place to Max, but never see the Free
    // checkout CTAs.
    expect(screen.getByRole("button", { name: "Upgrade to Max" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upgrade to Pro" })).not.toBeInTheDocument();
  });

  function renderProBillingSettings(
    onAccountRefresh: () => Promise<AccountStatus | undefined> = vi.fn(async () => undefined),
  ) {
    render(
      <AppSettings
        account={{
          ...signedInAccount,
          balance: { credits: 1200, usdMillis: 1200, usageRemainingPercent: 40 },
          subscription: { subscribed: true, status: "active", plan: "pro" },
        }}
        accountLoading={false}
        sourceMode="microphoneOnly"
        checkingSourceReadiness={false}
        onAccountChanged={vi.fn()}
        onAccountRefresh={onAccountRefresh}
        onSourceModeChange={vi.fn()}
        onEnableSystemAudio={vi.fn()}
      />,
    );
    return onAccountRefresh;
  }

  const MAX_CONFIRM_BODY =
    "Max is $100 per month, charged to your saved card now. Your billing cycle restarts today.";

  it("never changes plans without an explicit confirm", async () => {
    const user = userEvent.setup();
    renderProBillingSettings();

    await user.click(screen.getByRole("tab", { name: "Billing" }));
    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));

    // The CTA opens the charge confirm; nothing has been billed yet.
    expect(await screen.findByText(MAX_CONFIRM_BODY)).toBeInTheDocument();
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();
    expect(screen.queryByText(MAX_CONFIRM_BODY)).toBeNull();
  });

  it("lets a Pro subscriber upgrade in place to Max after confirming", async () => {
    const user = userEvent.setup();
    // The poll's first refresh already shows the granted Max balance.
    const onAccountRefresh = renderProBillingSettings(
      vi.fn(async () => ({
        ...signedInAccount,
        balance: { credits: 50_000, usdMillis: 50_000, usageRemainingPercent: 100 },
        subscription: { subscribed: true, status: "active", plan: "max" },
      })),
    );

    await user.click(screen.getByRole("tab", { name: "Billing" }));
    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    await user.click(await screen.findByRole("button", { name: "Upgrade now" }));

    expect(mocks.osAccountsChangePlan).toHaveBeenCalledTimes(1);
    expect(mocks.osAccountsChangePlan).toHaveBeenCalledWith("max");
    // In-place change is not a browser checkout.
    expect(mocks.osAccountsUpgrade).not.toHaveBeenCalled();
    // The PATCH lands before the webhook grant, so the poll refreshes until
    // the balance reflects Max and the status flips to "ready".
    expect(
      await screen.findByText("You are on Max now. Your new credits are ready."),
    ).toBeInTheDocument();
    // Single ordered refresh path: the poll's immediate tick is the only
    // refresh, so a stale parallel response can never overwrite the granted
    // Max snapshot.
    await waitFor(() => expect(onAccountRefresh).toHaveBeenCalledTimes(1));
  });

  it("shows a pending confirm state and blocks double-fires while the change is in flight", async () => {
    const user = userEvent.setup();
    let resolveChange: ((value: unknown) => void) | undefined;
    mocks.osAccountsChangePlan.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveChange = resolve;
        }),
    );
    renderProBillingSettings();

    await user.click(screen.getByRole("tab", { name: "Billing" }));
    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    const confirm = await screen.findByRole("button", { name: "Upgrade now" });
    await user.click(confirm);

    // Busy feedback while the PATCH is in flight, disabled against a second
    // fire; a rapid second click must not charge twice.
    const busy = await screen.findByRole("button", { name: "Upgrading..." });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(mocks.osAccountsChangePlan).toHaveBeenCalledTimes(1);

    resolveChange?.({ subscribed: true, plan: "max", status: "active" });
    await waitFor(() => expect(screen.queryByText(MAX_CONFIRM_BODY)).toBeNull());
  });

  it("keeps the confirm open showing the failure when the change errors", async () => {
    const user = userEvent.setup();
    mocks.osAccountsChangePlan.mockRejectedValueOnce({
      code: "network_error",
      message: "Could not reach OS Accounts.",
    });
    renderProBillingSettings();

    await user.click(screen.getByRole("tab", { name: "Billing" }));
    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    await user.click(await screen.findByRole("button", { name: "Upgrade now" }));

    // The dialog stays up as the retry affordance, with the error inside it.
    expect(await screen.findByText("Could not reach OS Accounts.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upgrade now" })).toBeEnabled();
  });

  it("treats already_on_plan as a benign refresh, not an error", async () => {
    const user = userEvent.setup();
    const onAccountRefresh = vi.fn(async () => undefined);
    mocks.osAccountsChangePlan.mockRejectedValueOnce({
      code: "already_on_plan",
      message: "You are already on this plan.",
    });
    renderProBillingSettings(onAccountRefresh);

    await user.click(screen.getByRole("tab", { name: "Billing" }));
    await user.click(screen.getByRole("button", { name: "Upgrade to Max" }));
    await user.click(await screen.findByRole("button", { name: "Upgrade now" }));

    // Benign copy plus a refresh so the card shows the server's current plan.
    expect(await screen.findByText("You are already on Max.")).toBeInTheDocument();
    await waitFor(() => expect(onAccountRefresh).toHaveBeenCalled());
    expect(screen.queryByText("You are already on this plan.")).toBeNull();
  });

  it("shows Max subscribers only billing management, no upgrade path", async () => {
    const user = userEvent.setup();
    render(
      <AppSettings
        account={{
          ...signedInAccount,
          balance: { credits: 51200, usdMillis: 51200, usageRemainingPercent: 80 },
          subscription: { subscribed: true, status: "active", plan: "max" },
        }}
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

    expect(screen.getByRole("heading", { name: "Max plan" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage billing" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Upgrade to/ })).not.toBeInTheDocument();
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();
  });

  it("labels max subscriptions as the Max plan", async () => {
    const user = userEvent.setup();
    render(
      <AppSettings
        account={{
          ...signedInAccount,
          balance: {
            credits: 51200,
            usdMillis: 51200,
            usageRemainingPercent: 64,
          },
          subscription: {
            subscribed: true,
            status: "active",
            plan: "max",
          },
        }}
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

    expect(screen.getByRole("heading", { name: "Max plan" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage billing" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Upgrade to/ })).not.toBeInTheDocument();
  });

  it("hides billing and sign-out controls in local mode", () => {
    render(
      <AppSettings
        account={{
          ...signedInAccount,
          localDev: true,
          subscription: { subscribed: true, status: "active" },
        }}
        accountLoading={false}
        sourceMode="microphoneOnly"
        checkingSourceReadiness={false}
        onAccountChanged={vi.fn()}
        onAccountRefresh={vi.fn()}
        onSourceModeChange={vi.fn()}
        onEnableSystemAudio={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Requests use your local June API. No OpenSoftware account is used."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Billing" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
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
    expect(screen.getByText("Auto-detect uses MacBook Pro Microphone.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Auto-detect|USB Mic/ }));
    await user.click(await screen.findByRole("option", { name: "USB Mic" }));

    expect(mocks.setDictationMicrophone).toHaveBeenCalledWith("usb", "USB Mic");
    await waitFor(() =>
      expect(screen.getByText("Input device used for dictation.")).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("switch", { name: "Capture system audio for notes" }));
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
      expect(screen.getByRole("progressbar", { name: "Microphone test level" })).toHaveAttribute(
        "aria-valuenow",
        "72",
      ),
    );

    mocks.eventHandler?.({
      payload: JSON.stringify({
        type: "mic_test_ready",
        payload: {
          path: "/tmp/os-june-mic-test.m4a",
          durationMs: 5000,
          observedAudioLevel: "0.72",
        },
      }),
    });

    expect(await screen.findByText("Sample ready. Check volume.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play microphone test sample" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start over" })).toBeInTheDocument();

    const play = vi.spyOn(window.HTMLMediaElement.prototype, "play").mockImplementation(function (
      this: HTMLMediaElement,
    ) {
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    });
    await user.click(screen.getByRole("button", { name: "Play microphone test sample" }));

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
          path: "/tmp/os-june-mic-test.m4a",
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
          path: "/tmp/os-june-mic-test.m4a",
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

    await user.click(screen.getByRole("button", { name: /Auto-detect|USB Mic/ }));
    await user.click(await screen.findByRole("option", { name: "USB Mic" }));

    expect(mocks.dictationHelperCommand).toHaveBeenCalledWith({
      type: "discard_mic_test",
    });
    expect(mocks.setDictationMicrophone).toHaveBeenCalledWith("usb", "USB Mic");
    expect(screen.getByRole("button", { name: "Start test" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Play microphone test sample" })).toBeNull();
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
          path: "/tmp/os-june-mic-test.m4a",
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
    expect(screen.getByRole("button", { name: "Start test" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Play microphone test sample" })).toBeNull();
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

    const microphoneRow = screen.getByText("Microphone").closest(".settings-row");
    const accessibilityRow = screen.getByText("Accessibility").closest(".settings-row");
    const systemAudioRow = screen.getByText("System audio").closest(".settings-row");

    expect(microphoneRow).not.toBeNull();
    expect(accessibilityRow).not.toBeNull();
    expect(systemAudioRow).not.toBeNull();
    expect(within(microphoneRow as HTMLElement).getByLabelText("Blocked")).toBeInTheDocument();
    expect(
      within(accessibilityRow as HTMLElement).getByLabelText("Needs access"),
    ).toBeInTheDocument();
    expect(within(systemAudioRow as HTMLElement).getByLabelText("Blocked")).toBeInTheDocument();

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

      expect(screen.getByText("Access used for recording audio.")).toBeInTheDocument();
      expect(screen.getByText("Microphone")).toBeInTheDocument();
      expect(screen.queryByText("Accessibility")).not.toBeInTheDocument();
      expect(screen.queryByText("System audio")).not.toBeInTheDocument();

      const microphoneRow = screen.getByText("Microphone").closest(".settings-row");
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
      expect(screen.getByText("Dictation shortcuts unavailable")).toBeInTheDocument();
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
    expect(screen.queryByLabelText("Dictation activation mode")).not.toBeInTheDocument();

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

    await user.click((await screen.findAllByRole("button", { name: "Change" }))[0]);
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

    await user.click((await screen.findAllByRole("button", { name: "Change" }))[1]);
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

  it("shows a restarting notice when the dictation helper goes unavailable", async () => {
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

    act(() => {
      mocks.eventHandler?.({
        payload: JSON.stringify({
          type: "helper_unavailable",
          payload: { reason: "restarting", message: "Dictation stopped and is restarting." },
        }),
      });
    });

    const notice = await screen.findByRole("alert", { name: "Dictation unavailable" });
    expect(within(notice).getByText("Dictation stopped and is restarting.")).toBeInTheDocument();
    // Without a staged update there is no relaunch action.
    expect(screen.queryByRole("button", { name: "Relaunch June" })).not.toBeInTheDocument();

    // The helper re-arming the hotkey clears the notice.
    act(() => {
      mocks.eventHandler?.({
        payload: JSON.stringify({
          type: "hotkey_trigger_ready",
          payload: { shortcut: "Ctrl+Opt+D" },
        }),
      });
    });

    await waitFor(() =>
      expect(
        screen.queryByRole("alert", { name: "Dictation unavailable" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("shows persisted helper downtime when Settings opens after retries exhaust", async () => {
    const user = userEvent.setup();
    mocks.dictationHotkeyStatus.mockResolvedValue({
      type: "helper_unavailable",
      payload: {
        reason: "exhausted",
        message: "Dictation stopped and could not restart. Relaunch June to restore it.",
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

    const notice = await screen.findByRole("alert", { name: "Dictation unavailable" });
    expect(
      within(notice).getByText(
        "Dictation stopped and could not restart. Relaunch June to restore it.",
      ),
    ).toBeInTheDocument();
  });

  it("prompts a relaunch to finish updating when the helper is down mid-update", async () => {
    const user = userEvent.setup();
    const onRelaunch = vi.fn();
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
        updateReadyToRelaunch
        onRelaunch={onRelaunch}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Shortcuts" }));
    expect(await screen.findByText("Push to talk")).toBeInTheDocument();

    act(() => {
      mocks.eventHandler?.({
        payload: JSON.stringify({
          type: "helper_unavailable",
          payload: { reason: "restarting", message: "Dictation stopped and is restarting." },
        }),
      });
    });

    const notice = await screen.findByRole("alert", { name: "Dictation unavailable" });
    expect(within(notice).getByText("Relaunch to finish updating")).toBeInTheDocument();
    expect(
      within(notice).getByText("Dictation is paused until you relaunch to finish updating."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Relaunch June" }));
    expect(onRelaunch).toHaveBeenCalledTimes(1);
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
    const { keyCode: _pushKeyCode, ...legacyPushToTalkShortcut } = baseSettings.pushToTalkShortcut;
    const { keyCode: _toggleKeyCode, ...legacyToggleShortcut } = baseSettings.toggleShortcut;

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
    window.addEventListener(PROVIDER_MODEL_SETTINGS_CHANGED_EVENT, modelChanged);

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

      await waitFor(() => expect(mocks.listVeniceModels).toHaveBeenCalledWith("transcription"));
      await user.click(screen.getByRole("tab", { name: "Models" }));
      await user.click(
        await screen.findByRole("button", {
          name: "Change transcription model",
        }),
      );
      expect(await screen.findByRole("option", { name: /Parakeet/ })).toBeInTheDocument();
      const parakeetOption = screen.getByRole("option", { name: /Parakeet/ });
      expect(parakeetOption).not.toHaveTextContent("$0.0001 per second audio");
      await user.hover(parakeetOption);
      expect(await screen.findByText(/\$0\.0001 per second audio/)).toBeInTheDocument();
      await user.unhover(parakeetOption);
      // The non-suggested catalog lives behind the All models row.
      await user.click(screen.getByRole("button", { name: "All models" }));
      const transcriptionPanel = await screen.findByRole("group", {
        name: "All transcription models",
      });
      expect(
        within(transcriptionPanel).getByRole("option", { name: /GPT-4o mini Transcribe/ }),
      ).toBeInTheDocument();
      await user.click(
        await within(transcriptionPanel).findByRole("option", { name: /GPT-4o Transcribe/ }),
      );
      expect(mocks.setVeniceModel).toHaveBeenCalledWith("transcription", "gpt-4o-transcribe");
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
      await user.click(screen.getByRole("button", { name: "All models" }));
      const textPanel = await screen.findByRole("group", { name: "All text models" });
      expect(within(textPanel).getByRole("option", { name: /GLM 5\.1/ })).toBeInTheDocument();
      expect(screen.queryByText("Anon")).not.toBeInTheDocument();
      await user.click(await within(textPanel).findByRole("option", { name: /Venice Uncensored/ }));
      expect(mocks.setVeniceModel).toHaveBeenCalledWith("generation", "venice-uncensored");
      expect(modelChanged).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: {
            mode: "generation",
            modelId: "venice-uncensored",
          },
        }),
      );
    } finally {
      window.removeEventListener(PROVIDER_MODEL_SETTINGS_CHANGED_EVENT, modelChanged);
    }
  });

  it("keeps local endpoint fields hidden until local setup starts", async () => {
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

    // The primary pickers are visible, but advanced local controls are hidden
    // behind a collapsed "More options" disclosure by default.
    const trigger = await screen.findByRole("button", { name: /More options/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("switch", { name: "Use local text model" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Base URL")).not.toBeInTheDocument();

    await user.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const localSwitch = await screen.findByRole("switch", { name: "Use local text model" });
    expect(localSwitch).toBeInTheDocument();
    expect(screen.queryByLabelText("Base URL")).not.toBeInTheDocument();

    await user.click(localSwitch);

    expect(screen.getByLabelText("Base URL")).toBeInTheDocument();
    expect(screen.getByLabelText("Model ID")).toBeInTheDocument();
    expect(screen.getByText("Enter a local endpoint and model ID first.")).toBeInTheDocument();
  });

  it("auto-expands More options when a local model is already enabled", async () => {
    localState = {
      baseUrl: "http://localhost:11434/v1",
      modelId: "llama3.1:8b",
      apiKey: "",
      enabled: true,
    };
    mocks.providerModelSettings.mockResolvedValueOnce({
      settings: {
        transcriptionProvider: "venice",
        generationProvider: "local",
        transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
        generationModel: "llama3.1:8b",
        remoteGenerationModel: "zai-org-glm-5-2",
        localGeneration: {
          baseUrl: "http://localhost:11434/v1",
          modelId: "llama3.1:8b",
          apiKey: "",
        },
      },
    });
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

    // An active local model must never be hidden: the disclosure opens itself so
    // the enabled toggle and endpoint config stay reachable.
    expect(await screen.findByRole("switch", { name: "Use local text model" })).toBeInTheDocument();
    expect(screen.getByLabelText("Base URL")).toBeInTheDocument();
    expect(screen.getByLabelText("Model ID")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /More options/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("saves the draft then enables a local text model", async () => {
    const user = userEvent.setup();
    const modelChanged = vi.fn();
    window.addEventListener(PROVIDER_MODEL_SETTINGS_CHANGED_EVENT, modelChanged);

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

      await user.click(await screen.findByRole("tab", { name: "Models" }));
      // The local model config lives behind the "More options" disclosure.
      await user.click(await screen.findByRole("button", { name: /More options/ }));
      await user.click(await screen.findByRole("switch", { name: "Use local text model" }));
      await user.type(await screen.findByLabelText("Base URL"), "http://localhost:11434/v1");
      await user.type(screen.getByLabelText("Model ID"), "llama3.1:8b");
      await user.type(screen.getByLabelText("Local API key"), "sk-test");
      await user.click(screen.getByRole("switch", { name: "Use local text model" }));

      // A dirty, loopback draft is persisted first, then the provider flips —
      // enabling reads the saved settings, never the live draft.
      expect(mocks.saveLocalGenerationSettings).toHaveBeenCalledWith({
        baseUrl: "http://localhost:11434/v1",
        modelId: "llama3.1:8b",
        apiKey: "sk-test",
      });
      expect(mocks.setLocalGenerationEnabled).toHaveBeenCalledWith(true);
      expect(modelChanged).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: {
            mode: "generation",
            modelId: "llama3.1:8b",
          },
        }),
      );
      expect(await screen.findByText("Local: llama3.1:8b")).toBeInTheDocument();
    } finally {
      window.removeEventListener(PROVIDER_MODEL_SETTINGS_CHANGED_EVENT, modelChanged);
    }
  });

  it("disables a local text model without saving and keeps its fields", async () => {
    localState = {
      baseUrl: "http://localhost:11434/v1",
      modelId: "llama3.1:8b",
      apiKey: "",
      enabled: true,
    };
    mocks.providerModelSettings.mockResolvedValueOnce({
      settings: {
        transcriptionProvider: "venice",
        generationProvider: "local",
        transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
        generationModel: "llama3.1:8b",
        remoteGenerationModel: "zai-org-glm-5-2",
        localGeneration: {
          baseUrl: "http://localhost:11434/v1",
          modelId: "llama3.1:8b",
          apiKey: "",
        },
      },
    });
    const user = userEvent.setup();
    const modelChanged = vi.fn();
    window.addEventListener(PROVIDER_MODEL_SETTINGS_CHANGED_EVENT, modelChanged);

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

      await user.click(await screen.findByRole("tab", { name: "Models" }));
      await user.click(await screen.findByRole("switch", { name: "Use local text model" }));

      // Toggle-off is a pure provider flip: it never persists the draft, so
      // the stored config survives (finding: toggle-off used to wipe it).
      expect(mocks.setLocalGenerationEnabled).toHaveBeenCalledWith(false);
      expect(mocks.saveLocalGenerationSettings).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Base URL")).toHaveValue("http://localhost:11434/v1");
      expect(screen.getByLabelText("Model ID")).toHaveValue("llama3.1:8b");
      expect(modelChanged).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: {
            mode: "generation",
            modelId: "zai-org-glm-5-2",
          },
        }),
      );
    } finally {
      window.removeEventListener(PROVIDER_MODEL_SETTINGS_CHANGED_EVENT, modelChanged);
    }
  });

  it("does not duplicate the local model as a bare picker entry", async () => {
    localState = {
      baseUrl: "http://localhost:11434/v1",
      modelId: "llama3.1:8b",
      apiKey: "",
      enabled: true,
    };
    mocks.providerModelSettings.mockResolvedValueOnce({
      settings: {
        transcriptionProvider: "venice",
        generationProvider: "local",
        transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
        generationModel: "llama3.1:8b",
        remoteGenerationModel: "zai-org-glm-5-2",
        localGeneration: {
          baseUrl: "http://localhost:11434/v1",
          modelId: "llama3.1:8b",
          apiKey: "",
        },
      },
    });
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
    await user.click(await screen.findByRole("button", { name: "Change text model" }));
    await user.click(await screen.findByRole("button", { name: "All models" }));
    const panel = await screen.findByRole("group", { name: "All text models" });

    // Exactly one option references the local model id, and it is the
    // prefixed "Local:" entry — never a bare duplicate that would persist the
    // local id as the remote model (finding 1).
    const llamaOptions = within(panel)
      .getAllByRole("option")
      .filter((option) => option.textContent?.includes("llama3.1:8b"));
    expect(llamaOptions).toHaveLength(1);
    expect(llamaOptions[0].textContent).toContain("Local:");
  });

  it("keeps remote text options selectable when local model IDs collide", async () => {
    localState = {
      baseUrl: "http://localhost:11434/v1",
      modelId: "venice-uncensored",
      apiKey: "",
      enabled: false,
    };
    mocks.providerModelSettings.mockResolvedValueOnce({
      settings: {
        transcriptionProvider: "venice",
        generationProvider: "venice",
        transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
        generationModel: "venice-uncensored",
        remoteGenerationModel: "venice-uncensored",
        localGeneration: {
          baseUrl: "http://localhost:11434/v1",
          modelId: "venice-uncensored",
          apiKey: "",
        },
      },
    });
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
    expect(await screen.findByText("Venice Uncensored")).toBeInTheDocument();
    expect(screen.queryByText("Local: venice-uncensored")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Change text model" }));
    await user.click(screen.getByRole("button", { name: "All models" }));
    const panel = await screen.findByRole("group", { name: "All text models" });
    expect(
      await within(panel).findByRole("option", { name: /Local: venice-uncensored/ }),
    ).toBeInTheDocument();
    await user.click(within(panel).getByRole("option", { name: /Venice Uncensored/ }));

    expect(mocks.setVeniceModel).toHaveBeenCalledWith("generation", "venice-uncensored");
    expect(mocks.saveLocalGenerationSettings).not.toHaveBeenCalled();
    expect(mocks.setLocalGenerationEnabled).not.toHaveBeenCalled();
  });

  it("enables the local model from the picker without saving the draft", async () => {
    localState = {
      baseUrl: "http://localhost:11434/v1",
      modelId: "llama3.1:8b",
      apiKey: "",
      enabled: false,
    };
    mocks.providerModelSettings.mockResolvedValueOnce({
      settings: {
        transcriptionProvider: "venice",
        generationProvider: "venice",
        transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
        generationModel: "zai-org-glm-5-2",
        remoteGenerationModel: "zai-org-glm-5-2",
        localGeneration: {
          baseUrl: "http://localhost:11434/v1",
          modelId: "llama3.1:8b",
          apiKey: "",
        },
      },
    });
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
    await user.click(screen.getByRole("button", { name: "Change text model" }));
    await user.click(screen.getByRole("button", { name: "All models" }));
    const panel = await screen.findByRole("group", { name: "All text models" });
    await user.click(await within(panel).findByRole("option", { name: /Local: llama3\.1:8b/ }));

    // The picker option is built from the saved settings, so selecting it
    // enables from them (finding 3) rather than committing the draft.
    expect(mocks.setLocalGenerationEnabled).toHaveBeenCalledWith(true);
    expect(mocks.saveLocalGenerationSettings).not.toHaveBeenCalled();
  });

  it("routes a non-loopback picker enable through the confirm step", async () => {
    localState = {
      baseUrl: "http://192.168.1.5:11434/v1",
      modelId: "llama3.1:8b",
      apiKey: "",
      enabled: false,
    };
    mocks.providerModelSettings.mockResolvedValueOnce({
      settings: {
        transcriptionProvider: "venice",
        generationProvider: "venice",
        transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
        generationModel: "zai-org-glm-5-2",
        remoteGenerationModel: "zai-org-glm-5-2",
        localGeneration: {
          baseUrl: "http://192.168.1.5:11434/v1",
          modelId: "llama3.1:8b",
          apiKey: "",
        },
      },
    });
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
    await user.click(screen.getByRole("button", { name: "Change text model" }));
    await user.click(screen.getByRole("button", { name: "All models" }));
    const panel = await screen.findByRole("group", { name: "All text models" });
    await user.click(await within(panel).findByRole("option", { name: /Local: llama3\.1:8b/ }));

    // An off-device endpoint is never enabled silently: the picker reveals
    // the confirm affordance in the Local model section instead.
    expect(mocks.setLocalGenerationEnabled).not.toHaveBeenCalled();
    expect(
      await screen.findByText(
        "This endpoint is not on this machine. Requests will leave your device. Confirm in the Local model section to enable it.",
      ),
    ).toBeInTheDocument();
    const confirm = await screen.findByRole("button", {
      name: "Enable anyway",
    });

    // Confirming from the section proceeds with the saved settings.
    await user.click(confirm);
    expect(mocks.setLocalGenerationEnabled).toHaveBeenCalledWith(true);
    expect(mocks.saveLocalGenerationSettings).not.toHaveBeenCalled();
  });

  it("lists probed models in the Model ID datalist after a connection test", async () => {
    mocks.probeLocalGenerationEndpoint.mockResolvedValue({
      models: ["llama3.1:8b", "qwen2.5:7b"],
    });
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
    // The local model config lives behind the "More options" disclosure.
    await user.click(await screen.findByRole("button", { name: /More options/ }));
    await user.click(await screen.findByRole("switch", { name: "Use local text model" }));
    await user.type(await screen.findByLabelText("Base URL"), "http://localhost:11434/v1");
    await user.click(screen.getByRole("button", { name: "Test connection" }));

    expect(mocks.probeLocalGenerationEndpoint).toHaveBeenCalledWith({
      baseUrl: "http://localhost:11434/v1",
      apiKey: "",
    });
    expect(await screen.findByText("Connected. 2 models available.")).toBeInTheDocument();
    const datalist = document.getElementById("local-generation-models");
    const values = Array.from(datalist?.querySelectorAll("option") ?? []).map((option) =>
      option.getAttribute("value"),
    );
    expect(values).toEqual(["llama3.1:8b", "qwen2.5:7b"]);
  });

  it("warns and requires a confirm step for a non-loopback endpoint", async () => {
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
    // The local model config lives behind the "More options" disclosure.
    await user.click(await screen.findByRole("button", { name: /More options/ }));
    await user.click(await screen.findByRole("switch", { name: "Use local text model" }));
    await user.type(await screen.findByLabelText("Base URL"), "https://models.example.com/v1");
    await user.type(screen.getByLabelText("Model ID"), "llama3.1:8b");

    // A remote endpoint surfaces an inline warning up front.
    expect(
      screen.getAllByText("This endpoint is not on this machine. Requests will leave your device.")
        .length,
    ).toBeGreaterThan(0);

    // The first flip reveals the confirm affordance without enabling, and the
    // switch stays visually off.
    await user.click(screen.getByRole("switch", { name: "Use local text model" }));
    expect(mocks.setLocalGenerationEnabled).not.toHaveBeenCalled();
    expect(screen.getByRole("switch", { name: "Use local text model" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    const confirm = await screen.findByRole("button", {
      name: "Enable anyway",
    });

    // Confirming proceeds: the draft is saved, then the provider flips.
    await user.click(confirm);
    expect(mocks.saveLocalGenerationSettings).toHaveBeenCalledWith({
      baseUrl: "https://models.example.com/v1",
      modelId: "llama3.1:8b",
      apiKey: "",
    });
    expect(mocks.setLocalGenerationEnabled).toHaveBeenCalledWith(true);
  });

  it("saves and removes a Venice API key without displaying it", async () => {
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

    // The Venice API key lives behind "More options" so the average user never
    // has to reason about it. It should be hidden until the row is expanded.
    expect(screen.queryByLabelText("Venice API key")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /More options/ }));

    const input = await screen.findByLabelText("Venice API key");
    await user.type(input, "  vc_test_key  ");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(mocks.setVeniceApiKey).toHaveBeenCalledWith("vc_test_key");
    expect(await screen.findByText("Key saved.")).toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(screen.queryByDisplayValue("vc_test_key")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(mocks.clearVeniceApiKey).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("Key saved.")).not.toBeInTheDocument());
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
    await user.click(await screen.findByRole("button", { name: "Change text model" }));

    // Suggested is the default view: only the curated picks present in the
    // catalog show in the compact root menu.
    expect(await screen.findByRole("option", { name: /GLM 5\.2/ })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: /GLM 5\.1/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Kimi K2\.6/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Venice Uncensored/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All models" })).toBeInTheDocument();

    // All models shows the full available catalog in the flyout.
    await user.click(screen.getByRole("button", { name: "All models" }));
    const panel = await screen.findByRole("group", { name: "All text models" });
    expect(within(panel).getByRole("option", { name: /Venice Uncensored/ })).toBeInTheDocument();
    expect(screen.queryByText(/Default pick/)).not.toBeInTheDocument();

    // Searching filters the available catalog, and a suggested pick stays selectable.
    await user.type(within(panel).getByLabelText("Search models"), "uncensored");
    expect(within(panel).getByRole("option", { name: /Venice Uncensored/ })).toBeInTheDocument();
    await user.clear(within(panel).getByLabelText("Search models"));
    await user.click(within(panel).getByRole("option", { name: /GLM 5\.1/ }));
    expect(mocks.setVeniceModel).toHaveBeenCalledWith("generation", "zai-org-glm-5-1");
  });

  it("shows the image generation section and saves the default image model", async () => {
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

    // Our dedicated Image generation section (kept over main's inline row).
    const imageSection = screen
      .getByRole("heading", { name: "Image generation" })
      .closest("section");
    expect(imageSection).not.toBeNull();
    expect(
      within(imageSection as HTMLElement).getByRole("button", { name: "Change image model" }),
    ).toBeInTheDocument();
    expect(within(imageSection as HTMLElement).getByText("Venice SD3.5")).toBeInTheDocument();
    // Safe mode lives in the image section and defaults on (JUN-209).
    expect(
      within(imageSection as HTMLElement).getByRole("switch", {
        name: "Blur adult content in images",
      }),
    ).toBeInTheDocument();

    // The picker opens with the curated image options (no backend fetch).
    await user.click(screen.getByRole("button", { name: "Change image model" }));
    const defaultImageOption = await screen.findByRole("option", { name: /Venice SD3\.5/ });
    expect(defaultImageOption).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /FLUX 2 Pro/ })).toBeInTheDocument();
    // Expanded image catalog (from main) rendered through the shared popover:
    // the models are listed, but their metadata is revealed on hover, not inline.
    expect(screen.getByText("GPT Image 2")).toBeInTheDocument();
    expect(screen.getByText("Lustify v8")).toBeInTheDocument();
    expect(screen.getByText("Z-Image Turbo")).toBeInTheDocument();
    expect(defaultImageOption).not.toHaveTextContent(
      "Venice's default Stable Diffusion 3.5 image model.",
    );
    await user.hover(defaultImageOption);
    expect(
      await screen.findByText("Venice's default Stable Diffusion 3.5 image model."),
    ).toBeInTheDocument();
    await user.unhover(defaultImageOption);
    expect(screen.queryByText("Model details unavailable")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Search models"), "uncensored");
    expect(screen.getByRole("option", { name: /Lustify v7/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Lustify v8/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /FLUX 2 Pro/ })).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText("Search models"));
    // Image models are not fetched from the catalog.
    expect(mocks.listVeniceModels).not.toHaveBeenCalledWith("image");

    await user.click(await screen.findByRole("option", { name: /FLUX 2 Pro/ }));
    expect(mocks.setVeniceModel).toHaveBeenCalledWith("image", "flux-2-pro");
    // The picker closes after a selection.
    await waitFor(() =>
      expect(screen.queryByRole("option", { name: /FLUX 2 Pro/ })).not.toBeInTheDocument(),
    );
  });

  it("hides text models that cannot use tools", async () => {
    // June's agent works through tool calls — a tool-less model (Venice's
    // E2EE models) bricks it, so the picker leaves it out entirely.
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
    await user.click(await screen.findByRole("button", { name: "Change text model" }));
    await user.click(await screen.findByRole("button", { name: "All models" }));
    const panel = await screen.findByRole("group", { name: "All text models" });

    expect(within(panel).queryByRole("option", { name: /E2EE Private/ })).not.toBeInTheDocument();
    expect(screen.queryByText("No tools")).not.toBeInTheDocument();

    // Tool-capable models stay selectable.
    await user.click(within(panel).getByRole("option", { name: /Venice Uncensored/ }));
    expect(mocks.setVeniceModel).toHaveBeenCalledWith("generation", "venice-uncensored");
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

  it("checks for updates from About", async () => {
    const onCheckForUpdates = vi.fn();

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
        onCheckForUpdates={onCheckForUpdates}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "About" }));
    expect(await screen.findByText("Updates")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Check for updates" }));

    expect(onCheckForUpdates).toHaveBeenCalledOnce();
  });

  it("switches the release channel from About", async () => {
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
        onCheckForUpdates={vi.fn()}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "About" }));

    // The control loads the persisted channel before becoming interactive.
    const rcOption = await screen.findByRole("button", {
      name: "Release candidate",
    });
    await user.click(rcOption);

    expect(mocks.setReleaseChannel).toHaveBeenCalledWith("rc");
  });

  it("offers a stable reconcile when leaving rc on a prerelease build", async () => {
    mocks.getReleaseChannel.mockResolvedValue("rc");
    mocks.reconcileToStable.mockResolvedValue({ version: "9.9.8" });
    const onReconcileToStable = vi.fn();

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
        onCheckForUpdates={vi.fn()}
        onReconcileToStable={onReconcileToStable}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "About" }));

    const stableOption = await screen.findByRole("button", { name: "Stable" });
    await user.click(stableOption);

    expect(mocks.setReleaseChannel).toHaveBeenCalledWith("stable");
    // The bespoke in-context confirm names the exact stable on offer plus the
    // base the rc will reach once promoted (9.9.9-rc.2 -> 9.9.9).
    const confirm = await screen.findByText(/Installs 9\.9\.8/);
    expect(confirm).toHaveTextContent("9.9.9");

    await user.click(screen.getByRole("button", { name: "Switch to stable" }));
    expect(onReconcileToStable).toHaveBeenCalledOnce();
  });

  it("skips the reconcile offer when stable has nothing to install", async () => {
    mocks.getReleaseChannel.mockResolvedValue("rc");
    mocks.reconcileToStable.mockResolvedValue(null);
    const onReconcileToStable = vi.fn();

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
        onCheckForUpdates={vi.fn()}
        onReconcileToStable={onReconcileToStable}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "About" }));

    const stableOption = await screen.findByRole("button", { name: "Stable" });
    await user.click(stableOption);

    await waitFor(() => expect(mocks.reconcileToStable).toHaveBeenCalled());
    expect(screen.queryByText(/Switch to stable now/)).not.toBeInTheDocument();
    expect(onReconcileToStable).not.toHaveBeenCalled();
  });

  it("opens the server attestation page from About through Rust", async () => {
    // Not an anchor: the webview drops target="_blank" navigations, so the
    // button must invoke the june_open_verify_page command instead.
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
    await user.click(await screen.findByRole("button", { name: "Verify server" }));
    expect(mocks.juneOpenVerifyPage).toHaveBeenCalledOnce();
  });

  it("opens the June community page from About through Rust", async () => {
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
    expect(await screen.findByText("Community")).toBeInTheDocument();
    expect(screen.getByText(/t\.me\/osjune/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Join community" }));

    expect(mocks.juneOpenCommunityPage).toHaveBeenCalledOnce();
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
      await user.click(await screen.findByRole("button", { name: "Replay onboarding" }));

      // The completion flag is gone and the app reloads into the wizard.
      expect(window.localStorage.getItem("june.onboarding.completedVersion")).toBeNull();
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

    // Files is its own settings group on the Agent tab now (no inner tabs).
    await user.click(screen.getByRole("tab", { name: "Agent" }));

    expect(await screen.findByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("Memory")).toBeInTheDocument();
    expect(screen.getByText("sample.pdf")).toBeInTheDocument();
    expect(screen.getByText("USER.md")).toBeInTheDocument();
    expect(screen.queryByText("Logs")).toBeNull();
  });

  it("shows a refreshable messaging state when platform loading hangs", async () => {
    vi.useFakeTimers();
    try {
      mocks.hermesBridgeMessagingPlatforms.mockReturnValue(new Promise(() => {}));
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

      // Messaging loads on mount of the Agent tab (no inner tabs).
      fireEvent.click(screen.getByRole("tab", { name: "Agent" }));

      await act(async () => {
        vi.advanceTimersByTime(MESSAGING_PLATFORMS_LOAD_TIMEOUT_MS);
        await Promise.resolve();
      });

      expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
      expect(screen.getByText("No matching platforms")).toBeInTheDocument();
      // Messaging and Files each render their own toolbar refresh now.
      const messaging = screen.getByRole("region", { name: "Messaging platforms" });
      expect(within(messaging).getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
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
    // The deferred-execution risk moved off the row into a HoverTip on the info
    // affordance next to the title; focusing it reveals the full caveat.
    const infoAffordance = screen.getByRole("note", {
      name: "Agent CLI access details",
    });
    infoAffordance.focus();
    expect(await screen.findByText(/runs outside June's sandbox/)).toBeInTheDocument();

    await waitFor(() => expect(cliSwitch).toBeEnabled());
    expect(cliSwitch).toHaveAttribute("aria-checked", "false");

    await user.click(cliSwitch);
    await waitFor(() => expect(mocks.setHermesAgentCliAccess).toHaveBeenCalledWith(true));
    expect(cliSwitch).toHaveAttribute("aria-checked", "true");

    await user.click(cliSwitch);
    await waitFor(() => expect(mocks.setHermesAgentCliAccess).toHaveBeenCalledWith(false));
    expect(cliSwitch).toHaveAttribute("aria-checked", "false");
  });

  it("drills into a messaging platform as a pinned detail with bar actions", async () => {
    const user = userEvent.setup();
    mocks.hermesBridgeMessagingPlatforms.mockResolvedValue({
      platforms: [
        {
          id: "slack",
          name: "Slack",
          description: "Reach the agent from Slack.",
          enabled: false,
          configured: false,
          state: "ready",
          envVars: [],
        },
      ],
    });
    const onDetailPinnedChange = vi.fn();

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
        activeTab="agent"
        onTabChange={vi.fn()}
        onDetailPinnedChange={onDetailPinnedChange}
      />,
    );

    // Drill into the platform from the list.
    const platformButton = await screen.findByRole("button", { name: /Slack/ });
    await user.click(platformButton);

    // The detail pins at the top: a breadcrumb back affordance appears, the
    // host is told a detail scroller is active, and the Save + enable actions
    // live in the bar (not a separate footer). The enable action is the shared
    // Switch component (role="switch"), not a bespoke Enable button.
    expect(
      await screen.findByRole("button", { name: "Back to messaging platforms" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(onDetailPinnedChange).toHaveBeenLastCalledWith(true));
    expect(screen.getByRole("switch", { name: /Slack/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();

    // Returning to the list unpins the detail.
    await user.click(screen.getByRole("button", { name: "Back to messaging platforms" }));
    await waitFor(() => expect(onDetailPinnedChange).toHaveBeenLastCalledWith(false));
  });
});
