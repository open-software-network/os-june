import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppSettings } from "../components/settings/AppSettings";
import type { DictationSettingsDto } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  dictationSettings: vi.fn(),
  dictationHelperCommand: vi.fn(),
  openPrivacySettings: vi.fn(),
  setDictationMicrophone: vi.fn(),
  listen: vi.fn(),
  eventHandler: undefined as ((event: { payload: string }) => void) | undefined,
}));

vi.mock("../lib/tauri", () => ({
  dictationSettings: mocks.dictationSettings,
  dictationHelperCommand: mocks.dictationHelperCommand,
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
};

describe("AppSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventHandler = undefined;
    mocks.dictationSettings.mockResolvedValue({ settings: baseSettings });
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
});
