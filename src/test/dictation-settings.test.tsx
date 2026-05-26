import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DictationSettings } from "../components/dictation/DictationSettings";
import type { DictationSettingsDto } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  dictationSettings: vi.fn(),
  dictationHotkeyStatus: vi.fn(),
  setDictationShortcut: vi.fn(),
  listen: vi.fn(),
  eventHandler: undefined as ((event: { payload: string }) => void) | undefined,
}));

vi.mock("../lib/tauri", () => ({
  dictationSettings: mocks.dictationSettings,
  dictationHotkeyStatus: mocks.dictationHotkeyStatus,
  setDictationShortcut: mocks.setDictationShortcut,
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

describe("DictationSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eventHandler = undefined;
    mocks.dictationSettings.mockResolvedValue({ settings: baseSettings });
    mocks.dictationHotkeyStatus.mockResolvedValue({
      type: "hotkey_trigger_ready",
      payload: { shortcut: "Fn+Space" },
    });
    mocks.setDictationShortcut.mockImplementation(async (shortcut) => ({
      ...baseSettings,
      shortcut,
    }));
    mocks.listen.mockImplementation((_event, handler) => {
      mocks.eventHandler = handler;
      return Promise.resolve(vi.fn());
    });
  });

  it("renders native shortcut settings", async () => {
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
        microphone: {},
      },
    });

    render(<DictationSettings />);

    expect(
      await screen.findByLabelText("Shortcut Ctrl+Opt+Space"),
    ).toBeInTheDocument();
  });

  it("rejects modifier-only and no-modifier shortcut captures", async () => {
    const user = userEvent.setup();
    render(<DictationSettings />);

    await user.click(await screen.findByRole("button", { name: "Change" }));
    fireEvent.keyDown(window, {
      code: "ShiftLeft",
      key: "Shift",
      shiftKey: true,
    });
    expect(
      await screen.findAllByText(
        "Press one non-modifier key with your shortcut.",
      ),
    ).toHaveLength(2);

    fireEvent.keyDown(window, { code: "KeyT", key: "t" });
    expect(
      await screen.findAllByText(
        "Shortcut must include Cmd, Ctrl, Opt, or Shift.",
      ),
    ).toHaveLength(2);
    expect(mocks.setDictationShortcut).not.toHaveBeenCalled();
  });

  it("updates shortcut through native command", async () => {
    const user = userEvent.setup();
    render(<DictationSettings />);

    await user.click(await screen.findByRole("button", { name: "Change" }));
    fireEvent.keyDown(window, { code: "KeyT", key: "t", ctrlKey: true });

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
  });
});
