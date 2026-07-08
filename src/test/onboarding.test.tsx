import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingFlow } from "../components/onboarding/OnboardingFlow";
import {
  applyOnboardingReplayFlag,
  isAgentRiskAcknowledged,
  isOnboardingComplete,
  markOnboardingComplete,
  ONBOARDING_COMPLETED_EVENT,
  onboardingCustomUseCase,
  onboardingUseCases,
  onboardingResumeStep,
  resetOnboardingForReplay,
  setOnboardingResumeStep,
  subscribeToOnboardingComplete,
} from "../lib/onboarding";
import { TELEMETRY_INFO_URL } from "../lib/p3a";
import type { AccountStatus, RecordingSourceReadinessDto } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  dictationSettings: vi.fn(),
  dictationHelperCommand: vi.fn(),
  checkRecordingSourceReadiness: vi.fn(),
  openPrivacySettings: vi.fn(),
  setDictationLanguage: vi.fn(),
  setDictationShortcut: vi.fn(),
  setP3aEnabled: vi.fn(),
  p3aRecord: vi.fn(),
  osAccountsLogin: vi.fn(),
  juneOpenCommunityPage: vi.fn(),
  juneOpenVerifyPage: vi.fn(),
  osAccountsCancelLogin: vi.fn(),
  osAccountsOpenPortal: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  dictationSettings: mocks.dictationSettings,
  dictationHelperCommand: mocks.dictationHelperCommand,
  checkRecordingSourceReadiness: mocks.checkRecordingSourceReadiness,
  openPrivacySettings: mocks.openPrivacySettings,
  setDictationLanguage: mocks.setDictationLanguage,
  setDictationShortcut: mocks.setDictationShortcut,
  setP3aEnabled: mocks.setP3aEnabled,
  p3aRecord: mocks.p3aRecord,
  osAccountsLogin: mocks.osAccountsLogin,
  juneOpenCommunityPage: mocks.juneOpenCommunityPage,
  juneOpenVerifyPage: mocks.juneOpenVerifyPage,
  osAccountsCancelLogin: mocks.osAccountsCancelLogin,
  osAccountsOpenPortal: mocks.osAccountsOpenPortal,
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

const unsubscribedAccount: AccountStatus = {
  ...account,
  subscription: { subscribed: false },
};

const signedOutAccount: AccountStatus = {
  signedIn: false,
  configured: true,
};

type ListenHandler = (event: { payload: string }) => void;

