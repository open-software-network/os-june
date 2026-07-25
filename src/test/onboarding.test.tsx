import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingFlow } from "../components/onboarding/OnboardingFlow";
import {
  applyOnboardingReplayFlag,
  isAgentRiskAcknowledged,
  isOnboardingComplete,
  markOnboardingComplete,
  ONBOARDING_COMPLETED_EVENT,
  onboardingArea,
  onboardingPersonality,
  onboardingResumeStep,
  resetOnboardingForReplay,
  setOnboardingResumeStep,
  subscribeToOnboardingComplete,
  type OnboardingArea,
} from "../lib/onboarding";
import { personalityPreviewMessage, personalityStylesForArea } from "../lib/onboarding-personality";
import { TELEMETRY_INFO_URL } from "../lib/p3a";
import type { AccountStatus, RecordingSourceReadinessDto } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  dictationSettings: vi.fn(),
  dictationHelperCommand: vi.fn(),
  checkRecordingSourceReadiness: vi.fn(),
  openPrivacySettings: vi.fn(),
  setDictationShortcut: vi.fn(),
  setP3aEnabled: vi.fn(),
  p3aRecord: vi.fn(),
  osAccountsLogin: vi.fn(),
  osAccountsCancelLogin: vi.fn(),
  setJunePersona: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  dictationCapabilities: vi.fn().mockResolvedValue({
    capabilities: {
      available: true,
      platform: "macos",
      shortcuts: true,
      paste: true,
      microphoneSelection: true,
      accessibilityPermission: true,
      systemAudio: true,
    },
  }),
  dictationSettings: mocks.dictationSettings,
  dictationHelperCommand: mocks.dictationHelperCommand,
  checkRecordingSourceReadiness: mocks.checkRecordingSourceReadiness,
  openPrivacySettings: mocks.openPrivacySettings,
  setDictationShortcut: mocks.setDictationShortcut,
  setP3aEnabled: mocks.setP3aEnabled,
  p3aRecord: mocks.p3aRecord,
  osAccountsLogin: mocks.osAccountsLogin,
  osAccountsCancelLogin: mocks.osAccountsCancelLogin,
  setJunePersona: mocks.setJunePersona,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

const account: AccountStatus = {
  signedIn: true,
  configured: true,
  user: { id: "u1", handle: "casey", displayName: "Casey Tester" },
  balance: { credits: 5000, usdMillis: 5000 },
  subscription: { subscribed: true, status: "trialing" },
};

const signedOutAccount: AccountStatus = {
  signedIn: false,
  configured: true,
};

type ListenHandler = (event: { payload: string }) => void;

function systemAudioReadiness(granted: boolean): RecordingSourceReadinessDto {
  return {
    sourceMode: "microphonePlusSystem",
    ready: granted,
    sources: [
      {
        source: "microphone",
        required: true,
        ready: true,
        permissionState: "granted",
        deviceAvailable: true,
        captureAvailable: true,
      },
      {
        source: "system",
        required: true,
        ready: granted,
        permissionState: granted ? "granted" : "denied",
        deviceAvailable: granted,
        captureAvailable: granted,
        recoveryAction: "openSystemAudioSettings",
      },
    ],
  };
}

function systemAudioCaptureUnavailableReadiness(): RecordingSourceReadinessDto {
  const readiness = systemAudioReadiness(false);
  const system = readiness.sources.find((source) => source.source === "system");
  if (system) {
    system.permissionState = "granted";
    system.deviceAvailable = true;
    system.captureAvailable = false;
    system.recoveryAction = "restartApp";
    system.message = "Failed to create audio format for system tap.";
  }
  return readiness;
}

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

const AREA_TITLES: Record<OnboardingArea, string> = {
  work: "Staying on top of work",
  personal: "Managing my personal life",
  thinking: "Thinking, writing, and reflecting",
  play: "Having fun and creating",
};

