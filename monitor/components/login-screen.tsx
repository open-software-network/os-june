import { IconArrowUpRight, IconLock } from "central-icons";
import { Brand } from "@/components/brand";

export function LoginScreen({ authMessage }: { authMessage?: string }) {
  const message = getMessage(authMessage);
  return (
    <main className="auth-shell">
      <div className="auth-topbar">
        <Brand />
        <span className="private-label">
          <IconLock size={15} ariaHidden />
          Private monitor
        </span>
      </div>
      <section className="auth-card">
        <div className="auth-orbit" aria-hidden="true">
          <span className="orbit-ring" />
          <span className="orbit-core">OS</span>
          <span className="orbit-dot orbit-dot-one" />
          <span className="orbit-dot orbit-dot-two" />
        </div>
        <p className="eyebrow">Production infrastructure</p>
        <h1>Health, without the noise.</h1>
        <p className="auth-copy">
          One view of production availability across Open Software services and product APIs.
        </p>
        {message ? <p className="auth-message">{message}</p> : null}
        <a className="primary-button" href="/auth/start">
          Continue with OS Accounts
          <IconArrowUpRight size={18} ariaHidden />
        </a>
        <p className="auth-footnote">Access is limited to approved OS Accounts user ids.</p>
      </section>
      <p className="auth-footer">Open Software internal systems</p>
    </main>
  );
}

function getMessage(authMessage?: string): string | null {
  if (authMessage === "failed") return "Sign-in could not be completed. Please try again.";
  if (authMessage === "expired") return "Your session expired. Sign in again to continue.";
  if (authMessage === "configuration") return "OS Accounts login is not configured for this monitor.";
  return null;
}
