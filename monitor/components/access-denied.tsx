import { IconCircleBanSign, IconDoor } from "central-icons";
import { Brand } from "@/components/brand";
import type { AccountUser } from "@/lib/auth/session";

export function AccessDenied({ user }: { user: AccountUser }) {
  return (
    <main className="auth-shell">
      <div className="auth-topbar">
        <Brand />
      </div>
      <section className="auth-card denied-card">
        <div className="denied-icon">
          <IconCircleBanSign size={28} ariaHidden />
        </div>
        <p className="eyebrow">Access restricted</p>
        <h1>This account is not approved.</h1>
        <p className="auth-copy">
          You signed in successfully, but your OS Accounts user id is not on this monitor's allowlist.
        </p>
        <div className="identity-detail">
          <span>Signed in as</span>
          <strong>{user.handle}</strong>
          <code>{user.id}</code>
        </div>
        <form action="/auth/logout" method="post">
          <button className="secondary-button" type="submit">
            <IconDoor size={17} ariaHidden />
            Sign out
          </button>
        </form>
      </section>
    </main>
  );
}
