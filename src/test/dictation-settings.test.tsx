import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DictationSettings } from "../components/dictation/DictationSettings";
import type { DictationSettingsDto } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  dictationSettings: vi.fn(),
  dictationHotkeyStatus: vi.fn(),
  dictationHelperCommand: vi.fn(),
  setDictationShortcut: vi.fn(),
  setDictationActivationMode: vi.fn(),
  setDictationMicrophone: vi.fn(),
  listen: vi.fn(),
  eventHandler: undefined as ((event: { payload: string }) => void) | undefined,
}));

vi.mock("../lib/tauri", () => ({
  dictationSettings: mocks.dictationSettings,
  dictationHotkeyStatus: mocks.dictationHotkeyStatus,
  dictationHelperCommand: mocks.dictationHelperCommand,
  setDictationShortcut: mocks.setDictationShortcut,
  setDictationActivationMode: mocks.setDictationActivationMode,
  setDictationMicrophone: mocks.setDictationMicrophone,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

const baseSettings: DictationSettingsDto = {
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
  activationMode: "push_to_talk",
  microphone: {},
};

describe("DictationSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventHandler = undefined;
    mocks.dictationSettings.mockResolvedValue({ settings: baseSettings });
    mocks.dictationHotkeyStatus.mockResolvedValue({
      type: "hotkey_trigger_ready",
      payload: { shortcut: "Fn" },
    });
    mocks.dictationHelperCommand.mockResolvedValue(undefined);
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

  it("renders native shortcut and selected microphone settings", async () => {
    mocks.dictationSettings.mockResolvedValue({
      settings: {
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
        },
        activationMode: "push_to_talk",
        microphone: { id: "airpods", name: "AirPods Pro" },
      },
    });

    render(<DictationSettings />);

    expect(
      await screen.findByLabelText("Shortcut Ctrl+Opt+Space"),
    ).toBeInTheDocument();
    expect(screen.getByText("AirPods Pro")).toBeInTheDocument();
    expect(screen.queryByText("Preset")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Dictation shortcut preset"),
    ).not.toBeInTheDocument();
  });

  it("shows native shortcut capture errors", async () => {
    const user = userEvent.setup();
    render(<DictationSettings />);

    await user.click(await screen.findByRole("button", { name: "Change" }));
    await waitFor(() =>
      expect(mocks.dictationHelperCommand).toHaveBeenCalledWith({
        type: "start_shortcut_capture",
      }),
    );

    mocks.eventHandler?.({
      payload: JSON.stringify({
        type: "shortcut_capture_error",
        payload: {
          message: "Shortcut must include Cmd, Ctrl, Opt, Shift, or Fn.",
        },
      }),
    });

    expect(
      await screen.findAllByText(
        "Shortcut must include Cmd, Ctrl, Opt, Shift, or Fn.",
      ),
    ).toHaveLength(2);
    expect(mocks.setDictationShortcut).not.toHaveBeenCalled();
  });

  it("updates shortcut and microphone through native commands", async () => {
    const user = userEvent.setup();
    render(<DictationSettings />);

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
            code: "KeyT",
            label: "Ctrl+T",
            modifiers: {
              command: false,
              control: true,
              option: false,
              shift: false,
              function: false,
            },
          },
        },
      }),
    });

    await waitFor(() =>
      expect(mocks.setDictationShortcut).toHaveBeenCalledWith({
        code: "KeyT",
        label: "Ctrl+T",
        modifiers: {
          command: false,
          control: true,
          option: false,
          shift: false,
          function: false,
        },
      }),
    );

    await waitFor(() => expect(mocks.listen).toHaveBeenCalled());
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
  });

  it("records bare Fn from native shortcut capture", async () => {
    const user = userEvent.setup();
    mocks.dictationSettings.mockResolvedValue({
      settings: {
        ...baseSettings,
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
      },
    });

    render(<DictationSettings />);

    expect(screen.queryByText("Fn / Globe")).not.toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "Change" }));
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
  });

  it("updates activation mode separately from the shortcut", async () => {
    const user = userEvent.setup();
    render(<DictationSettings />);

    expect(
      await screen.findByRole("button", { name: "Push-to-talk" }),
    ).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "Toggle" }));

    await waitFor(() =>
      expect(mocks.setDictationActivationMode).toHaveBeenCalledWith("toggle"),
    );
    expect(mocks.setDictationShortcut).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Activation mode set to Toggle."),
    ).toBeInTheDocument();
  });

  it("shows native Fn monitor errors", async () => {
    render(<DictationSettings />);

    await waitFor(() => expect(mocks.listen).toHaveBeenCalled());
    mocks.eventHandler?.({
      payload: JSON.stringify({
        type: "fn_monitor_unavailable",
        payload: { message: "Could not monitor Fn/Globe key events." },
      }),
    });

    expect(
      await screen.findByText("Could not monitor Fn/Globe key events."),
    ).toBeInTheDocument();
  });
});
