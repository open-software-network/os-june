import { useCallback, useEffect, useState } from "react";
import { osAccountsCancelLogin, osAccountsLogin } from "../../../lib/tauri";
import type { AccountStatus } from "../../../lib/tauri";
import { Spinner } from "../../ui/Spinner";
import { StepActions, StepHeading } from "../StepChrome";

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
      <section className="onboarding-step">
        <StepHeading
          title={name ? `Welcome, ${name}!` : "Welcome to June"}
          subtitle={
            account.user?.handle
              ? `You're signed in as @${account.user.handle}. Let's get June set up.`
              : "You're signed in. Let's get June set up."
          }
        />
        <StepActions
          continueLabel="Let's get you set up"
          onContinue={onContinue}
        />
      </section>
    );
  }

  return (
    <section className="onboarding-step">
      <StepHeading
        title="Welcome to June"
        subtitle="June is your private AI assistant: dictate into any app, never take meeting notes again, and hand off real work to an agent that runs on your Mac."
      />
      <ul className="onboarding-feature-list">
        <li>
          <strong>Talk, don't type</strong>: hold a key and speak; June types
          at your cursor in whatever app has focus.
        </li>
        <li>
          <strong>Never take notes again</strong>: decisions, action items,
          your side and theirs, written for you.
        </li>
        <li>
          <strong>Hand off real work</strong>: give June a task, not just a
          question. It comes back with it done.
        </li>
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
              June picks up where you left off the moment you're done.
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
