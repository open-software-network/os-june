import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { useState } from "react";
import { hasLiveSubscription } from "../../lib/account-gate";
import {
  osAccountsCancelLogin,
  osAccountsLogin,
  osAccountsLogout,
  osAccountsOpenPortal,
  osAccountsUpgrade,
} from "../../lib/tauri";
import type { AccountStatus } from "../../lib/tauri";

const FREE_PLAN_NAME = "Free plan";
const FREE_PLAN_CREDITS = 5000;

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
          {account.localDev
            ? "Local mode is active. June uses your local June API without OpenSoftware sign-in or billing."
            : "Sign in with OpenSoftware to use your shared identity and balance across the network."}
        </p>
      </header>

      <AccountSettingsSection
        account={account}
        loading={loading}
        onAccountChanged={onAccountChanged}
        onRefresh={onRefresh}
      />
      {account.localDev ? null : (
        <BillingSettingsSection account={account} onRefresh={onRefresh} />
      )}
    </div>
  );
}

export function AccountSettingsSection({
  account,
  loading,
  onAccountChanged,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [accountStatus, setAccountStatus] = useState<string>();

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
    } catch (error) {
      setAccountStatus(messageFromError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
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
                {account.localDev
                  ? "Local mode"
                  : loading
                    ? "Checking sign-in..."
                    : account.signedIn
                      ? displayName(account)
                      : "Not signed in"}
              </h3>
              <p className="settings-row-description">
                {account.localDev
                  ? "Requests use your local June API. No OpenSoftware account is used."
                  : account.signedIn
                    ? (account.user?.email ??
                      `@${account.user?.handle ?? "account"}`)
                    : account.configured
                      ? "Your login is managed by OpenSoftware."
                      : "OpenSoftware sign-in is not configured for this build."}
              </p>
            </div>
            <div className="settings-row-control">
              {account.localDev ? null : account.signedIn ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => void handleSignOut()}
                >
                  Sign out
                </button>
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
  );
}

export function BillingSettingsSection({
  account,
  onRefresh,
}: Pick<Props, "account" | "onRefresh">) {
  const [refreshing, setRefreshing] = useState(false);
  const [billingStatus, setBillingStatus] = useState<string>();
  const [spins, setSpins] = useState(0);

  async function handleUpgrade() {
    try {
      await osAccountsUpgrade();
      setBillingStatus("Opened checkout in your browser.");
    } catch (error) {
      setBillingStatus(messageFromError(error));
    }
  }

  async function handleManageSubscription() {
    try {
      await osAccountsOpenPortal();
      setBillingStatus("Opened your account portal in the browser.");
    } catch (error) {
      setBillingStatus(messageFromError(error));
    }
  }

  const subscription = account.subscription;
  const liveSubscription = hasLiveSubscription(account);
  const usagePlanName =
    subscription?.subscribed === true ? "your subscription" : FREE_PLAN_NAME;
  const usageRemainingPercent = usagePercentFromBalance(
    account.balance,
    subscription,
  );
  const billingRecovery =
    subscription?.subscribed === true &&
    typeof subscription.status === "string" &&
    subscription.status.length > 0 &&
    !liveSubscription;
  const subscriptionRow = liveSubscription
    ? {
        title: "Subscription",
        detail:
          subscription?.status === "trialing"
            ? (describeEnd("Billing starts", subscription.trialEnd) ?? "Active")
            : (describeEnd("Renews", subscription?.currentPeriodEnd) ??
              "Active"),
        cta: "Manage billing",
      }
    : billingRecovery
      ? {
          title: "Billing needs attention",
          detail: "Open your account portal to update billing.",
          cta: "Manage billing",
        }
      : undefined;
  const canUpgrade = account.signedIn && !liveSubscription && !billingRecovery;

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
    <section className="settings-group" aria-labelledby="billing-heading">
      <h2 id="billing-heading" className="settings-group-heading">
        Billing
      </h2>
      <p className="settings-group-description">
        Manage usage and subscription details in OpenSoftware.
      </p>
      {billingStatus ? (
        <p className="settings-status">{billingStatus}</p>
      ) : null}
      <div className="settings-card">
        <div className="settings-rows">
          {subscriptionRow ? (
            <div className="settings-row">
              <div className="settings-row-info">
                <h3 className="settings-row-title">{subscriptionRow.title}</h3>
                <p className="settings-row-description">
                  {subscriptionRow.detail}
                </p>
              </div>
              <div className="settings-row-control">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void handleManageSubscription()}
                >
                  {subscriptionRow.cta}
                </button>
              </div>
            </div>
          ) : null}
          <div className="settings-row billing-usage-row">
            <div className="settings-row-info">
              <p className="usage-remaining-amount">
                {formatPercent(usageRemainingPercent)} remaining
              </p>
              <div
                className="usage-remaining-progress"
                role="progressbar"
                aria-label="Usage remaining"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={usageRemainingPercent}
              >
                <div
                  className="usage-remaining-progress-fill"
                  style={{
                    transform: `scaleX(${usageRemainingPercent / 100})`,
                  }}
                />
              </div>
              <div>
                <p className="settings-row-description">
                  Usage remaining on {usagePlanName}
                </p>
              </div>
            </div>
            <div className="settings-row-control">
              <button
                type="button"
                className="icon-button"
                aria-label="Refresh usage"
                title="Refresh usage"
                disabled={refreshing || !account.signedIn}
                onClick={() => void handleRefresh()}
              >
                <IconArrowRotateClockwise
                  size={14}
                  className="balance-refresh-icon"
                  style={{ transform: `rotate(${spins * 360}deg)` }}
                />
              </button>
              {canUpgrade ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void handleUpgrade()}
                >
                  Upgrade
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function displayName(account: AccountStatus) {
  return (
    account.user?.displayName ??
    (account.user?.handle ? `@${account.user.handle}` : "Signed in")
  );
}

function formatPercent(percent: number) {
  return `${clampPercent(percent)}%`;
}

function clampPercent(percent: number) {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

function usagePercentFromBalance(
  balance: AccountStatus["balance"],
  subscription: AccountStatus["subscription"],
) {
  if (Number.isFinite(balance?.usageRemainingPercent)) {
    return clampPercent(balance?.usageRemainingPercent ?? 0);
  }
  if (
    Number.isFinite(balance?.credits) &&
    Number.isFinite(subscription?.planCredits) &&
    (subscription?.planCredits ?? 0) > 0
  ) {
    return clampPercent(
      ((balance?.credits ?? 0) / (subscription?.planCredits ?? 1)) * 100,
    );
  }
  if (
    subscription?.subscribed === false &&
    Number.isFinite(balance?.credits)
  ) {
    return clampPercent(((balance?.credits ?? 0) / FREE_PLAN_CREDITS) * 100);
  }
  if (Number.isFinite(balance?.usdMillis)) {
    return (balance?.usdMillis ?? 0) > 0 ? 100 : 0;
  }
  return 0;
}

/** "Ends June 24" from an accounts-API timestamp, or undefined when the
 * date is missing or unparseable so callers can fall back to plain copy. */
function describeEnd(verb: string, timestamp?: string) {
  if (!timestamp) return undefined;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return undefined;
  // Annual plans renew up to a year out: include the year whenever the date
  // isn't in the current calendar year, so "Renews March 15" can't mean
  // either 3 or 15 months away.
  const showYear = date.getFullYear() !== new Date().getFullYear();
  const formatted = new Intl.DateTimeFormat(undefined, {
    month: "long",
    day: "numeric",
    ...(showYear ? { year: "numeric" } : {}),
  }).format(date);
  return `${verb} ${formatted}`;
}

function messageFromError(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
