import { useCallback, useEffect, useState } from "react";
import { IconBrain } from "central-icons/IconBrain";
import { IconFolderShield } from "central-icons/IconFolderShield";
import { IconLock } from "central-icons/IconLock";
import { osAccountsCancelLogin, osAccountsLogin } from "../../../lib/tauri";
import type { AccountStatus } from "../../../lib/tauri";
import { OnboardingPrimaryButton, StepCard } from "../StepChrome";

const PRIVACY_POINTS = [
  {
    icon: IconFolderShield,
    title: "Your private life stays on this Mac",
    detail: "Your saved files, recordings, notes, and conversations stay here by default.",
  },
  {
    icon: IconLock,
    title: "I default to Private models",
    detail: "Zero-retention models don't store your prompts or train on them.",
  },
  {
    icon: IconBrain,
    title: "I learn and remember everything locally",
    detail: "What I learn about you and remember stays on this Mac too.",
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
      title="Hi, I'm June. Your private AI."
      subtitle="I make it easy to use AI without worrying about exposing your personal life."
      mark
      wide
      className="welcome-card-intro"
    >
      <ul className="onboarding-points">
        {PRIVACY_POINTS.map(({ icon: Icon, title, detail }) => (
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
      <p className="onboarding-source-note">
        My code is open source, so you can{" "}
        <a
          href="https://github.com/open-software-network/os-june"
          target="_blank"
          rel="noreferrer"
        >
          verify everything yourself
        </a>
        .
      </p>
      {account.configured ? (
        <div className="welcome-providers">
          {busy ? (
            <div
              className="welcome-auth-progress onboarding-waiting"
              role="status"
              aria-live="polite"
            >
              <span className="welcome-progress-label">
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
              <span>Continue with June</span>
            </OnboardingPrimaryButton>
          )}
        </div>
      ) : (
        <p className="welcome-status welcome-status-info">
          June sign-in isn't configured for this build.
        </p>
      )}
      {status ? <p className="welcome-status">{status}</p> : null}
      <p className="welcome-terms">
        By continuing, you agree to the{" "}
        <a href="https://accounts.opensoftware.co/terms" target="_blank" rel="noreferrer">
          Terms
        </a>{" "}
        and{" "}
        <a href="https://accounts.opensoftware.co/privacy" target="_blank" rel="noreferrer">
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
