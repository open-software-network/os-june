import { useCallback, useEffect, useState } from "react";
import { IconCalendar1 } from "central-icons/IconCalendar1";
import { IconLock } from "central-icons/IconLock";
import { IconMicrophone } from "central-icons/IconMicrophone";
import { IconSparkle } from "central-icons/IconSparkle";
import { IconTelegram } from "central-icons/IconTelegram";
import { fallbackDictationCapabilities } from "../../../lib/platform";
import { juneOpenCommunityPage, osAccountsCancelLogin, osAccountsLogin } from "../../../lib/tauri";
import type { AccountStatus } from "../../../lib/tauri";
import { OsMark } from "../../account/AccountGate";
import { OnboardingPrimaryButton, StepCard } from "../StepChrome";

// Desktop platforms with bundled helpers can introduce the full agent,
// dictation, and notes surface. Unsupported platforms narrow the welcome
// promise until native helpers are turnkey there.
const JUNE_POINTS = [
  {
    icon: IconSparkle,
    title: "Chat and work with June",
    detail: "Hand June real work. It runs the session and comes back done.",
  },
  {
    icon: IconMicrophone,
    title: "Speak instead of type",
    detail: "June turns your voice into polished writing in any app on your computer.",
  },
  {
    icon: IconCalendar1,
    title: "Effortlessly capture meetings",
    detail: "June takes meeting notes without ever having to join the meeting.",
  },
  {
    icon: IconLock,
    title: "Private by default",
    detail: "Prompts leverage private, zero-retention Venice AI models by default.",
  },
];

const WINDOWS_JUNE_POINTS = [
  {
    icon: IconSparkle,
    title: "Desktop notes for your work",
    detail: "Keep meeting notes and projects together in one app.",
  },
  {
    icon: IconMicrophone,
    title: "Meeting notes from your mic",
    detail: "Record meetings from your microphone and turn them into notes.",
  },
  JUNE_POINTS[3],
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
  const capabilities = fallbackDictationCapabilities();
  const points = capabilities.available ? JUNE_POINTS : WINDOWS_JUNE_POINTS;
  const introClassName = capabilities.available ? "welcome-card-intro" : undefined;

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
      subtitle="Private AI for everyday life and work."
      mark
      wide
      className={introClassName}
    >
      <ul className="onboarding-points">
        {points.map(({ icon: Icon, title, detail }) => (
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
      <p className="onboarding-community">
        <button
          type="button"
          className="onboarding-community-link"
          onClick={() => void juneOpenCommunityPage().catch(() => undefined)}
        >
          <IconTelegram size={16} aria-hidden />
          <span>Join the June community on Telegram</span>
        </button>
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
