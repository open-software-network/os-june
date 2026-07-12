import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let statusListener: ((event: { payload: unknown }) => void) | undefined;
  return {
    cancel: vi.fn().mockResolvedValue(undefined),
    clearReference: vi.fn(),
    emitStatus: (status: unknown) => statusListener?.({ payload: status }),
    install: vi.fn(),
    listen: vi.fn().mockImplementation((_event, listener) => {
      statusListener = listener;
      return Promise.resolve(() => {});
    }),
    open: vi.fn(),
    play: vi.fn(),
    saveSettings: vi.fn(),
    setReference: vi.fn(),
    settings: vi.fn(),
    status: vi.fn(),
    synthesize: vi.fn(),
    warm: vi.fn(),
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));

vi.mock("../lib/tauri", () => ({
  VOICE_PLAYBACK_STATUS_EVENT: "june://voice-playback-status",
  clearVoicePlaybackReference: mocks.clearReference,
  saveVoicePlaybackSettings: mocks.saveSettings,
  setVoicePlaybackReference: mocks.setReference,
  voicePlaybackCancel: mocks.cancel,
  voicePlaybackInstall: mocks.install,
  voicePlaybackPlay: mocks.play,
  voicePlaybackSettings: mocks.settings,
  voicePlaybackStatus: mocks.status,
  voicePlaybackSynthesize: mocks.synthesize,
  voicePlaybackWarm: mocks.warm,
}));

import { VoicePlaybackSection } from "../components/settings/VoicePlaybackSection";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.mockResolvedValue({
    playbackMode: "click",
    modelUseAcknowledged: false,
    referenceClip: {
      fileName: "current.wav",
      durationMs: 4500,
      transcript: "Current voice sample",
    },
  });
  mocks.status.mockResolvedValue({ state: "notInstalled" });
  mocks.saveSettings.mockResolvedValue({
    playbackMode: "click",
    modelUseAcknowledged: true,
    referenceClip: {
      fileName: "current.wav",
      durationMs: 4500,
      transcript: "Current voice sample",
    },
  });
});

describe("VoicePlaybackSection", () => {
  it("requires acknowledgement and shows setup failures", async () => {
    const user = userEvent.setup();
    mocks.install.mockRejectedValue(new Error("Model download failed"));
    render(<VoicePlaybackSection />);

    const setup = await screen.findByRole("button", { name: "Set up" });
    expect(setup).toBeDisabled();

    await user.click(
      screen.getByRole("checkbox", { name: /I will use the OmniVoice model only/i }),
    );
    await user.click(setup);

    expect(await screen.findByRole("alert")).toHaveTextContent("Model download failed");
  });

  it("clears a staged transcript when the selected clip changes", async () => {
    const user = userEvent.setup();
    mocks.open.mockResolvedValueOnce("/tmp/first.wav").mockResolvedValueOnce("/tmp/second.wav");
    render(<VoicePlaybackSection />);

    await user.click(await screen.findByRole("button", { name: "Change clip" }));
    const transcript = screen.getByRole("textbox", { name: "Reference transcript" });
    await user.type(transcript, "First transcript");
    expect(transcript).toHaveValue("First transcript");

    await user.click(screen.getByRole("button", { name: "Change clip" }));
    await waitFor(() => expect(transcript).toHaveValue(""));
    expect(screen.getByText(/second\.wav/)).toBeInTheDocument();
  });

  it("keeps reference and playback controls inert during setup", async () => {
    const user = userEvent.setup();
    mocks.open.mockResolvedValue("/tmp/reference.wav");
    render(<VoicePlaybackSection />);

    await user.click(await screen.findByRole("button", { name: "Change clip" }));
    await user.type(screen.getByRole("textbox", { name: "Reference transcript" }), "Hello");
    act(() => mocks.emitStatus({ state: "installing", stage: "Downloading", progress: 42 }));

    expect(
      screen.getByRole("switch", { name: "Read replies aloud as they stream" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Change clip" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Use June's voice" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save voice" })).toBeDisabled();
  });
});
