import { useCallback, useEffect, useState } from "react";
import { osAccountsCancelLogin, osAccountsLogin } from "../../lib/tauri";
import type { AccountStatus } from "../../lib/tauri";
import { Spinner } from "../ui/Spinner";

type Props = {
  account: AccountStatus;
  loading: boolean;
  onAccountChanged: (next: AccountStatus) => void;
};

export function AccountGate({ account, loading, onAccountChanged }: Props) {
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

  return (
    <div className="welcome-screen">
      <div className="welcome-card">
        <span className="welcome-mark" aria-hidden>
          <JuneMark />
        </span>
        <h1 className="welcome-title">Welcome to June</h1>
        <p className="welcome-subtitle">
          Record conversations, turn them into notes, and dictate with your
          OpenSoftware account.
        </p>

        {account.configured ? (
          <div className="welcome-providers">
            {busy ? (
              <div
                className="welcome-auth-progress"
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
              <button
                type="button"
                className="primary-action"
                disabled={loading}
                onClick={() => void handleSignIn()}
              >
                <OsMark />
                <span>Continue with OpenSoftware</span>
              </button>
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
            href="https://opensoftware.network/terms"
            target="_blank"
            rel="noreferrer"
          >
            Terms
          </a>{" "}
          and{" "}
          <a
            href="https://opensoftware.network/privacy"
            target="_blank"
            rel="noreferrer"
          >
            Privacy Policy
          </a>
          .
        </p>
      </div>
    </div>
  );
}

function JuneMark() {
  return (
    <svg
      width="24"
      height="28"
      viewBox="0 0 12 14"
      fill="currentColor"
      aria-hidden
    >
      <path d="M11.5 6.5C11.7761 6.5 12 6.72386 12 7V8.5C12 8.77614 11.7761 9 11.5 9H10.4141C10.2815 9.00002 10.1543 9.05273 10.0605 9.14648L9.64648 9.56055C9.55273 9.6543 9.50002 9.78148 9.5 9.91406V11C9.5 11.2761 9.27614 11.5 9 11.5H3.41406C3.28148 11.5 3.1543 11.5527 3.06055 11.6465L2.64648 12.0605C2.55273 12.1543 2.50002 12.2815 2.5 12.4141V13.5C2.5 13.7761 2.27614 14 2 14H0.5C0.223858 14 0 13.7761 0 13.5V12C4.02663e-09 11.7239 0.223858 11.5 0.5 11.5H1.58594C1.71852 11.5 1.8457 11.4473 1.93945 11.3535L2.35352 10.9395C2.44727 10.8457 2.49998 10.7185 2.5 10.5859V9.5C2.5 9.22386 2.72386 9 3 9H8.58594C8.71852 8.99998 8.8457 8.94727 8.93945 8.85352L9.35352 8.43945C9.44727 8.3457 9.49998 8.21852 9.5 8.08594V7C9.5 6.72386 9.72386 6.5 10 6.5H11.5Z" />
      <path d="M11.5 0C11.7761 4.02663e-09 12 0.223858 12 0.5V2C12 2.27614 11.7761 2.5 11.5 2.5H10.4141C10.2815 2.50002 10.1543 2.55273 10.0605 2.64648L9.64648 3.06055C9.55273 3.1543 9.50002 3.28148 9.5 3.41406V4.5C9.5 4.77614 9.27614 5 9 5H3.41406C3.28148 5.00002 3.1543 5.05273 3.06055 5.14648L2.64648 5.56055C2.55273 5.6543 2.50002 5.78148 2.5 5.91406V7C2.5 7.27614 2.27614 7.5 2 7.5H0.5C0.223858 7.5 0 7.27614 0 7V5.5C4.02663e-09 5.22386 0.223858 5 0.5 5H1.58594C1.71852 4.99998 1.8457 4.94727 1.93945 4.85352L2.35352 4.43945C2.44727 4.3457 2.49998 4.21852 2.5 4.08594V3C2.5 2.72386 2.72386 2.5 3 2.5H8.58594C8.71852 2.49998 8.8457 2.44727 8.93945 2.35352L9.35352 1.93945C9.44727 1.8457 9.49998 1.71852 9.5 1.58594V0.5C9.5 0.223858 9.72386 0 10 0H11.5Z" />
    </svg>
  );
}

// The "OS" wordmark, drawn in currentColor for the sign-in button.
function OsMark() {
  return (
    <svg
      width="28"
      height="16"
      viewBox="-1 -1 30 18"
      fill="currentColor"
      aria-hidden
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M9.76172 0C10.0613 0 10.3047 0.242448 10.3047 0.541992V1.71973C10.3048 1.86331 10.3614 2.00096 10.4629 2.10254L10.9131 2.55273C11.0148 2.65436 11.1531 2.71191 11.2969 2.71191H12.4736C12.7732 2.71191 13.0166 2.95436 13.0166 3.25391V11.9316C13.0166 12.2312 12.7732 12.4746 12.4736 12.4746H11.2969C11.1531 12.4746 11.0148 12.5312 10.9131 12.6328L10.4629 13.083C10.3613 13.1847 10.3047 13.323 10.3047 13.4668V14.6436C10.3047 14.9431 10.0613 15.1865 9.76172 15.1865H3.25391C2.95436 15.1865 2.71191 14.9431 2.71191 14.6436V13.4658C2.71191 13.322 2.65436 13.1837 2.55273 13.082L2.10352 12.6328C2.00182 12.5312 1.86348 12.4746 1.71973 12.4746H0.541992C0.242448 12.4746 0 12.2312 0 11.9316V3.25391C0 2.95436 0.242448 2.71191 0.541992 2.71191H1.71973C1.86351 2.71191 2.00181 2.65436 2.10352 2.55273L2.55273 2.10352C2.65421 2.00193 2.71179 1.86428 2.71191 1.7207V0.541992C2.71191 0.242448 2.95436 0 3.25391 0H9.76172ZM3.70312 2.71191C3.55937 2.71191 3.42103 2.76852 3.31934 2.87012L2.87012 3.31934C2.76849 3.42104 2.71191 3.55934 2.71191 3.70312V11.4834C2.71204 11.627 2.76864 11.7646 2.87012 11.8662L3.31934 12.3154C3.42104 12.4171 3.55934 12.4746 3.70312 12.4746H9.3125C9.45628 12.4746 9.59459 12.4171 9.69629 12.3154L10.1455 11.8662C10.247 11.7646 10.3046 11.627 10.3047 11.4834V3.70312C10.3047 3.55934 10.2471 3.42104 10.1455 3.31934L9.69629 2.87012C9.59459 2.76852 9.45626 2.71191 9.3125 2.71191H3.70312Z"
      />
      <path d="M24.4053 0C24.7048 0 24.9482 0.242448 24.9482 0.541992V1.71973C24.9484 1.86325 25.005 2.00097 25.1064 2.10254L25.5566 2.55273C25.6584 2.65444 25.7966 2.71191 25.9404 2.71191H27.1172C27.4167 2.71191 27.6602 2.95436 27.6602 3.25391V4.88086C27.6602 5.1804 27.4167 5.42383 27.1172 5.42383H25.4902C25.1908 5.42375 24.9482 5.18036 24.9482 4.88086V3.70312C24.9482 3.55929 24.8908 3.42105 24.7891 3.31934L24.3398 2.87012C24.2382 2.76867 24.1006 2.71199 23.957 2.71191H18.3467C18.2029 2.71191 18.0646 2.76845 17.9629 2.87012L17.5137 3.31934C17.4121 3.42103 17.3555 3.5594 17.3555 3.70312V5.24609C17.3556 5.38962 17.4123 5.52733 17.5137 5.62891L17.9629 6.07812C18.0646 6.17983 18.2028 6.2373 18.3467 6.2373H24.4053C24.7048 6.2373 24.9482 6.47975 24.9482 6.7793V7.95703C24.9484 8.10056 25.005 8.23827 25.1064 8.33984L25.5566 8.79004C25.6584 8.89175 25.7966 8.94922 25.9404 8.94922H27.1172C27.4167 8.94922 27.6602 9.19167 27.6602 9.49121V11.9316C27.6602 12.2312 27.4167 12.4746 27.1172 12.4746H25.9404C25.7966 12.4746 25.6583 12.5311 25.5566 12.6328L25.1064 13.083C25.0049 13.1847 24.9482 13.3231 24.9482 13.4668V14.6436C24.9482 14.9431 24.7048 15.1865 24.4053 15.1865H17.8975C17.598 15.1864 17.3555 14.9431 17.3555 14.6436V13.4658C17.3555 13.322 17.298 13.1837 17.1963 13.082L16.7471 12.6328C16.6455 12.5314 16.5078 12.4747 16.3643 12.4746H15.1855C14.8861 12.4745 14.6436 12.2311 14.6436 11.9316V10.3047C14.6436 10.0052 14.8861 9.76277 15.1855 9.7627H16.8125C17.112 9.7627 17.3555 10.0051 17.3555 10.3047V11.4834C17.3556 11.6269 17.4123 11.7646 17.5137 11.8662L17.9629 12.3154C18.0646 12.4171 18.2028 12.4746 18.3467 12.4746H23.957C24.1007 12.4745 24.2382 12.4169 24.3398 12.3154L24.7891 11.8662C24.8906 11.7646 24.9481 11.627 24.9482 11.4834V9.94043C24.9482 9.79659 24.8908 9.65835 24.7891 9.55664L24.3398 9.10742C24.2382 9.00598 24.1006 8.9493 23.957 8.94922H17.8975C17.598 8.94915 17.3555 8.70575 17.3555 8.40625V7.22852C17.3555 7.08468 17.298 6.94644 17.1963 6.84473L16.7471 6.39551C16.6455 6.29406 16.5078 6.23738 16.3643 6.2373H15.1855C14.8861 6.23723 14.6436 5.99383 14.6436 5.69434V3.25391C14.6436 2.95441 14.8861 2.71199 15.1855 2.71191H16.3643C16.5079 2.71184 16.6454 2.65422 16.7471 2.55273L17.1963 2.10352C17.2978 2.00192 17.3553 1.86434 17.3555 1.7207V0.541992C17.3555 0.242493 17.598 7.3847e-05 17.8975 0H24.4053Z" />
    </svg>
  );
}

function messageFromError(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