// What check_recording_source_readiness returns after the capture-helper
// probe: a passing probe reports the system source as granted; a denial
// flips both ready and permissionState.
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
    mocks.juneOpenCommunityPage.mockResolvedValue(undefined);
    mocks.osAccountsOpenPortal.mockResolvedValue(undefined);
    mocks.setDictationLanguage.mockResolvedValue(undefined);
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

  async function renderFlow(onComplete = vi.fn()) {
    render(<OnboardingFlow {...flowProps({ onComplete })} />);
    await screen.findByRole("heading", { name: "Help improve June" });
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", {
      name: "What are you interested in using June for?",
    });
    await userEvent.click(screen.getByRole("button", { name: "Work" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Let June listen and type" });
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

  function stubMacNavigatorPlatform() {
    return stubNavigatorPlatform("MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)");
  }

  it("walks the full flow for a subscribed user", async () => {
    const user = userEvent.setup();
    const onComplete = await renderFlow();

    // Permissions: continue stays locked until the helper reports both granted.
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    grantPermissions();
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Continue" }));
    // The next step is hands-on practice. Onboarding no longer opens billing
    // or asks for a card before the user tries the product.
    const input = await screen.findByPlaceholderText(/Tell June what to do/i);
    await user.type(input, "hello there");
    await screen.findByRole("status", { name: "Dictation is working" });
    await user.click(screen.getByRole("button", { name: "Start using June" }));

    expect(onComplete).toHaveBeenCalledOnce();
    expect(mocks.p3aRecord).toHaveBeenCalledWith("onboarding.completed");
    expect(mocks.p3aRecord).toHaveBeenCalledWith("onboarding.use-case.work");
    // Completion is the caller's job (App marks it), not the flow's.
    expect(isOnboardingComplete()).toBe(false);
  });

  it("keeps anonymous usage statistics off by default", async () => {
    render(<OnboardingFlow {...flowProps()} />);

    await screen.findByRole("heading", { name: "Help improve June" });
    expect(screen.queryByText("See exactly what is shared")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Learn how it works" })).toHaveAttribute(
      "href",
      TELEMETRY_INFO_URL,
    );
    expect(
      screen.getByRole("switch", { name: "Share anonymous usage statistics" }),
    ).toHaveAttribute("aria-checked", "false");

    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(mocks.setP3aEnabled).toHaveBeenCalledWith(false);
    await screen.findByRole("heading", {
      name: "What are you interested in using June for?",
    });
  });

  it("saves anonymous usage statistics consent when selected", async () => {
    const user = userEvent.setup();
    render(<OnboardingFlow {...flowProps()} />);

    await screen.findByRole("heading", { name: "Help improve June" });
    await user.click(screen.getByRole("switch", { name: "Share anonymous usage statistics" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(mocks.setP3aEnabled).toHaveBeenCalledWith(true);
    await screen.findByRole("heading", {
      name: "What are you interested in using June for?",
    });
  });

  it("asks what the user wants to use June for", async () => {
    const user = userEvent.setup();
    setOnboardingResumeStep("usage-intent");
    render(<OnboardingFlow {...flowProps()} />);

    await screen.findByRole("heading", {
      name: "What are you interested in using June for?",
    });
    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(continueButton).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Work" }));
    await user.click(screen.getByRole("button", { name: "Personal" }));
    expect(continueButton).toBeEnabled();

    await user.click(continueButton);

    expect(onboardingUseCases()).toEqual(["work", "personal"]);
    expect(mocks.p3aRecord).toHaveBeenCalledWith("onboarding.use-case.work");
    expect(mocks.p3aRecord).toHaveBeenCalledWith("onboarding.use-case.personal");
    await screen.findByRole("heading", { name: "Let June listen and type" });
  });

  it("saves a custom onboarding use case locally", async () => {
    const user = userEvent.setup();
    setOnboardingResumeStep("usage-intent");
    render(<OnboardingFlow {...flowProps()} />);

    await screen.findByRole("heading", {
      name: "What are you interested in using June for?",
    });
    const continueButton = screen.getByRole("button", { name: "Continue" });

    await user.click(screen.getByRole("button", { name: "Other" }));
    expect(continueButton).toBeDisabled();

    await user.type(screen.getByPlaceholderText("Type your own use case"), "  family admin  ");
    expect(continueButton).toBeEnabled();

    await user.click(continueButton);

    expect(onboardingUseCases()).toEqual(["other"]);
    expect(onboardingCustomUseCase()).toBe("family admin");
    expect(mocks.p3aRecord).toHaveBeenCalledWith("onboarding.use-case.other");
    expect(mocks.p3aRecord.mock.calls.flat()).not.toContain("family admin");
    await screen.findByRole("heading", { name: "Let June listen and type" });
  });

  async function walkToPractice(user: ReturnType<typeof userEvent.setup>) {
    grantPermissions();
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByPlaceholderText(/Tell June what to do/i);
  }

  it("enables practice completion for a one-character reply", async () => {
    const user = userEvent.setup();
    await renderFlow();
    await walkToPractice(user);

    const startButton = screen.getByRole("button", {
      name: "Start using June",
    });
    expect(startButton).toBeDisabled();

    await user.type(screen.getByPlaceholderText(/Tell June what to do/i), "h");

    await screen.findByRole("status", { name: "Dictation is working" });
    expect(startButton).toBeEnabled();
  });

  it("normalizes the factory-default shortcut to fn", async () => {
    // A fresh install still carries the Rust-side Ctrl+Opt+D default; only
    // then does onboarding write the bare-fn product default.
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
    setOnboardingResumeStep("dictation-practice");
    render(<OnboardingFlow {...flowProps()} />);
    await screen.findByRole("heading", { name: "Talk to June" });

    await waitFor(() =>
      expect(mocks.setDictationShortcut).toHaveBeenCalledWith(
        "push_to_talk",
        expect.objectContaining({ code: "Fn" }),
      ),
    );
  });

  it("keeps a customized shortcut on a wizard replay", async () => {
    // A version bump replays the wizard for existing users; a key they set
    // in Settings must survive untouched and show in the hint keycaps.
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
    setOnboardingResumeStep("dictation-practice");
    render(<OnboardingFlow {...flowProps()} />);
    await screen.findByRole("heading", { name: "Talk to June" });

    await waitFor(() => expect(screen.getAllByText("F5")).toHaveLength(2));
    expect(mocks.setDictationShortcut).not.toHaveBeenCalled();
  });

  it("rebinds the dictation key from the practice screen", async () => {
    const user = userEvent.setup();
    await renderFlow();
    await walkToPractice(user);
    mocks.setDictationShortcut.mockClear();

    // "Change key" hands the helper the capture; the chord comes back as a
    // shortcut_captured event and lands in the setting.
    await user.click(screen.getByRole("button", { name: "Change key" }));
    expect(mocks.dictationHelperCommand).toHaveBeenCalledWith({
      type: "start_shortcut_capture",
      pressCount: 1,
    });
    await screen.findByText(/Press shortcut/);

    emitDictationEvent?.({
      payload: JSON.stringify({
        type: "shortcut_captured",
        payload: {
          shortcut: {
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
        },
      }),
    });

    await waitFor(() =>
      expect(mocks.setDictationShortcut).toHaveBeenCalledWith(
        "push_to_talk",
        expect.objectContaining({ code: "F5", label: "F5" }),
      ),
    );
    // Both the instruction row and the composer-corner chip show the new key.
    await waitFor(() => expect(screen.getAllByText("F5")).toHaveLength(2));
  });

  it("cancels a shortcut capture with Escape", async () => {
    const user = userEvent.setup();
    await renderFlow();
    await walkToPractice(user);

    await user.click(screen.getByRole("button", { name: "Change key" }));
    await screen.findByText(/Press shortcut/);
    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(mocks.dictationHelperCommand).toHaveBeenCalledWith({
        type: "cancel_shortcut_capture",
      }),
    );
    // Back to the idle instruction with the key unchanged (the keycaps
    // render the fn glyph lowercase).
    await waitFor(() => expect(screen.getAllByText("fn")).toHaveLength(2));
    expect(mocks.setDictationShortcut).not.toHaveBeenCalledWith(
      "push_to_talk",
      expect.objectContaining({ code: "F5" }),
    );
  });

  it("signs the user in from the first step", async () => {
    const user = userEvent.setup();
    const onAccountChanged = vi.fn();
    mocks.osAccountsLogin.mockResolvedValue(account);
    const { rerender } = render(
      <OnboardingFlow {...flowProps({ account: signedOutAccount, onAccountChanged })} />,
    );

    await screen.findByRole("heading", { name: "Welcome to June" });
    await user.click(screen.getByRole("button", { name: "Continue with OpenSoftware" }));

    expect(mocks.osAccountsLogin).toHaveBeenCalledOnce();
    await waitFor(() => expect(onAccountChanged).toHaveBeenCalledWith(account));
    rerender(<OnboardingFlow {...flowProps({ account, onAccountChanged })} />);
    await screen.findByRole("heading", { name: "Help improve June" });
  });

  it("opens the June community from the welcome step", async () => {
    const user = userEvent.setup();
    render(<OnboardingFlow {...flowProps({ account: signedOutAccount })} />);

    await screen.findByRole("heading", { name: "Welcome to June" });
    await user.click(
      screen.getByRole("button", {
        name: "Join the June community on Telegram",
      }),
    );

    expect(mocks.juneOpenCommunityPage).toHaveBeenCalledOnce();
  });

  it("shows Windows-accurate welcome copy", async () => {
    const restoreNavigator = stubNavigatorPlatform(
      "Win32",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    );
    try {
      render(<OnboardingFlow {...flowProps({ account: signedOutAccount })} />);

      await screen.findByRole("heading", { name: "Welcome to June" });
      expect(screen.getByText("Desktop notes for your work")).toBeInTheDocument();
      expect(screen.getByText("Meeting notes from your mic")).toBeInTheDocument();
      expect(
        screen.getByText("Record meetings from your microphone and turn them into notes."),
      ).toBeInTheDocument();
      expect(screen.queryByText("Speak instead of type")).not.toBeInTheDocument();
      expect(
        screen.queryByText(/June turns your voice into polished writing/),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Effortlessly capture meetings")).not.toBeInTheDocument();
      expect(screen.queryByText("Chat and work with June")).not.toBeInTheDocument();
    } finally {
      restoreNavigator();
    }
  });

  it("does not ask unsubscribed users for a card during onboarding", async () => {
    const user = userEvent.setup();
    render(<OnboardingFlow {...flowProps({ account: unsubscribedAccount })} />);
    await screen.findByRole("heading", { name: "Help improve June" });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", {
      name: "What are you interested in using June for?",
    });
    await user.click(screen.getByRole("button", { name: "Work" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Let June listen and type" });

    grantPermissions();
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByPlaceholderText(/Tell June what to do/i);

    expect(screen.queryByRole("heading", { name: /free trial/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Start free trial/i })).toBeNull();
    expect(mocks.osAccountsOpenPortal).not.toHaveBeenCalled();
  });

  it("resumes a half-finished run at the saved step", async () => {
    setOnboardingResumeStep("dictation-practice");
    render(<OnboardingFlow {...flowProps()} />);
    await screen.findByRole("heading", { name: "Talk to June" });
  });

  it("does not collect onboarding source metadata", async () => {
    const user = userEvent.setup();
    setOnboardingResumeStep("dictation-practice");
    render(<OnboardingFlow {...flowProps()} />);
    await screen.findByRole("heading", { name: "Talk to June" });

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByRole("option")).toBeNull();

    await user.type(screen.getByPlaceholderText(/Tell June what to do/i), "hello there");
    await user.click(screen.getByRole("button", { name: "Start using June" }));
  });

  it("resets only onboarding progress when replaying the wizard", () => {
    markOnboardingComplete();
    setOnboardingResumeStep("setup");
    localStorage.setItem("june.agent.riskAcknowledged", "true");

    resetOnboardingForReplay();

    expect(isOnboardingComplete()).toBe(false);
    expect(onboardingResumeStep()).toBeNull();
    expect(isAgentRiskAcknowledged()).toBe(true);
  });

  it("applies the replay flag only in development", () => {
    markOnboardingComplete();
    setOnboardingResumeStep("setup");

    applyOnboardingReplayFlag({
      DEV: false,
      VITE_JUNE_REPLAY_ONBOARDING: "1",
    });

    expect(isOnboardingComplete()).toBe(true);
    expect(onboardingResumeStep()).toBe("setup");

    applyOnboardingReplayFlag({
      DEV: true,
      VITE_JUNE_REPLAY_ONBOARDING: "1",
    });

    expect(isOnboardingComplete()).toBe(false);
    expect(onboardingResumeStep()).toBeNull();
  });

  it("requests the mic permission when the mic screen shows", async () => {
    await renderFlow();
    await waitFor(() =>
      expect(mocks.dictationHelperCommand).toHaveBeenCalledWith({
        type: "request_microphone_permission",
      }),
    );
  });

  it("only requires microphone access on Windows", async () => {
    const restoreNavigator = stubNavigatorPlatform(
      "Win32",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    );
    try {
      const onComplete = await renderFlow();

      expect(
        screen.getByText("Dictation and meeting notes need microphone access."),
      ).toBeInTheDocument();
      expect(screen.queryByText("Accessibility")).not.toBeInTheDocument();
      expect(screen.queryByText("System audio")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();

      emitDictationEvent?.({
        payload: JSON.stringify({
          type: "permission_status",
          payload: { microphone: "granted", accessibility: "missing" },
        }),
      });

      await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
      await userEvent.click(screen.getByRole("button", { name: "Continue" }));

      await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
      expect(screen.queryByRole("heading", { name: "Talk to June" })).not.toBeInTheDocument();
    } finally {
      restoreNavigator();
    }
  });

  it("probes system audio when the macOS permissions screen shows", async () => {
    // The probe is what surfaces the system-audio TCC prompt on a fresh
    // install; it must fire here, in context, not after onboarding.
    const restoreNavigator = stubMacNavigatorPlatform();
    try {
      await renderFlow();
      await waitFor(() =>
        expect(mocks.checkRecordingSourceReadiness).toHaveBeenCalledWith("microphonePlusSystem"),
      );
    } finally {
      restoreNavigator();
    }
  });

  it("keeps continue locked and falls back to settings when system audio is denied", async () => {
    const user = userEvent.setup();
    const restoreNavigator = stubMacNavigatorPlatform();
    mocks.checkRecordingSourceReadiness.mockResolvedValue(systemAudioReadiness(false));
    try {
      await renderFlow();
      grantPermissions();

      await screen.findByText(
        "Turned off in System Settings. Flip the toggle and June will notice.",
      );
      expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();

      await user.click(screen.getByRole("button", { name: "Allow system audio access" }));
      expect(mocks.openPrivacySettings).toHaveBeenCalledWith("systemAudio");

      // The user flips the toggle and comes back; the focus re-probe picks
      // up the grant.
      mocks.checkRecordingSourceReadiness.mockResolvedValue(systemAudioReadiness(true));
      window.dispatchEvent(new Event("focus"));
      await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
    } finally {
      restoreNavigator();
    }
  });

  it("does not block continue when system audio is unsupported", async () => {
    const restoreNavigator = stubMacNavigatorPlatform();
    const readiness = systemAudioReadiness(false);
    const sysIdx = readiness.sources.findIndex((s) => s.source === "system");
    readiness.sources[sysIdx] = {
      ...readiness.sources[sysIdx],
      permissionState: "unsupported",
    };
    mocks.checkRecordingSourceReadiness.mockResolvedValue(readiness);
    try {
      await renderFlow();
      grantPermissions();

      await screen.findByText("Needs macOS 14.2 or later.");
      await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
    } finally {
      restoreNavigator();
    }
  });

  it("does not show System Settings copy when system audio permission is granted but capture is unavailable", async () => {
    const restoreNavigator = stubMacNavigatorPlatform();
    mocks.checkRecordingSourceReadiness.mockResolvedValue(systemAudioCaptureUnavailableReadiness());
    try {
      await renderFlow();
      grantPermissions();

      expect(
        screen.queryByText("Turned off in System Settings. Flip the toggle and June will notice."),
      ).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
    } finally {
      restoreNavigator();
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

    // A sibling window (the HUD) receives both the storage event and the
    // BroadcastChannel message for the same completion; the guard collapses
    // them into a single invocation.
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
