import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingFlow } from "../components/onboarding/OnboardingFlow";
import {
  applyOnboardingReplayFlag,
  isAgentRiskAcknowledged,
  isOnboardingComplete,
  markOnboardingComplete,
  onboardingResumeStep,
  resetOnboardingForReplay,
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
  osAccountsCancelLogin: vi.fn(),
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
  osAccountsCancelLogin: mocks.osAccountsCancelLogin,
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

  async function walkToTrial(user: ReturnType<typeof userEvent.setup>) {
    await user.click(
      screen.getByRole("button", { name: "Let's get you set up" }),
    );
    await screen.findByRole("heading", {
      name: "Private by architecture, not by promise",
    });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", {
      name: "June doesn't collect your data",
    });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", {
      name: "Give June permissions on your Mac",
    });
    grantPermissions();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Set up dictation" });
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
    await screen.findByRole("heading", { name: /Welcome, Gaut!/ });

    await walkToTrial(user);
    await user.click(screen.getByRole("button", { name: "Start free trial" }));

    expect(mocks.osAccountsStartTrialCheckout).toHaveBeenCalledOnce();
    // No portal page in the middle: the direct checkout opened, so the
    // portal command must not have fired.
    expect(mocks.osAccountsOpenPortal).not.toHaveBeenCalled();
    await screen.findByRole("heading", {
      name: "Finish checkout in your browser",
    });

    // Checkout completes in the browser; the refreshed snapshot flips the
    // step to its success state and pulls the app forward.
    rerender(<OnboardingFlow {...props} account={account} />);
    await screen.findByRole("heading", {
      name: "You're in! Your free trial is active",
    });
    expect(mocks.focusMainWindow).toHaveBeenCalledOnce();

    await user.click(
      screen.getByRole("button", { name: "Try your first dictation" }),
    );
    await screen.findByPlaceholderText(/Hold fn/i);
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
    await screen.findByRole("heading", { name: /Welcome, Gaut!/ });

    await walkToTrial(user);
    await user.click(screen.getByRole("button", { name: "Start free trial" }));
    await screen.findByRole("heading", {
      name: "Finish checkout in your browser",
    });

    // Cancel: back to the pitch with a friendly note, not an error.
    emitBillingCallback?.({ payload: "cancel" });
    await screen.findByRole("heading", { name: "Start your free trial" });
    await screen.findByText(/Checkout canceled/);

    // Success: the deep link triggers an immediate status refresh.
    onRefreshAccount.mockClear();
    await user.click(screen.getByRole("button", { name: "Start free trial" }));
    await screen.findByRole("heading", {
      name: "Finish checkout in your browser",
    });
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
    await screen.findByRole("heading", { name: /Welcome, Gaut!/ });

    await walkToTrial(user);
    await user.click(screen.getByRole("button", { name: "Start free trial" }));

    await waitFor(() =>
      expect(mocks.osAccountsOpenPortal).toHaveBeenCalledOnce(),
    );
    await screen.findByText(/We opened your account portal/);
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
    await screen.findByRole("heading", { name: /Welcome, Gaut!/ });

    await walkToTrial(user);
    await user.click(screen.getByRole("button", { name: "Start free trial" }));

    // While the sign-in bounce is in flight the button says what's happening
    // (and stays disabled) instead of pretending checkout is opening.
    const reauthButton = await screen.findByRole("button", {
      name: "Confirming your sign-in…",
    });
    expect(reauthButton).toBeDisabled();
    finishLogin?.();

    await waitFor(() =>
      expect(mocks.osAccountsStartTrialCheckout).toHaveBeenCalledTimes(2),
    );
    expect(mocks.osAccountsLogin).toHaveBeenCalledOnce();
    expect(mocks.osAccountsOpenPortal).not.toHaveBeenCalled();
    await screen.findByRole("heading", {
      name: "Finish checkout in your browser",
    });
    await screen.findByText(/We opened a secure Stripe checkout/);
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
    await screen.findByRole("heading", { name: /Welcome, Gaut!/ });

    await walkToTrial(user);
    await user.click(screen.getByRole("button", { name: "Start free trial" }));

    await waitFor(() =>
      expect(mocks.osAccountsOpenPortal).toHaveBeenCalledOnce(),
    );
    // No retry without a fresh grant: the direct path was attempted once.
    expect(mocks.osAccountsStartTrialCheckout).toHaveBeenCalledOnce();
    await screen.findByText(/We opened your account portal/);
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
    await screen.findByRole("heading", { name: /Welcome, Gaut!/ });

    await walkToTrial(user);
    await user.click(screen.getByRole("button", { name: "Start free trial" }));

    await waitFor(() =>
      expect(mocks.osAccountsOpenPortal).toHaveBeenCalledOnce(),
    );
    expect(mocks.osAccountsStartTrialCheckout).toHaveBeenCalledTimes(2);
    await screen.findByText(/We opened your account portal/);
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
    await screen.findByRole("heading", { name: /Welcome, Gaut!/ });

    await walkToTrial(user);
    await user.click(screen.getByRole("button", { name: "Start free trial" }));

    // Back at the pitch with a friendly note; no portal page forced open.
    await screen.findByRole("heading", { name: "Start your free trial" });
    await screen.findByText(/Sign-in canceled/);
    expect(mocks.osAccountsOpenPortal).not.toHaveBeenCalled();
  });

  it("resumes a half-finished run at the saved step", async () => {
    setOnboardingResumeStep("setup");
    render(<OnboardingFlow {...flowProps()} />);
    await screen.findByRole("heading", { name: "Set up dictation" });
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
