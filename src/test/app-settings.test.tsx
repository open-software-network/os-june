import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppSettings } from "../components/settings/AppSettings";
import type { DictationSettingsDto } from "../lib/tauri";
import { APP_COMMIT_HASH, APP_VERSION } from "../app/build-info";

const mocks = vi.hoisted(() => ({
  dictationSettings: vi.fn(),
  dictationHelperCommand: vi.fn(),
  providerModelSettings: vi.fn(),
  listVeniceModels: vi.fn(),
  setVeniceModel: vi.fn(),
  openPrivacySettings: vi.fn(),
  setDictationShortcut: vi.fn(),
  setDictationMicrophone: vi.fn(),
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
  listen: vi.fn(),
  eventHandler: undefined as ((event: { payload: string }) => void) | undefined,
}));

vi.mock("../lib/tauri", () => ({
  dictationSettings: mocks.dictationSettings,
  dictationHelperCommand: mocks.dictationHelperCommand,
  providerModelSettings: mocks.providerModelSettings,
  listVeniceModels: mocks.listVeniceModels,
  setVeniceModel: mocks.setVeniceModel,
  openPrivacySettings: mocks.openPrivacySettings,
  setDictationShortcut: mocks.setDictationShortcut,
  setDictationMicrophone: mocks.setDictationMicrophone,
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
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

const baseSettings: DictationSettingsDto = {
  pushToTalkShortcut: {
    code: "Space",
    label: "Fn+Space",
    pressCount: 1,
    modifiers: {
      command: false,
      control: false,
      option: false,
      shift: false,
      function: true,
    },
  },
  toggleShortcut: {
    code: "Space",
    label: "Ctrl+Opt+Space",
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

describe("AppSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventHandler = undefined;
    mocks.dictationSettings.mockResolvedValue({ settings: baseSettings });
    mocks.providerModelSettings.mockResolvedValue({
      settings: {
        transcriptionProvider: "venice",
        transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
        generationModel: "zai-org-glm-5",
      },
    });
    mocks.listVeniceModels.mockImplementation(async (mode) => ({
      mode,
      modelType: mode === "transcription" ? "asr" : "text",
      selectedModel:
        mode === "transcription"
          ? "nvidia/parakeet-tdt-0.6b-v3"
          : "zai-org-glm-5",
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
                id: "zai-org-glm-5",
                name: "GLM 5",
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
      generationModel: mode === "generation" ? modelId : "zai-org-glm-5",
    }));
    mocks.dictationHelperCommand.mockResolvedValue(undefined);
    mocks.openPrivacySettings.mockResolvedValue(undefined);
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

  it("opens OS Accounts from Manage and Add funds in account settings", async () => {
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

    await user.click(screen.getByRole("button", { name: "Manage" }));
    expect(mocks.osAccountsTopUp).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Add funds" }));
    expect(mocks.osAccountsTopUp).toHaveBeenCalledTimes(2);
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
        payload: { devices: [{ id: "usb", name: "USB Mic" }] },
      }),
    });

    await user.click(screen.getByRole("tab", { name: "Audio" }));
    await user.click(
      screen.getByRole("button", { name: /Auto-detect|USB Mic/ }),
    );
    await user.click(await screen.findByRole("option", { name: "USB Mic" }));

    expect(mocks.setDictationMicrophone).toHaveBeenCalledWith("usb", "USB Mic");

    await user.click(
      screen.getByRole("switch", { name: "Capture system audio for notes" }),
    );
    expect(onSourceModeChange).toHaveBeenCalledWith("microphonePlusSystem");
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

    await user.click(screen.getByRole("tab", { name: "Dictation" }));
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
            code: "Space",
            label: "Ctrl+Opt+Space",
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
      expect(mocks.setDictationShortcut).toHaveBeenCalledWith("toggle", {
        code: "Space",
        label: "Ctrl+Opt+Space",
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
  });

  it("loads Venice model options and saves selected models", async () => {
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

    await user.click(
      screen.getByRole("button", {
        name: "Change text model",
      }),
    );
    expect(
      screen.getAllByText("$1.00 input / $3.20 output per 1M tokens").length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("Anon").length).toBeGreaterThan(0);
    await user.click(
      await screen.findByRole("option", { name: /Venice Uncensored/ }),
    );
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
});
