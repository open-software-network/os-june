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
  microphone: {},
  postProcessing: { enabled: false },
};

describe("AppSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventHandler = undefined;
    mocks.dictationSettings.mockResolvedValue({ settings: baseSettings });
    mocks.providerModelSettings.mockResolvedValue({
      settings: {
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
                id: "nvidia/parakeet-tdt-0.6b-v3",
                name: "Parakeet",
                modelType: "asr",
                description: "Speech-to-text model for transcribing audio.",
                privacy: "private",
                pricing: { input: { usd: 0.002 }, output: { usd: 0.006 } },
                contextTokens: 8192,
                traits: ["default"],
                capabilities: [],
              },
              {
                id: "transcribe-large",
                name: "Transcribe Large",
                modelType: "asr",
                description: "Large transcription model.",
                privacy: "anonymized",
                pricing: { input: { usd: 0.004 }, output: { usd: 0.008 } },
                contextTokens: 16384,
                traits: [],
                capabilities: [],
              },
            ]
          : [
              {
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
      transcriptionModel:
        mode === "transcription" ? modelId : "nvidia/parakeet-tdt-0.6b-v3",
      generationModel: mode === "generation" ? modelId : "zai-org-glm-5",
    }));
    mocks.dictationHelperCommand.mockResolvedValue(undefined);
    mocks.openPrivacySettings.mockResolvedValue(undefined);
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
    expect(
      screen.getAllByText("$0.0020 in / $0.0060 out").length,
    ).toBeGreaterThan(0);
    await user.click(
      await screen.findByRole("option", { name: /Transcribe Large/ }),
    );
    expect(mocks.setVeniceModel).toHaveBeenCalledWith(
      "transcription",
      "transcribe-large",
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
