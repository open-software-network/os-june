import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingFlow } from "../components/onboarding/OnboardingFlow";
import {
  isAgentRiskAcknowledged,
  isOnboardingComplete,
} from "../lib/onboarding";
import type { AccountStatus } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  dictationSettings: vi.fn(),
  dictationHelperCommand: vi.fn(),
  openPrivacySettings: vi.fn(),
  setDictationLanguage: vi.fn(),
  setDictationShortcut: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  dictationSettings: mocks.dictationSettings,
  dictationHelperCommand: mocks.dictationHelperCommand,
  openPrivacySettings: mocks.openPrivacySettings,
  setDictationLanguage: mocks.setDictationLanguage,
  setDictationShortcut: mocks.setDictationShortcut,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

const account: AccountStatus = {
  signedIn: true,
  configured: true,
  user: { id: "u1", handle: "gaut", displayName: "Gaut Tester" },
};

type ListenHandler = (event: { payload: string }) => void;

function shortcut(label: string) {
  return {
    code: "Fn",
    label,
    pressCount: 1 as const,
    modifiers: {
      command: false,
      control: false,
      option: false,
      shift: false,
      function: true,
    },
  };
}

describe("OnboardingFlow", () => {
  let emitDictationEvent: ListenHandler | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    emitDictationEvent = undefined;
    mocks.listen.mockImplementation(
      (eventName: string, handler: ListenHandler) => {
        if (eventName === "dictation-event") emitDictationEvent = handler;
        return Promise.resolve(vi.fn());
      },
    );
    mocks.dictationHelperCommand.mockResolvedValue(undefined);
    mocks.openPrivacySettings.mockResolvedValue(undefined);
    mocks.setDictationLanguage.mockResolvedValue(undefined);
    mocks.setDictationShortcut.mockResolvedValue(undefined);
    mocks.dictationSettings.mockResolvedValue({
      settings: {
        pushToTalkShortcut: shortcut("fn"),
        toggleShortcut: shortcut("fn fn"),
        microphone: {},
        style: "standard",
        language: undefined,
      },
    });
  });

  async function renderFlow(onComplete = vi.fn()) {
    render(<OnboardingFlow account={account} onComplete={onComplete} />);
    await screen.findByRole("heading", { name: /Welcome, Gaut!/ });
    return onComplete;
  }

  function grantPermissions() {
    emitDictationEvent?.({
      payload: JSON.stringify({
        type: "permission_status",
        payload: { microphone: "granted", accessibility: "granted" },
      }),
    });
  }

  async function walkToHonesty(user: ReturnType<typeof userEvent.setup>) {
    await user.click(
      screen.getByRole("button", { name: "Let's get you set up" }),
    );
    // Privacy education + data practices.
    await screen.findByRole("heading", {
      name: "Private by architecture, not by promise",
    });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", {
      name: "June doesn't collect your data",
    });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    // Permissions: continue stays locked until the helper reports both granted.
    await screen.findByRole("heading", {
      name: "Give June permissions on your Mac",
    });
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    grantPermissions();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    // Set up: onboarding applies the fn dictation key.
    await screen.findByRole("heading", { name: "Set up dictation" });
    await waitFor(() =>
      expect(mocks.setDictationShortcut).toHaveBeenCalledWith(
        "push_to_talk",
        expect.objectContaining({ code: "Fn" }),
      ),
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    // Dictation practice: typing into the field stands in for dictation.
    const input = await screen.findByPlaceholderText(/Hold Fn/i);
    await user.type(input, "hello there");
    await screen.findByText(/Good work!/);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    // Meeting notes, agent intro.
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", {
      name: "Before you meet the agent, three honest things",
    });
  }

  it("walks the full flow and persists what the user chose", async () => {
    const user = userEvent.setup();
    const onComplete = await renderFlow();

    await walkToHonesty(user);

    // The honesty screen gates on the acknowledgment checkbox.
    const meetAgent = screen.getByRole("button", { name: "Meet the agent" });
    expect(meetAgent).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    expect(meetAgent).toBeEnabled();
    await user.click(meetAgent);

    await user.click(
      await screen.findByRole("button", { name: "Start using June" }),
    );

    expect(onComplete).toHaveBeenCalledOnce();
    expect(isAgentRiskAcknowledged()).toBe(true);
    // Completion is the caller's job (App marks it), not the flow's.
    expect(isOnboardingComplete()).toBe(false);
  });

  it("requests the mic permission when the mic screen shows", async () => {
    const user = userEvent.setup();
    await renderFlow();
    await user.click(
      screen.getByRole("button", { name: "Let's get you set up" }),
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", {
      name: "Give June permissions on your Mac",
    });
    await waitFor(() =>
      expect(mocks.dictationHelperCommand).toHaveBeenCalledWith({
        type: "request_microphone_permission",
      }),
    );
  });
});
