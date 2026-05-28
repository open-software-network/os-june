import { AccountSettingsSection } from "./AccountSettings";
import type { AccountStatus } from "../../lib/tauri";

type Props = {
  account: AccountStatus;
  loading: boolean;
  onAccountChanged: (next: AccountStatus) => void;
  onRefresh: () => Promise<AccountStatus | undefined>;
};

export function AccountGate({
  account,
  loading,
  onAccountChanged,
  onRefresh,
}: Props) {
  return (
    <section className="account-gate" aria-labelledby="account-gate-heading">
      <div className="account-gate-panel">
        <header className="settings-header account-gate-header">
          <div className="account-gate-brand" aria-label="OS Scribe">
            <img
              className="account-gate-logo light"
              src="/os-scribe-light.svg"
              alt=""
              height={22}
            />
            <img
              className="account-gate-logo dark"
              src="/os-scribe-dark.svg"
              alt=""
              height={22}
            />
          </div>
          <h1 id="account-gate-heading" className="settings-title">
            Sign in to Scribe
          </h1>
          <p className="settings-description">
            Scribe uses your Open Software account for transcription, note
            generation, dictation, and billing.
          </p>
        </header>
        <AccountSettingsSection
          account={account}
          loading={loading}
          onAccountChanged={onAccountChanged}
          onRefresh={onRefresh}
        />
      </div>
    </section>
  );
}
