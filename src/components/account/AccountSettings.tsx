import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { useState } from "react";
import {
  osAccountsCancelLogin,
  osAccountsLogin,
  osAccountsLogout,
  osAccountsTopUp,
} from "../../lib/tauri";
import type { AccountStatus } from "../../lib/tauri";

type Props = {
  account: AccountStatus;
  loading: boolean;
  onAccountChanged: (next: AccountStatus) => void;
  onRefresh: () => Promise<AccountStatus | undefined>;
};

export function AccountSettings({
  account,
  loading,
  onAccountChanged,
  onRefresh,
}: Props) {
  return (
    <div className="settings-page">
      <header className="settings-header">
        <h1 className="settings-title">Account</h1>
        <p className="settings-description">
          Sign in with OpenSoftware to use your shared identity and balance
          across the network.
        </p>
      </header>

      <AccountSettingsSection
        account={account}
        loading={loading}
        onAccountChanged={onAccountChanged}
        onRefresh={onRefresh}
      />
    </div>
  );
}

export function AccountSettingsSection({
  account,
  loading,
  onAccountChanged,
  onRefresh,
}: Props) {
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accountStatus, setAccountStatus] = useState<string>();
  const [billingStatus, setBillingStatus] = useState<string>();
  const [spins, setSpins] = useState(0);

  async function handleSignIn() {
    setBusy(true);
    setAccountStatus("Opening your browser to sign in…");
    try {
      const next = await osAccountsLogin();
      onAccountChanged(next);
      setAccountStatus(
        next.signedIn ? `Signed in as ${displayName(next)}.` : undefined,
      );
    } catch (error) {
      setAccountStatus(messageFromError(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    // Aborts the waiting os_accounts_login; that promise then rejects with
    // "login_canceled", and handleSignIn's catch/finally resets status + busy.
    try {
      await osAccountsCancelLogin();
    } catch (error) {
      setAccountStatus(messageFromError(error));
    }
  }

  async function handleSignOut() {
    setBusy(true);
    try {
      await osAccountsLogout();
      onAccountChanged({ signedIn: false, configured: account.configured });
      setAccountStatus("Signed out.");
      setBillingStatus(undefined);
    } catch (error) {
      setAccountStatus(messageFromError(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleTopUp() {
    try {
      await osAccountsTopUp();
      setBillingStatus(
        "Opened OS Accounts. Your balance updates after checkout.",
      );
    } catch (error) {
      setBillingStatus(messageFromError(error));
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    setSpins((turns) => turns + 1);
    try {
      await onRefresh();
      setBillingStatus(undefined);
    } catch (error) {
      setBillingStatus(messageFromError(error));
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <>
      <section className="settings-group" aria-labelledby="account-heading">
        <h2 id="account-heading" className="settings-group-heading">
          Account
        </h2>
        {accountStatus ? (
          <p className="settings-status">{accountStatus}</p>
        ) : null}
        <div className="settings-card">
          <div className="settings-rows">
            <div className="settings-row">
              <div className="settings-row-info">
                <h3 className="settings-row-title">
                  {loading
                    ? "Checking sign-in…"
                    : account.signedIn
                      ? displayName(account)
                      : "Not signed in"}
                </h3>
                <p className="settings-row-description">
                  {account.signedIn
                    ? (account.user?.email ??
                      `@${account.user?.handle ?? "account"}`)
                    : account.configured
                      ? "Your login and balance are managed by OpenSoftware."
                      : "OpenSoftware sign-in is not configured for this build."}
                </p>
              </div>
              <div className="settings-row-control">
                {account.signedIn ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={() => void handleTopUp()}
                    >
                      Manage
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy}
                      onClick={() => void handleSignOut()}
                    >
                      Sign out
                    </button>
                  </>
                ) : busy ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => void handleCancel()}
                  >
                    Cancel
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={loading || !account.configured}
                    onClick={() => void handleSignIn()}
                  >
                    Sign in with OpenSoftware
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      {account.signedIn ? (
        <section className="settings-group" aria-labelledby="billing-heading">
          <h2 id="billing-heading" className="settings-group-heading">
            Billing
          </h2>
          <p className="settings-group-description">
            Managed by OpenSoftware. Your balance updates after checkout.
          </p>
          {billingStatus ? (
            <p className="settings-status">{billingStatus}</p>
          ) : null}
          <div className="settings-card">
            <div className="settings-rows">
              <div className="settings-row">
                <div className="settings-row-info">
                  <p className="balance-amount">
                    {formatUsd(account.balance?.usdMillis)}
                  </p>
                  <p className="settings-row-description">Available balance</p>
                </div>
                <div className="settings-row-control">
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Refresh balance"
                    title="Refresh balance"
                    disabled={refreshing}
                    onClick={() => void handleRefresh()}
                  >
                    <IconArrowRotateClockwise
                      size={14}
                      className="balance-refresh-icon"
                      style={{ transform: `rotate(${spins * 360}deg)` }}
                    />
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => void handleTopUp()}
                  >
                    Add funds
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>
      ) : null}
    </>
  );
}

function displayName(account: AccountStatus) {
  return (
    account.user?.displayName ??
    (account.user?.handle ? `@${account.user.handle}` : "Signed in")
  );
}

function formatUsd(usdMillis?: number) {
  return `$${((usdMillis ?? 0) / 1000).toFixed(2)}`;
}

function messageFromError(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