const AREA_PERSONALITY_STYLES: Record<OnboardingArea, string> = {
  work: "Clearheaded co-pilot",
  personal: "Easygoing companion",
  thinking: "Thoughtful partner",
  play: "Playful wildcard",
};

describe("OnboardingFlow", () => {
  let emitDictationEvent: ListenHandler | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    emitDictationEvent = undefined;
    mocks.listen.mockImplementation((eventName: string, handler: ListenHandler) => {
      if (eventName === "dictation-event") emitDictationEvent = handler;
      return Promise.resolve(vi.fn());
    });
    mocks.dictationHelperCommand.mockResolvedValue(undefined);
    mocks.checkRecordingSourceReadiness.mockResolvedValue(systemAudioReadiness(true));
    mocks.openPrivacySettings.mockResolvedValue(undefined);
    mocks.osAccountsCancelLogin.mockResolvedValue(undefined);
    mocks.setDictationShortcut.mockResolvedValue(undefined);
    mocks.setP3aEnabled.mockImplementation((enabled: boolean) =>
      Promise.resolve({
        settings: {
          enabled,
          consentVersion: 1,
          consentedAtWeek: enabled ? "2026-W28" : null,
        },
      }),
    );
    mocks.p3aRecord.mockResolvedValue(undefined);
    mocks.setJunePersona.mockResolvedValue({
      schemaVersion: 1,
      area: "work",
      voice: 10,
      detail: 40,
      initiative: 85,
      humor: 20,
    });
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

  function flowProps(overrides: Partial<Parameters<typeof OnboardingFlow>[0]> = {}) {
    return {
      account,
      onAccountChanged: vi.fn(),
      onComplete: vi.fn(),
      ...overrides,
    };
  }

  function grantPermissions() {
    emitDictationEvent?.({
      payload: JSON.stringify({
        type: "permission_status",
        payload: { microphone: "granted", accessibility: "granted" },
      }),
    });
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
      if (ownPlatform) Object.defineProperty(navigator, "platform", ownPlatform);
      else Reflect.deleteProperty(navigator, "platform");
      if (ownUserAgent) Object.defineProperty(navigator, "userAgent", ownUserAgent);
      else Reflect.deleteProperty(navigator, "userAgent");
    };
  }

  function stubMacNavigatorPlatform() {
    return stubNavigatorPlatform("MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)");
  }

  async function advanceToArea() {
    render(<OnboardingFlow {...flowProps()} />);
    await screen.findByRole("heading", { name: "Help improve June" });
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Where could I help most?" });
  }

  async function chooseArea(area: OnboardingArea) {
    await userEvent.click(screen.getByRole("button", { name: new RegExp(AREA_TITLES[area], "i") }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Choose my personality" });
  }

  it("introduces June as a private AI without using the Open Software name", async () => {
    render(<OnboardingFlow {...flowProps({ account: signedOutAccount })} />);

    await screen.findByRole("heading", { name: "Hi, I'm June. Your private AI." });
    expect(screen.getByText("Your private life stays on this Mac")).toBeInTheDocument();
    expect(screen.getByText("I learn and remember everything locally")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "verify everything yourself" })).toHaveAttribute(
      "href",
      "https://github.com/open-software-network/os-june",
    );
    expect(screen.getByText("I default to Private models")).toBeInTheDocument();
    expect(
      screen.getByText("Zero-retention models don't store your prompts or train on them."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue with June" })).toBeInTheDocument();
    expect(screen.queryByText(/OpenSoftware|Open Software/)).not.toBeInTheDocument();
  });

  it("signs the user in from the private-AI introduction", async () => {
    const onAccountChanged = vi.fn();
    mocks.osAccountsLogin.mockResolvedValue(account);
    const { rerender } = render(
      <OnboardingFlow {...flowProps({ account: signedOutAccount, onAccountChanged })} />,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Continue with June" }));
    await waitFor(() => expect(onAccountChanged).toHaveBeenCalledWith(account));
    rerender(<OnboardingFlow {...flowProps({ account, onAccountChanged })} />);
    await screen.findByRole("heading", { name: "Help improve June" });
  });

  it("keeps anonymous usage statistics off by default", async () => {
    render(<OnboardingFlow {...flowProps()} />);

    await screen.findByRole("heading", { name: "Help improve June" });
    expect(
      screen.getByRole("switch", { name: "Share anonymous usage statistics" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("link", { name: "Learn how it works" })).toHaveAttribute(
      "href",
      TELEMETRY_INFO_URL,
    );

    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(mocks.setP3aEnabled).toHaveBeenCalledWith(false);
    await screen.findByRole("heading", { name: "Where could I help most?" });
  });

  it("saves one broad help area instead of collecting a multi-select survey", async () => {
    await advanceToArea();
    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(continueButton).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: /Staying on top of work/i }));
    await userEvent.click(screen.getByRole("button", { name: /Managing my personal life/i }));
    await userEvent.click(continueButton);

    expect(onboardingArea()).toBe("personal");
    expect(mocks.p3aRecord).toHaveBeenCalledWith("onboarding.area.personal");
    await screen.findByRole("heading", { name: "Choose my personality" });
  });

  it.each(
    Object.keys(AREA_TITLES) as OnboardingArea[],
  )("sets the intended %s personality preset", async (area) => {
    await advanceToArea();
    await chooseArea(area);

    expect(
      screen.getByRole("button", { name: new RegExp(AREA_PERSONALITY_STYLES[area], "i") }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByRole("slider")).toHaveLength(4);
  });

  it("reshapes the character sheet and shows a new Home-style message", async () => {
    await advanceToArea();
    await chooseArea("work");

    const bubble = screen.getByLabelText("Example message from June");
    const messageCopy = () =>
      document.querySelector(".onboarding-personality-message-copy")?.textContent;
    const firstMessage = messageCopy();
    expect(firstMessage).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Calm collaborator/i }));
    expect(screen.getByLabelText("Example message from June")).toBe(bubble);
    expect(bubble).toHaveAttribute("data-streaming", "true");
    expect(await screen.findByRole("status")).toHaveTextContent("June is typing");
    await waitFor(() => expect(bubble).not.toHaveAttribute("data-streaming"));
    expect(messageCopy()).not.toBe(firstMessage);
    expect(screen.getByRole("button", { name: /Calm collaborator/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const calmMessage = messageCopy();
    fireEvent.keyDown(screen.getByRole("slider", { name: "Depth" }), { key: "End" });
    expect(bubble).toHaveAttribute("data-streaming", "true");
    await waitFor(() => expect(bubble).not.toHaveAttribute("data-streaming"));
    expect(messageCopy()).not.toBe(calmMessage);
    expect(screen.getByRole("button", { name: /Calm collaborator/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    const deepMessage = messageCopy();
    fireEvent.keyDown(screen.getByRole("slider", { name: "Initiative" }), { key: "Home" });
    await waitFor(() => expect(bubble).not.toHaveAttribute("data-streaming"));
    expect(messageCopy()).not.toBe(deepMessage);

    const quietMessage = messageCopy();
    fireEvent.keyDown(screen.getByRole("slider", { name: "Playfulness" }), { key: "End" });
    await waitFor(() => expect(bubble).not.toHaveAttribute("data-streaming"));
    expect(messageCopy()).not.toBe(quietMessage);
  });

  it("persists personality choices and carries the selected area into permissions", async () => {
    await advanceToArea();
    await chooseArea("personal");
    await userEvent.click(screen.getByRole("button", { name: /Playful sidekick/i }));
    fireEvent.keyDown(screen.getByRole("slider", { name: "Depth" }), { key: "Home" });
    expect(screen.queryByText(/85%|0%|80%|95%/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    await screen.findByRole("heading", { name: "A few things I need from your Mac" });
    expect(onboardingPersonality("personal")).toMatchObject({
      voice: 85,
      detail: 0,
      initiative: 80,
      humor: 95,
    });
    expect(mocks.setJunePersona).toHaveBeenCalledWith({
      area: "personal",
      voice: 85,
      detail: 0,
      initiative: 80,
      humor: 95,
    });
    expect(
      screen.getByText(
        "I need this for voice notes, reflections, and anything you'd rather say than type.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "You don't need this for journaling. I only use it when you ask me to capture a call.",
      ),
    ).toBeInTheDocument();
  });

  it.each([
    [
      "work",
      "I need this to hear the other people on calls, so your meeting notes include everyone.",
    ],
    [
      "personal",
      "You don't need this for journaling. I only use it when you ask me to capture a call.",
    ],
    [
      "thinking",
      "You don't need this for solo thinking. I only use it to capture a call on this Mac.",
    ],
    ["play", "You don't need this for solo play. I only use it to capture a call on this Mac."],
  ] as const)("adapts system-audio copy for the %s route", async (area, expectedCopy) => {
    localStorage.setItem("june.onboarding.area", area);
    setOnboardingResumeStep("permissions");
    render(<OnboardingFlow {...flowProps()} />);

    await screen.findByRole("heading", { name: "A few things I need from your Mac" });
    expect(screen.getByText(expectedCopy)).toBeInTheDocument();
  });

  it("completes after permissions instead of inserting a separate practice screen", async () => {
    const onComplete = vi.fn();
    const restoreNavigator = stubMacNavigatorPlatform();
    try {
      render(<OnboardingFlow {...flowProps({ onComplete })} />);
      await screen.findByRole("heading", { name: "Help improve June" });
      await userEvent.click(screen.getByRole("button", { name: "Continue" }));
      await screen.findByRole("heading", { name: "Where could I help most?" });
      await userEvent.click(screen.getByRole("button", { name: /Staying on top of work/i }));
      await userEvent.click(screen.getByRole("button", { name: "Continue" }));
      await screen.findByRole("heading", { name: "Choose my personality" });
      await userEvent.click(screen.getByRole("button", { name: "Continue" }));
      await screen.findByRole("heading", { name: "A few things I need from your Mac" });

      expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
      grantPermissions();
      await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
      await userEvent.click(screen.getByRole("button", { name: "Continue" }));

      await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
      expect(mocks.p3aRecord).toHaveBeenCalledWith("onboarding.completed");
      expect(screen.queryByRole("heading", { name: "Talk to June" })).not.toBeInTheDocument();
    } finally {
      restoreNavigator();
    }
  });

  it("keeps the existing fresh-install fn shortcut default", async () => {
    mocks.dictationSettings.mockResolvedValue({
      settings: {
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
        toggleShortcut: shortcut("fn fn"),
        microphone: {},
        style: "standard",
        language: undefined,
      },
    });

    render(<OnboardingFlow {...flowProps()} />);

    await waitFor(() =>
      expect(mocks.setDictationShortcut).toHaveBeenCalledWith(
        "push_to_talk",
        expect.objectContaining({ code: "Fn" }),
      ),
    );
  });

  it("does not overwrite a customized dictation shortcut", async () => {
    mocks.dictationSettings.mockResolvedValue({
      settings: {
        pushToTalkShortcut: {
          keyCode: 0x60,
          code: "F5",
          label: "F5",
          pressCount: 1,
          modifiers: {
            command: false,
            control: false,
            option: false,
            shift: false,
            function: false,
          },
        },
        toggleShortcut: shortcut("fn fn"),
        microphone: {},
        style: "standard",
        language: undefined,
      },
    });

    render(<OnboardingFlow {...flowProps()} />);
    await screen.findByRole("heading", { name: "Help improve June" });
    await waitFor(() => expect(mocks.dictationSettings).toHaveBeenCalledOnce());
    expect(mocks.setDictationShortcut).not.toHaveBeenCalled();
  });

  it("requests microphone and system-audio access on the permission step", async () => {
    localStorage.setItem("june.onboarding.area", "work");
    setOnboardingResumeStep("permissions");
    render(<OnboardingFlow {...flowProps()} />);

    await screen.findByRole("heading", { name: "A few things I need from your Mac" });
    await waitFor(() =>
      expect(mocks.dictationHelperCommand).toHaveBeenCalledWith({
        type: "request_microphone_permission",
      }),
    );
    await waitFor(() =>
      expect(mocks.checkRecordingSourceReadiness).toHaveBeenCalledWith("microphonePlusSystem"),
    );
  });

  it("keeps continue locked and opens System Settings when system audio is denied", async () => {
    const restoreNavigator = stubMacNavigatorPlatform();
    mocks.checkRecordingSourceReadiness.mockResolvedValue(systemAudioReadiness(false));
    localStorage.setItem("june.onboarding.area", "work");
    setOnboardingResumeStep("permissions");
    try {
      render(<OnboardingFlow {...flowProps()} />);
      grantPermissions();
      await screen.findByText(
        "Turned off in System Settings. Flip the toggle and June will notice.",
      );
      expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();

      await userEvent.click(screen.getByRole("button", { name: "Allow system audio access" }));
      expect(mocks.openPrivacySettings).toHaveBeenCalledWith("systemAudio");
    } finally {
      restoreNavigator();
    }
  });

  it("does not block continue when system audio is unsupported", async () => {
    const readiness = systemAudioReadiness(false);
    const system = readiness.sources.find((source) => source.source === "system");
    if (system) system.permissionState = "unsupported";
    mocks.checkRecordingSourceReadiness.mockResolvedValue(readiness);
    localStorage.setItem("june.onboarding.area", "work");
    setOnboardingResumeStep("permissions");
    render(<OnboardingFlow {...flowProps()} />);

    grantPermissions();
    await screen.findByText("Needs macOS 14.2 or later.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
  });

  it("explains when system audio needs a restart without blocking continue", async () => {
    mocks.checkRecordingSourceReadiness.mockResolvedValue(systemAudioCaptureUnavailableReadiness());
    localStorage.setItem("june.onboarding.area", "work");
    setOnboardingResumeStep("permissions");
    render(<OnboardingFlow {...flowProps()} />);

    grantPermissions();
    await screen.findByText("Allowed. Restart June to finish turning it on.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
    expect(mocks.openPrivacySettings).not.toHaveBeenCalled();
  });

  it("only requires microphone access on Windows", async () => {
    const restoreNavigator = stubNavigatorPlatform(
      "Win32",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    );
    localStorage.setItem("june.onboarding.area", "work");
    setOnboardingResumeStep("permissions");
    try {
      render(<OnboardingFlow {...flowProps()} />);
      await screen.findByRole("heading", { name: "A few things I need" });
      expect(screen.queryByText("Accessibility")).not.toBeInTheDocument();
      expect(screen.queryByText("System audio")).not.toBeInTheDocument();

      emitDictationEvent?.({
        payload: JSON.stringify({
          type: "permission_status",
          payload: { microphone: "granted", accessibility: "missing" },
        }),
      });
      await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
    } finally {
      restoreNavigator();
    }
  });

  it("shows no-device guidance on Windows without opening privacy settings", async () => {
    const restoreNavigator = stubNavigatorPlatform(
      "Win32",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    );
    localStorage.setItem("june.onboarding.area", "work");
    setOnboardingResumeStep("permissions");
    try {
      render(<OnboardingFlow {...flowProps()} />);
      emitDictationEvent?.({
        payload: JSON.stringify({
          type: "permission_status",
          payload: {
            microphone: "unavailable",
            microphoneDeviceAvailable: false,
            microphoneReason: "no_input_device",
            accessibility: "granted",
          },
        }),
      });

      expect(
        await screen.findByText(
          "No microphone found. Connect one, choose it in Windows sound settings, then try again.",
        ),
      ).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Allow microphone access" }));
      expect(mocks.openPrivacySettings).not.toHaveBeenCalled();
      expect(mocks.dictationHelperCommand).toHaveBeenCalledWith({
        type: "get_permission_status",
      });
    } finally {
      restoreNavigator();
    }
  });

  it("resumes at the saved personality step with the saved area", async () => {
    localStorage.setItem("june.onboarding.area", "thinking");
    setOnboardingResumeStep("personality");
    render(<OnboardingFlow {...flowProps()} />);

    await screen.findByRole("heading", { name: "Choose my personality" });
    expect(screen.getByRole("button", { name: /Thoughtful partner/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(document.querySelector(".onboarding-personality-message-copy")).toHaveTextContent(
      "I found the thought underneath your brain-dump",
    );
  });

  it("resets only onboarding progress when replaying the wizard", () => {
    markOnboardingComplete();
    setOnboardingResumeStep("area");
    localStorage.setItem("june.agent.riskAcknowledged", "true");

    resetOnboardingForReplay();

    expect(isOnboardingComplete()).toBe(false);
    expect(onboardingResumeStep()).toBeNull();
    expect(isAgentRiskAcknowledged()).toBe(true);
  });

  it("applies the replay flag only in development", () => {
    markOnboardingComplete();
    setOnboardingResumeStep("area");

    applyOnboardingReplayFlag({ DEV: false, VITE_JUNE_REPLAY_ONBOARDING: "1" });
    expect(isOnboardingComplete()).toBe(true);

    applyOnboardingReplayFlag({ DEV: true, VITE_JUNE_REPLAY_ONBOARDING: "1" });
    expect(isOnboardingComplete()).toBe(false);
    expect(onboardingResumeStep()).toBeNull();
  });
});

describe("onboarding personality contract", () => {
  const areas: readonly OnboardingArea[] = ["work", "personal", "thinking", "play"];
  const axes = ["voice", "detail", "initiative", "humor"] as const;

  it.each(areas)("uses %s-specific names and descriptions for all four starting styles", (area) => {
    const styles = personalityStylesForArea(area);
    expect(styles).toHaveLength(4);
    expect(new Set(styles.map((style) => style.name)).size).toBe(4);
    expect(styles.every((style) => style.description.length > 12)).toBe(true);
  });

  it.each(areas)("changes the %s preview at every adjacent value on every axis", (area) => {
    const baseline = { voice: 50, detail: 50, initiative: 50, humor: 50 };
    for (const axis of axes) {
      for (let value = 0; value < 100; value += 1) {
        const current = personalityPreviewMessage(area, { ...baseline, [axis]: value });
        const next = personalityPreviewMessage(area, { ...baseline, [axis]: value + 1 });
        expect(next, `${area}.${axis} ${value}→${value + 1}`).not.toBe(current);
      }
    }
  });
});

describe("subscribeToOnboardingComplete", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("fires the callback at most once even when both signals arrive", () => {
    const callback = vi.fn();
    const unsubscribe = subscribeToOnboardingComplete(callback);

    localStorage.setItem("june.onboarding.completedVersion", "999");
    window.dispatchEvent(new StorageEvent("storage", { key: "june.onboarding.completedVersion" }));
    window.dispatchEvent(new Event(ONBOARDING_COMPLETED_EVENT));

    expect(callback).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("never fires after unsubscribe", () => {
    const callback = vi.fn();
    const unsubscribe = subscribeToOnboardingComplete(callback);
    unsubscribe();

    localStorage.setItem("june.onboarding.completedVersion", "999");
    window.dispatchEvent(new StorageEvent("storage", { key: "june.onboarding.completedVersion" }));
    window.dispatchEvent(new Event(ONBOARDING_COMPLETED_EVENT));

    expect(callback).not.toHaveBeenCalled();
  });
});
