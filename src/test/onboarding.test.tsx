import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingFlow } from "../components/onboarding/OnboardingFlow";
import {
  applyOnboardingReplayFlag,
  discoverySource,
  isAgentRiskAcknowledged,
  isOnboardingComplete,
  markOnboardingComplete,
  onboardingResumeStep,
  resetOnboardingForReplay,
  setDiscoverySource,
  setOnboardingResumeStep,
} from "../lib/onboarding";
import type { AccountStatus } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  dictationSettings: vi.fn(),
  dictationHelperCommand: vi.fn(),
  openPrivacySettings: vi.fn(),
  setDictationLanguage: vi.fn(),
  setDictationShortcut: vi.fn(),
  osAccountsLogin: vi.fn(),
  scribeOpenVerifyPage: vi.fn(),
  osAccountsCancelLogin: vi.fn(),
  osAccountsPrepareTrialCheckout: vi.fn(),
  osAccountsStartTrialCheckout: vi.fn(),
  osAccountsOpenPortal: vi.fn(),
  focusMainWindow: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  dictationSettings: mocks.dictationSettings,
  dictationHelperCommand: mocks.dictationHelperCommand,
  openPrivacySettings: mocks.openPrivacySettings,
  setDictationLanguage: mocks.setDictationLanguage,
  setDictationShortcut: mocks.setDictationShortcut,
  osAccountsLogin: mocks.osAccountsLogin,
  scribeOpenVerifyPage: mocks.scribeOpenVerifyPage,
  osAccountsCancelLogin: mocks.osAccountsCancelLogin,
  osAccountsPrepareTrialCheckout: mocks.osAccountsPrepareTrialCheckout,
  osAccountsStartTrialCheckout: mocks.osAccountsStartTrialCheckout,
  osAccountsOpenPortal: mocks.osAccountsOpenPortal,
  focusMainWindow: mocks.focusMainWindow,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

