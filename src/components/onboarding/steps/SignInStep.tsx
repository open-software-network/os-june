import { useCallback, useEffect, useState } from "react";
import { IconMicrophone } from "central-icons-filled/IconMicrophone";
import { IconNote1 } from "central-icons-filled/IconNote1";
import { IconSparkle } from "central-icons-filled/IconSparkle";
import { osAccountsCancelLogin, osAccountsLogin } from "../../../lib/tauri";
import type { AccountStatus } from "../../../lib/tauri";
import { Spinner } from "../../ui/Spinner";
import { StepActions, StepHeading, StepSpot } from "../StepChrome";

const FEATURE_CHIPS = [
  { icon: <IconMicrophone size={15} aria-hidden />, label: "Dictate anywhere" },
  { icon: <IconNote1 size={15} aria-hidden />, label: "Meeting notes" },
  { icon: <IconSparkle size={15} aria-hidden />, label: "A real agent" },
];

/**
 * Step 1: welcome + sign-in, fused into one screen so the wizard's progress
 * bar frames the very first thing a new user sees. The browser handoff
 * resolves through the deep link; when `osAccountsLogin` returns the step
 * flips to a signed-in greeting — one continue, no re-finding the app.
 */
export function SignInStep({
  account,
  name,
  onAccountChanged,
  onContinue,
}: {
  account: AccountStatus;
  name?: string;
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
      } else {
        setStatus("Sign-in did not complete. Please try again.");
      }
    } catch (error) {
      setStatus(messageFromError(error));
    } finally {
      setBusy(false);
    }
  }

  if (account.signedIn) {
    return (
      <section className="onboarding-step onboarding-step-hero">
        <StepHeading
          art={
            <StepSpot>
              <IconSparkle size={26} aria-hidden />
            </StepSpot>
          }
          title={name ? `Welcome, ${name}!` : "Welcome to June"}
          subtitle={
            account.user?.handle
              ? `Signed in as @${account.user.handle}.`
              : "You're signed in."
          }
        />
        <StepActions continueLabel="Set up June" onContinue={onContinue} />
      </section>
    );
  }

  return (
    <section className="onboarding-step">
      <StepHeading
        title="Welcome to June"
        subtitle="Your private AI assistant. Talk instead of type, skip the note-taking, hand off real work."
      />
      <ul className="onboarding-chips" aria-hidden>
        {FEATURE_CHIPS.map((chip) => (
          <li key={chip.label} className="onboarding-chip">
            {chip.icon}
            <span>{chip.label}</span>
          </li>
        ))}
      </ul>
      {account.configured ? (
        busy ? (
          <div
            className="onboarding-browser-wait"
            role="status"
            aria-live="polite"
          >
            <span className="onboarding-browser-wait-label">
              <Spinner aria-hidden />
              <span>Complete sign-in in your browser</span>
            </span>
            <span className="onboarding-browser-wait-hint">
              June picks up the moment you're done.
            </span>
            <button
              type="button"
              className="onboarding-skip"
              onClick={() => void cancelInFlight()}
            >
              Cancel
            </button>
          </div>
        ) : (
          <StepActions
            continueLabel="Continue with OpenSoftware"
            onContinue={() => void handleSignIn()}
          />
        )
      ) : (
        <p className="welcome-status welcome-status-info">
          OpenSoftware sign-in is not configured for this build.
        </p>
      )}
      {status ? <p className="welcome-status">{status}</p> : null}
      <p className="onboarding-footnote">
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
    </section>
  );
}

function messageFromError(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
