import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DictationHistoryView } from "../components/dictation/DictationHistoryView";

const mocks = vi.hoisted(() => ({
  listDictationHistory: vi.fn(),
  deleteDictationHistoryItem: vi.fn(),
  dictationSettings: vi.fn(),
  dictationCapabilities: vi.fn(),
  listDictionaryEntries: vi.fn(),
  listen: vi.fn(),
  writeText: vi.fn(),
}));

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

vi.mock("../lib/tauri", () => ({
  listDictationHistory: mocks.listDictationHistory,
  deleteDictationHistoryItem: mocks.deleteDictationHistoryItem,
  dictationSettings: mocks.dictationSettings,
  dictationCapabilities: mocks.dictationCapabilities,
  listDictionaryEntries: mocks.listDictionaryEntries,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

describe("DictationHistoryView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.listen.mockResolvedValue(vi.fn());
    mocks.writeText.mockResolvedValue(undefined);
    mocks.deleteDictationHistoryItem.mockResolvedValue(undefined);
    mocks.listDictionaryEntries.mockResolvedValue([]);
    mocks.dictationCapabilities.mockResolvedValue({
      capabilities: {
        available: true,
        platform: "macos",
        shortcuts: true,
        paste: true,
        microphoneSelection: true,
        accessibilityPermission: true,
        systemAudio: true,
      },
    });
    mocks.dictationSettings.mockResolvedValue({
      settings: {
        pushToTalkShortcut: {
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
      },
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: mocks.writeText },
    });
    mocks.listDictationHistory.mockResolvedValue({
      retentionDays: 7,
      items: [
        {
          id: "dictation-1",
          text: "Send the follow up.",
          language: "en",
          provider: "openai",
          createdAt: new Date().toISOString(),
        },
      ],
    });
  });

  it("renders recent dictations and copies with trailing space", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: mocks.writeText },
    });
    render(<DictationHistoryView />);

    await waitFor(() => expect(screen.getByText("Send the follow up.")).toBeInTheDocument());
    expect(screen.getByText("Push to talk")).toBeInTheDocument();
    expect(screen.getByText("Hands-free")).toBeInTheDocument();
    expect(screen.getByLabelText("Shortcut Ctrl+Opt+T")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith("Send the follow up. "));
  });

  it("advertises shortcut dictation on Windows", async () => {
    const restoreNavigator = stubNavigatorPlatform(
      "Win32",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    );
    try {
      mocks.dictationCapabilities.mockResolvedValue({
        capabilities: {
          available: true,
          platform: "windows",
          shortcuts: true,
          paste: true,
          microphoneSelection: true,
          accessibilityPermission: false,
          systemAudio: false,
        },
      });
      mocks.dictationSettings.mockResolvedValue({
        settings: {
          pushToTalkShortcut: {
            code: "KeyD",
            label: "Ctrl+Alt+D",
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
            code: "KeyT",
            label: "Ctrl+Alt+T",
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
        },
      });
      mocks.listDictationHistory.mockResolvedValue({
        retentionDays: 7,
        items: [],
      });

      render(<DictationHistoryView />);

      expect(await screen.findByText("Start dictating anywhere")).toBeInTheDocument();
      expect(
        screen.getByText(
          "Place your cursor in any app, hold the shortcut, and speak. Your words are transcribed and pasted right where you're typing.",
        ),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Shortcut Ctrl+Alt+D")).toBeInTheDocument();
      expect(screen.getByLabelText("Shortcut Ctrl+Alt+T")).toBeInTheDocument();
    } finally {
      restoreNavigator();
    }
  });

  function manyItems(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      id: `dictation-${i}`,
      text: `Transcript ${i}`,
      language: "en",
      provider: "openai",
      createdAt: new Date().toISOString(),
    }));
  }

  it("hides the 'Get more' card until dictation is adopted", async () => {
    // Only one recent dictation — below the adoption threshold.
    render(<DictationHistoryView />);
    await waitFor(() => expect(screen.getByText("Send the follow up.")).toBeInTheDocument());
    expect(screen.queryByText("Get more from dictation")).not.toBeInTheDocument();
  });

  it("surfaces only the unconfigured features once adopted", async () => {
    mocks.listDictationHistory.mockResolvedValue({
      retentionDays: 7,
      items: manyItems(12),
    });
    // Style is configured, dictionary is not → only dictionary should show.
    mocks.dictationSettings.mockResolvedValue({
      settings: {
        pushToTalkShortcut: {
          code: "KeyD",
          label: "Ctrl+Opt+D",
          pressCount: 1,
          modifiers: {},
        },
        toggleShortcut: {
          code: "KeyT",
          label: "Ctrl+Opt+T",
          pressCount: 1,
          modifiers: {},
        },
        microphone: {},
        style: "formal",
      },
    });
    mocks.listDictionaryEntries.mockResolvedValue([]);

    render(<DictationHistoryView />);
    await waitFor(() => expect(screen.getByText("Get more from dictation")).toBeInTheDocument());
    expect(screen.getByText("Personal dictionary")).toBeInTheDocument();
    expect(screen.queryByText("Writing style")).not.toBeInTheDocument();
  });

  it("never shows the card once both features are configured", async () => {
    mocks.listDictationHistory.mockResolvedValue({
      retentionDays: 7,
      items: manyItems(12),
    });
    mocks.dictationSettings.mockResolvedValue({
      settings: {
        pushToTalkShortcut: {
          code: "KeyD",
          label: "Ctrl+Opt+D",
          pressCount: 1,
          modifiers: {},
        },
        toggleShortcut: {
          code: "KeyT",
          label: "Ctrl+Opt+T",
          pressCount: 1,
          modifiers: {},
        },
        microphone: {},
        style: "casualLowercase",
      },
    });
    mocks.listDictionaryEntries.mockResolvedValue([{ id: "e1", phrase: "Bismarck" }]);

    render(<DictationHistoryView />);
    await waitFor(() => expect(screen.getByText("Transcript 0")).toBeInTheDocument());
    expect(screen.queryByText("Get more from dictation")).not.toBeInTheDocument();
  });

  it("deletes a transcription after confirmation", async () => {
    const user = userEvent.setup();
    render(<DictationHistoryView />);

    await waitFor(() => expect(screen.getByText("Send the follow up.")).toBeInTheDocument());

    // Row trash icon opens the confirmation dialog rather than deleting.
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Delete this transcription?")).toBeInTheDocument();
    expect(mocks.deleteDictationHistoryItem).not.toHaveBeenCalled();

    // Confirm: the dialog's destructive button is the last "Delete".
    const deleteButtons = screen.getAllByRole("button", { name: "Delete" });
    await user.click(deleteButtons[deleteButtons.length - 1]);

    await waitFor(() =>
      expect(mocks.deleteDictationHistoryItem).toHaveBeenCalledWith("dictation-1"),
    );
    expect(screen.queryByText("Send the follow up.")).not.toBeInTheDocument();
  });
});