// Signed in AND already on a subscription: the trial step auto-skips, so the
// full-walk test exercises the same path an existing member re-running the
// wizard sees.
const account: AccountStatus = {
  signedIn: true,
  configured: true,
  user: { id: "u1", handle: "gaut", displayName: "Gaut Tester" },
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
  let emitBillingCallback: ListenHandler | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    emitDictationEvent = undefined;
    emitBillingCallback = undefined;
    mocks.listen.mockImplementation(
      (eventName: string, handler: ListenHandler) => {
        if (eventName === "dictation-event") emitDictationEvent = handler;
        if (eventName === "os-accounts-billing-callback") {
          emitBillingCallback = handler;
        }
        return Promise.resolve(vi.fn());
      },
    );
    mocks.dictationHelperCommand.mockResolvedValue(undefined);
    mocks.openPrivacySettings.mockResolvedValue(undefined);
    mocks.osAccountsCancelLogin.mockResolvedValue(undefined);
    mocks.osAccountsPrepareTrialCheckout.mockResolvedValue({
      outcome: "ready",
    });
    mocks.osAccountsOpenPortal.mockResolvedValue(undefined);
    mocks.focusMainWindow.mockResolvedValue(undefined);
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

  function flowProps(
    overrides: Partial<Parameters<typeof OnboardingFlow>[0]> = {},
  ) {
    return {
      account,
      onAccountChanged: vi.fn(),
      onRefreshAccount: vi.fn(async () => undefined),
      onComplete: vi.fn(),
      ...overrides,
    };
  }

  async function renderFlow(onComplete = vi.fn()) {
    render(<OnboardingFlow {...flowProps({ onComplete })} />);
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

  it("walks the full flow for a subscribed user", async () => {
    const user = userEvent.setup();
    const onComplete = await renderFlow();

    // Permissions: continue stays locked until the helper reports both granted.
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    grantPermissions();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    // The trial auto-skips (already subscribed), landing on the practice
    // step. Typing into the field stands in for dictation.
    const input = await screen.findByPlaceholderText(/Tell June what to do/i);
    await user.type(input, "hello there");
    await screen.findByRole("status", { name: "Dictation is working" });
    await user.click(screen.getByRole("button", { name: "Start using June" }));

    expect(onComplete).toHaveBeenCalledOnce();
    // Completion is the caller's job (App marks it), not the flow's.
    expect(isOnboardingComplete()).toBe(false);
  });

  async function walkToPractice(user: ReturnType<typeof userEvent.setup>) {
    grantPermissions();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByPlaceholderText(/Tell June what to do/i);
  }

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

  async function walkToTrial(user: ReturnType<typeof userEvent.setup>) {
    await screen.findByRole("heading", { name: "Let June listen and type" });
    grantPermissions();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Start your free trial" });
  }

  it("signs the user in from the first step", async () => {
    const user = userEvent.setup();
    const onAccountChanged = vi.fn();
    mocks.osAccountsLogin.mockResolvedValue(account);
    render(
      <OnboardingFlow
        {...flowProps({ account: signedOutAccount, onAccountChanged })}
      />,
    );

    await screen.findByRole("heading", { name: "Welcome to June" });
    await user.click(
      screen.getByRole("button", { name: "Continue with OpenSoftware" }),
    );

    expect(mocks.osAccountsLogin).toHaveBeenCalledOnce();
    await waitFor(() => expect(onAccountChanged).toHaveBeenCalledWith(account));
  });

  it("starts the trial checkout in one click and advances when the subscription lands", async () => {
    const user = userEvent.setup();
    mocks.osAccountsStartTrialCheckout.mockResolvedValue({
      outcome: "checkoutOpened",
    });
    const props = flowProps({ account: unsubscribedAccount });
    const { rerender } = render(<OnboardingFlow {...props} />);
    await screen.findByRole("heading", { name: "Let June listen and type" });

    await walkToTrial(user);
    await user.click(screen.getByRole("button", { name: "Start free trial" }));

    expect(mocks.osAccountsStartTrialCheckout).toHaveBeenCalledOnce();
    // No portal page in the middle: the direct checkout opened, so the
    // portal command must not have fired.
    expect(mocks.osAccountsOpenPortal).not.toHaveBeenCalled();
    await screen.findByText(/Waiting for trial/);
    await screen.findByText(/Finish in Stripe checkout/);

    // Checkout completes in the browser; the refreshed snapshot flips the
    // step to its success state and pulls the app forward.
    rerender(<OnboardingFlow {...props} account={account} />);
    await screen.findByRole("heading", {
      name: "You're good to go",
    });
    expect(mocks.focusMainWindow).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByPlaceholderText(/Tell June what to do/i);
  });

  it("pre-mints the checkout session on the pitch and again after a cancel", async () => {
    const user = userEvent.setup();
    mocks.osAccountsStartTrialCheckout.mockResolvedValue({
      outcome: "checkoutOpened",
    });
    render(<OnboardingFlow {...flowProps({ account: unsubscribedAccount })} />);
    await screen.findByRole("heading", { name: "Let June listen and type" });
    // The pitch isn't on screen yet, so nothing should be minted.
    expect(mocks.osAccountsPrepareTrialCheckout).not.toHaveBeenCalled();

    await walkToTrial(user);
    await waitFor(() =>
      expect(mocks.osAccountsPrepareTrialCheckout).toHaveBeenCalledOnce(),
    );
    // Prefetching is invisible: the pitch keeps its ready button.
    expect(
      screen.getByRole("button", { name: "Start free trial" }),
    ).toBeEnabled();

    // A canceled checkout consumed the prepared session; landing back on
    // the pitch must mint a fresh one in the background.
    await user.click(screen.getByRole("button", { name: "Start free trial" }));
    await screen.findByText(/Waiting for trial/);
    emitBillingCallback?.({ payload: "cancel" });
    await screen.findByRole("heading", { name: "Start your free trial" });
    await waitFor(() =>
      expect(mocks.osAccountsPrepareTrialCheckout).toHaveBeenCalledTimes(2),
    );
  });

  it("keeps a failed pre-mint silent and lets the click mint on the spot", async () => {
    const user = userEvent.setup();
    mocks.osAccountsPrepareTrialCheckout.mockRejectedValue({
      code: "trial_checkout_unavailable",
      message: "Could not start the free trial checkout.",
    });
    mocks.osAccountsStartTrialCheckout.mockResolvedValue({
      outcome: "checkoutOpened",
    });
    render(<OnboardingFlow {...flowProps({ account: unsubscribedAccount })} />);
    await screen.findByRole("heading", { name: "Let June listen and type" });

    await walkToTrial(user);
    await waitFor(() =>
      expect(mocks.osAccountsPrepareTrialCheckout).toHaveBeenCalled(),
    );
    // The background failure must not leak into the pitch.
    expect(screen.queryByText(/Could not start/)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Start free trial" }));
    await screen.findByText(/Waiting for trial/);
    expect(mocks.osAccountsOpenPortal).not.toHaveBeenCalled();
  });

  it("refreshes the snapshot when the pre-mint reports an existing subscription", async () => {
    const user = userEvent.setup();
    mocks.osAccountsPrepareTrialCheckout.mockResolvedValue({
      outcome: "alreadySubscribed",
    });
    const onRefreshAccount = vi.fn(async () => account);
    render(
      <OnboardingFlow
        {...flowProps({ account: unsubscribedAccount, onRefreshAccount })}
      />,
    );
    await screen.findByRole("heading", { name: "Let June listen and type" });

    await walkToTrial(user);
    await waitFor(() => expect(onRefreshAccount).toHaveBeenCalled());
  });

  it("reacts to the post-checkout deep link without waiting out the poll", async () => {
    const user = userEvent.setup();
    mocks.osAccountsStartTrialCheckout.mockResolvedValue({
      outcome: "checkoutOpened",
    });
    const onRefreshAccount = vi.fn(async () => undefined);
    render(
      <OnboardingFlow
        {...flowProps({ account: unsubscribedAccount, onRefreshAccount })}
      />,
    );
    await screen.findByRole("heading", { name: "Let June listen and type" });

    await walkToTrial(user);
    await user.click(screen.getByRole("button", { name: "Start free trial" }));
    await screen.findByText(/Waiting for trial/);

    // Cancel: back to the pitch with a friendly note, not an error.
    emitBillingCallback?.({ payload: "cancel" });
    await screen.findByRole("heading", { name: "Start your free trial" });
    await screen.findByText(/Checkout canceled/);

    // Success: the deep link triggers an immediate status refresh.
    onRefreshAccount.mockClear();
    await user.click(screen.getByRole("button", { name: "Start free trial" }));
    await screen.findByText(/Waiting for trial/);
    emitBillingCallback?.({ payload: "success" });
    await waitFor(() => expect(onRefreshAccount).toHaveBeenCalled());
  });

  it("falls back to the portal when direct checkout is unavailable", async () => {
    const user = userEvent.setup();
    mocks.osAccountsStartTrialCheckout.mockRejectedValue(
      new Error("trial_checkout_unavailable"),
    );
    mocks.osAccountsOpenPortal.mockResolvedValue(undefined);
    render(<OnboardingFlow {...flowProps({ account: unsubscribedAccount })} />);
    await screen.findByRole("heading", { name: "Let June listen and type" });

    await walkToTrial(user);
    await user.click(screen.getByRole("button", { name: "Start free trial" }));

    await waitFor(() =>
      expect(mocks.osAccountsOpenPortal).toHaveBeenCalledOnce(),
    );
    await screen.findByText(/Finish in your account portal/);
  });

  // A grant from a sign-in that predates billing:write can't mint the
  // checkout session and refreshing can't broaden it. The hook re-runs
  // sign-in and retries so the user still lands on Stripe, never the portal.
  it("re-authenticates and retries when the grant lacks the billing scope", async () => {
    const user = userEvent.setup();
    mocks.osAccountsStartTrialCheckout
      .mockRejectedValueOnce({
        code: "trial_checkout_needs_reauth",
        message: "Sign in again to continue.",
      })
      .mockResolvedValueOnce({ outcome: "checkoutOpened" });
    let finishLogin: (() => void) | undefined;
    mocks.osAccountsLogin.mockImplementation(
      () =>
        new Promise<typeof unsubscribedAccount>((resolve) => {
          finishLogin = () => resolve(unsubscribedAccount);
        }),
    );
    render(<OnboardingFlow {...flowProps({ account: unsubscribedAccount })} />);
    await screen.findByRole("heading", { name: "Let June listen and type" });

    await walkToTrial(user);
    await user.click(screen.getByRole("button", { name: "Start free trial" }));

    // While the sign-in bounce is in flight the button says what's happening
    // (and stays disabled) instead of pretending checkout is opening.
    const reauthButton = await screen.findByRole("button", {
      name: "Confirming sign-in...",
    });
    expect(reauthButton).toBeDisabled();
    finishLogin?.();

    await waitFor(() =>
      expect(mocks.osAccountsStartTrialCheckout).toHaveBeenCalledTimes(2),
    );
    expect(mocks.osAccountsLogin).toHaveBeenCalledOnce();
    expect(mocks.osAccountsOpenPortal).not.toHaveBeenCalled();
    await screen.findByText(/Waiting for trial/);
    await screen.findByText(/Finish in Stripe checkout/);
  });

  it("falls back to the portal when the re-auth itself fails", async () => {
    const user = userEvent.setup();
    mocks.osAccountsStartTrialCheckout.mockRejectedValue({
      code: "trial_checkout_needs_reauth",
      message: "Sign in again to continue.",
    });
    mocks.osAccountsLogin.mockRejectedValue({
      code: "network_error",
      message: "Could not reach OS Accounts.",
    });
    mocks.osAccountsOpenPortal.mockResolvedValue(undefined);
    render(<OnboardingFlow {...flowProps({ account: unsubscribedAccount })} />);
    await screen.findByRole("heading", { name: "Let June listen and type" });

    await walkToTrial(user);
    await user.click(screen.getByRole("button", { name: "Start free trial" }));

    await waitFor(() =>
      expect(mocks.osAccountsOpenPortal).toHaveBeenCalledOnce(),
    );
    // No retry without a fresh grant: the direct path was attempted once.
    expect(mocks.osAccountsStartTrialCheckout).toHaveBeenCalledOnce();
    await screen.findByText(/Finish in your account portal/);
  });

  it("falls back to the portal when re-auth does not unblock checkout", async () => {
    const user = userEvent.setup();
    mocks.osAccountsStartTrialCheckout.mockRejectedValue({
      code: "trial_checkout_needs_reauth",
      message: "Sign in again to continue.",
    });
    mocks.osAccountsLogin.mockResolvedValue(unsubscribedAccount);
    mocks.osAccountsOpenPortal.mockResolvedValue(undefined);
    render(<OnboardingFlow {...flowProps({ account: unsubscribedAccount })} />);
    await screen.findByRole("heading", { name: "Let June listen and type" });

    await walkToTrial(user);
    await user.click(screen.getByRole("button", { name: "Start free trial" }));

    await waitFor(() =>
      expect(mocks.osAccountsOpenPortal).toHaveBeenCalledOnce(),
    );
    expect(mocks.osAccountsStartTrialCheckout).toHaveBeenCalledTimes(2);
    await screen.findByText(/Finish in your account portal/);
  });

  it("returns to the pitch when the user cancels the re-auth", async () => {
    const user = userEvent.setup();
    mocks.osAccountsStartTrialCheckout.mockRejectedValue({
      code: "trial_checkout_needs_reauth",
      message: "Sign in again to continue.",
    });
    mocks.osAccountsLogin.mockRejectedValue({
      code: "login_canceled",
      message: "Sign-in canceled.",
    });
    render(<OnboardingFlow {...flowProps({ account: unsubscribedAccount })} />);
    await screen.findByRole("heading", { name: "Let June listen and type" });

    await walkToTrial(user);
    await user.click(screen.getByRole("button", { name: "Start free trial" }));

    // Back at the pitch with a friendly note; no portal page forced open.
    await screen.findByRole("heading", { name: "Start your free trial" });
    await screen.findByText(/Sign-in canceled/);
    expect(mocks.osAccountsOpenPortal).not.toHaveBeenCalled();
  });

  it("resumes a half-finished run at the saved step", async () => {
    setOnboardingResumeStep("dictation-practice");
    render(<OnboardingFlow {...flowProps()} />);
    await screen.findByRole("heading", { name: "Talk to June" });
  });

  it("records where the user heard about June", async () => {
    const user = userEvent.setup();
    setOnboardingResumeStep("dictation-practice");
    render(<OnboardingFlow {...flowProps()} />);
    await screen.findByRole("heading", { name: "Talk to June" });

    await user.click(
      screen.getByRole("button", { name: "Where did you hear about June?" }),
    );
    await user.click(screen.getByRole("option", { name: "YouTube" }));

    expect(discoverySource()).toBe("youtube");
    // The trigger keeps showing the choice, and answering never gates the
    // step: Continue still waits on the dictation rep, not the survey.
    expect(
      screen.getByRole("button", { name: "Where did you hear about June?" }),
    ).toHaveTextContent("YouTube");
  });

  it("never re-asks an answered discovery question", async () => {
    // A version-bump replay walks existing users through the wizard again;
    // the survey must not come back for someone who already answered it.
    setDiscoverySource("youtube");
    setOnboardingResumeStep("dictation-practice");
    render(<OnboardingFlow {...flowProps()} />);
    await screen.findByRole("heading", { name: "Talk to June" });

    expect(screen.queryByText("Where did you hear about June?")).toBeNull();
  });

  it("resets only onboarding progress when replaying the wizard", () => {
    markOnboardingComplete();
    setOnboardingResumeStep("setup");
    setDiscoverySource("youtube");
    localStorage.setItem("june.agent.riskAcknowledged", "true");

    resetOnboardingForReplay();

    expect(isOnboardingComplete()).toBe(false);
    expect(onboardingResumeStep()).toBeNull();
    // The dev replay forgets the discovery answer (so the replayed wizard
    // shows the whole flow) but keeps the agent-risk acknowledgment.
    expect(discoverySource()).toBeNull();
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
});
