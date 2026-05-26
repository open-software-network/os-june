import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppSettings } from "../components/settings/AppSettings";
import type { DictationSettingsDto } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  dictationSettings: vi.fn(),
  dictationHelperCommand: vi.fn(),
  providerModelSettings: vi.fn(),
  listVeniceModels: vi.fn(),
  setVeniceModel: vi.fn(),
  openPrivacySettings: vi.fn(),
  setDictationShortcut: vi.fn(),
  setDictationActivationMode: vi.fn(),
  setDictationMicrophone: vi.fn(),
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
  setDictationActivationMode: mocks.setDictationActivationMode,
  setDictationMicrophone: mocks.setDictationMicrophone,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

const baseSettings: DictationSettingsDto = {
  shortcut: {
    code: "Space",
    label: "Fn+Space",
    modifiers: {
      command: false,
      control: false,
      option: false,
      shift: false,
      function: true,
    },
  },
  activationMode: "push_to_talk",
  microphone: {},
};

describe("AppSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventHandler = undefined;
    mocks.dictationSettings.mockResolvedValue({ settings: baseSettings });
    mocks.providerModelSettings.mockResolvedValue({
      settings: {
        transcriptionProvider: "openai",
        transcriptionModel: "gpt-4o-mini-transcribe",
        generationModel: "zai-org-glm-5",
      },
    });
    mocks.listVeniceModels.mockImplementation(async (mode) => ({
      mode,
      modelType: mode === "transcription" ? "asr" : "text",
      selectedModel:
        mode === "transcription" ? "gpt-4o-mini-transcribe" : "zai-org-glm-5",
      models:
        mode === "transcription"
          ? [
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
                pricing: { input: { usd: 0.15 }, output: { usd: 0.6 } },
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
                traits: ["uncensored"],
                capabilities: [],
              },
            ],
    }));
    mocks.setVeniceModel.mockImplementation(async (mode, modelId) => ({
      transcriptionProvider: "openai",
      transcriptionModel:
        mode === "transcription" ? modelId : "gpt-4o-mini-transcribe",
      generationModel: mode === "generation" ? modelId : "zai-org-glm-5",
    }));
    mocks.dictationHelperCommand.mockResolvedValue(undefined);
    mocks.openPrivacySettings.mockResolvedValue(undefined);
    mocks.setDictationShortcut.mockImplementation(async (shortcut) => ({
      ...baseSettings,
      shortcut,
    }));
    mocks.setDictationActivationMode.mockImplementation(
      async (activationMode) => ({
        ...baseSettings,
        activationMode,
      }),
    );
    mocks.setDictationMicrophone.mockImplementation(async (id, name) => ({
      ...baseSettings,
      microphone: { id, name },
    }));
    mocks.listen.mockImplementation((_event, handler) => {
      mocks.eventHandler = handler;
      return Promise.resolve(vi.fn());
    });
  });

  it("updates dictation microphone and note recording source", async () => {
    const user = userEvent.setup();
    const onSourceModeChange = vi.fn();
    render(
      <AppSettings
        sourceMode="microphoneOnly"
        checkingSourceReadiness={false}
        onSourceModeChange={onSourceModeChange}
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

  it("records dictation shortcut and activation mode in settings", async () => {
    const user = userEvent.setup();
    render(
      <AppSettings
        sourceMode="microphoneOnly"
        checkingSourceReadiness={false}
        onSourceModeChange={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Change" }));
    await waitFor(() =>
      expect(mocks.dictationHelperCommand).toHaveBeenCalledWith({
        type: "start_shortcut_capture",
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
          },
        },
      }),
    });

    await waitFor(() =>
      expect(mocks.setDictationShortcut).toHaveBeenCalledWith({
        code: "Fn",
        label: "Fn",
        modifiers: {
          command: false,
          control: false,
          option: false,
          shift: false,
          function: true,
        },
      }),
    );

    await user.click(screen.getByRole("button", { name: "Toggle" }));
    await waitFor(() =>
      expect(mocks.setDictationActivationMode).toHaveBeenCalledWith("toggle"),
    );
    expect(
      await screen.findByText("Activation mode set to Toggle."),
    ).toBeInTheDocument();
  });

  it("shows permission status and opens matching privacy panes", async () => {
    const user = userEvent.setup();
    render(
      <AppSettings
        sourceMode="microphoneOnly"
        checkingSourceReadiness={false}
        onSourceModeChange={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(mocks.dictationHelperCommand).toHaveBeenCalledWith({
        type: "get_permission_status",
      }),
    );
    mocks.eventHandler?.({
      payload: JSON.stringify({
        type: "permission_status",
        payload: { microphone: "authorized", accessibility: "denied" },
      }),
    });

    expect(await screen.findByText("Allowed")).toBeInTheDocument();
    expect(screen.getByText("Needs permission")).toBeInTheDocument();

    const openButtons = screen.getAllByRole("button", { name: /Open/ });
    await user.click(openButtons[0]);
    await user.click(openButtons[1]);

    expect(mocks.openPrivacySettings).toHaveBeenNthCalledWith(1, "microphone");
    expect(mocks.openPrivacySettings).toHaveBeenNthCalledWith(
      2,
      "accessibility",
    );
  });

  it("loads Venice model options and saves selected models", async () => {
    const user = userEvent.setup();
    render(
      <AppSettings
        sourceMode="microphoneOnly"
        checkingSourceReadiness={false}
        onSourceModeChange={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(mocks.listVeniceModels).toHaveBeenCalledWith("transcription"),
    );
    await user.click(
      await screen.findByRole("button", {
        name: "Change transcription model",
      }),
    );
    expect((await screen.findAllByText("Private")).length).toBeGreaterThan(0);
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
        name: "Change note generation model",
      }),
    );
    expect((await screen.findAllByText("Uncensored")).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByText("Tools")).not.toBeInTheDocument();
    expect(screen.queryByText("Reasoning")).not.toBeInTheDocument();
    await user.click(
      await screen.findByRole("option", { name: /Venice Uncensored/ }),
    );
    expect(mocks.setVeniceModel).toHaveBeenCalledWith(
      "generation",
      "venice-uncensored",
    );
  });
});
