import { useCallback, useEffect, useState } from "react";
import { IconLock } from "central-icons/IconLock";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconSparkle } from "central-icons/IconSparkle";
import { osAccountsCancelLogin, osAccountsLogin } from "../../../lib/tauri";
import type { AccountStatus } from "../../../lib/tauri";
import { OsMark } from "../../account/AccountGate";
import { Spinner } from "../../ui/Spinner";
import { OnboardingPrimaryButton, StepCard } from "../StepChrome";

// What June is, in three rows: the agent is the product, dictation and
// meeting notes are how you talk to it, and private is why it's safe to.
const JUNE_POINTS = [
  {
    icon: IconSparkle,
    title: "An agent on your Mac",
    detail: "Hand June real work. It runs the session and comes back done.",
  },
  {
    icon: IconMicrophone,
    title: "Talk instead of type",
    detail: "Dictate into any app. June writes your meeting notes too.",
  },
  {
    icon: IconLock,
    title: "Private by default",
    detail:
      "Prompts leave your Mac only for inference, on zero-retention models by default.",
  },
];

/**
 * Step 1: welcome + sign-in, fused into one screen so the wizard frames the
 * very first thing a new user sees. The browser handoff resolves through the
 * deep link; when `osAccountsLogin` returns the step flips to a signed-in
 * greeting — one continue, no re-finding the app.
 */
export function SignInStep({
  account,
  onAccountChanged,
  onContinue,
}: {
  account: AccountStatus;
  onAccountChanged: (next: AccountStatus) => void;
  onContinue: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();

  const cancelInFlight = useCallback(async () => {
    try {
      await osAccountsCancelLogin();
    } catch {
      // The pending login promise rejects with "login_canceled"; handleSignIn's
      // catch surfaces the message, so there's nothing to do here.
    }
  }, []);

  useEffect(() => {
    return () => {
      if (busy) void cancelInFlight();
    };
  }, [busy, cancelInFlight]);

  async function handleSignIn() {
    setBusy(true);
    setStatus(undefined);
    try {
      const next = await osAccountsLogin();
      if (next.signedIn) {
        onAccountChanged(next);
        onContinue();
      } else {
        setStatus("Sign-in did not complete. Please try again.");
      }
    } catch (error) {
      setStatus(messageFromError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <StepCard
      title="Welcome to June"
      subtitle="Your private AI assistant."
      mark
      wide
    >
      <ul className="onboarding-points">
        {JUNE_POINTS.map(({ icon: Icon, title, detail }) => (
          <li key={title}>
            <span className="onboarding-point-icon" aria-hidden>
              <Icon size={15} />
            </span>
            <div>
              <span className="onboarding-point-label">{title}</span>
              <span className="onboarding-point-detail">{detail}</span>
            </div>
          </li>
        ))}
      </ul>
      {account.configured ? (
        <div className="welcome-providers">
          {busy ? (
            <div
              className="welcome-auth-progress onboarding-waiting"
              role="status"
              aria-live="polite"
            >
              <span className="welcome-progress-label">
                <Spinner className="welcome-spinner" aria-hidden />
                <span>Complete sign-in in browser</span>
              </span>
              <button
                type="button"
                className="welcome-cancel-btn"
                onClick={() => void cancelInFlight()}
              >
                Cancel
              </button>
            </div>
          ) : (
            <OnboardingPrimaryButton onClick={() => void handleSignIn()}>
              <OsMark />
              <span>Continue with OpenSoftware</span>
            </OnboardingPrimaryButton>
          )}
        </div>
      ) : (
        <p className="welcome-status welcome-status-info">
          OpenSoftware sign-in is not configured for this build.
        </p>
      )}
      {status ? <p className="welcome-status">{status}</p> : null}
      <p className="welcome-terms">
        By continuing, you agree to the{" "}
        <a
          href="https://accounts.opensoftware.co/terms"
          target="_blank"
          rel="noreferrer"
        >
          Terms
        </a>{" "}
        and{" "}
        <a
          href="https://accounts.opensoftware.co/privacy"
          target="_blank"
          rel="noreferrer"
        >
          Privacy Policy
        </a>
        .
      </p>
    </StepCard>
  );
}

function messageFromError(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
