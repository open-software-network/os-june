import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingFlow } from "../components/onboarding/OnboardingFlow";
import {
  isAgentRiskAcknowledged,
  isOnboardingComplete,
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

  async function walkToAgent(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "Set up June" }));
    // Privacy education.
    await screen.findByRole("heading", { name: "Private by design" });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    // Permissions: continue stays locked until the helper reports both granted.
    await screen.findByRole("heading", { name: "Let June listen and type" });
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    grantPermissions();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    // Dictation practice: typing into the field stands in for dictation,
    // and the step applies the fn dictation key on mount.
    const input = await screen.findByPlaceholderText(/Hold Fn/i);
    await waitFor(() =>
      expect(mocks.setDictationShortcut).toHaveBeenCalledWith(
        "push_to_talk",
        expect.objectContaining({ code: "Fn" }),
      ),
    );
    await user.type(input, "hello there");
    await screen.findByText(/That's it\./);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    // Meeting notes.
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Meet the agent" });
  }

  it("walks the full flow and persists what the user chose", async () => {
    const user = userEvent.setup();
    const onComplete = await renderFlow();

    await walkToAgent(user);

    // The agent screen gates on the acknowledgment checkbox.
    const continueButton = screen.getByRole("button", { name: "Continue" });
    expect(continueButton).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    expect(continueButton).toBeEnabled();
    await user.click(continueButton);

    await user.click(
      await screen.findByRole("button", { name: "Start using June" }),
    );

    expect(onComplete).toHaveBeenCalledOnce();
    expect(isAgentRiskAcknowledged()).toBe(true);
    // Completion is the caller's job (App marks it), not the flow's.
    expect(isOnboardingComplete()).toBe(false);
  });

  async function walkToTrial(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "Set up June" }));
    await screen.findByRole("heading", { name: "Private by design" });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Let June listen and type" });
    grantPermissions();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Try June free" });
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
      name: "Finish in your browser",
    });

    // Checkout completes in the browser; the refreshed snapshot flips the
    // step to its success state and pulls the app forward.
    rerender(<OnboardingFlow {...props} account={account} />);
    await screen.findByRole("heading", {
      name: "Your trial is live",
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
    await screen.findByRole("heading", { name: "Finish in your browser" });

    // Cancel: back to the pitch with a friendly note, not an error.
    emitBillingCallback?.({ payload: "cancel" });
    await screen.findByRole("heading", { name: "Try June free" });
    await screen.findByText(/Checkout canceled/);

    // Success: the deep link triggers an immediate status refresh.
    onRefreshAccount.mockClear();
    await user.click(screen.getByRole("button", { name: "Start free trial" }));
    await screen.findByRole("heading", { name: "Finish in your browser" });
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

  it("resumes a half-finished run at the saved step", async () => {
    setOnboardingResumeStep("meeting-notes");
    render(<OnboardingFlow {...flowProps()} />);
    await screen.findByRole("heading", { name: "Never take notes again" });
  });

  it("requests the mic permission when the mic screen shows", async () => {
    const user = userEvent.setup();
    await renderFlow();
    await user.click(screen.getByRole("button", { name: "Set up June" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "Let June listen and type" });
    await waitFor(() =>
      expect(mocks.dictationHelperCommand).toHaveBeenCalledWith({
        type: "request_microphone_permission",
      }),
    );
  });
});
