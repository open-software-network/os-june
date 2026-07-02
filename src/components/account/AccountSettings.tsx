import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { useState } from "react";
import { hasLiveSubscription } from "../../lib/account-gate";
import { errorCode } from "../../lib/errors";
import {
  BILLING_DEMO_FIXTURES,
  BILLING_DEMO_ORDER,
  useForcedBillingPlan,
} from "../../lib/billing-demo";
import {
  osAccountsCancelLogin,
  osAccountsChangePlan,
  osAccountsLogin,
  osAccountsLogout,
  osAccountsOpenPortal,
  osAccountsUpgrade,
} from "../../lib/tauri";
import type { AccountStatus, SubscriptionPlan } from "../../lib/tauri";

const FREE_PLAN_NAME = "Free plan";
const PRO_PLAN_NAME = "Pro plan";
const MAX_PLAN_NAME = "Max plan";
const FREE_PLAN_CREDITS = 2000;

type Props = {
  account: AccountStatus;
  loading: boolean;
  onAccountChanged: (next: AccountStatus) => void;
  onRefresh: () => Promise<AccountStatus | undefined>;
};

export function AccountSettings({ account, loading, onAccountChanged, onRefresh }: Props) {
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
      {account.localDev ? null : <BillingSettingsSection account={account} onRefresh={onRefresh} />}
    </div>
  );
}

export function AccountSettingsSection({ account, loading, onAccountChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [accountStatus, setAccountStatus] = useState<string>();

  async function handleSignIn() {
    setBusy(true);
    setAccountStatus("Opening your browser to sign in…");
    try {
      const next = await osAccountsLogin();
      onAccountChanged(next);
      setAccountStatus(next.signedIn ? `Signed in as ${displayName(next)}.` : undefined);
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
      await osAccountsLogout({ clearBrowserSession: true });
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
      {accountStatus ? <p className="settings-status">{accountStatus}</p> : null}
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
                    ? (account.user?.email ?? `@${account.user?.handle ?? "account"}`)
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
  const demoPlan = useForcedBillingPlan();

  async function handleUpgrade(plan: SubscriptionPlan) {
    try {
      await osAccountsUpgrade(plan);
      setBillingStatus("Opened checkout in your browser.");
    } catch (error) {
      setBillingStatus(messageFromError(error));
    }
  }

  // In-place upgrade for a paid subscriber (Pro -> Max). Unlike checkout, this
  // changes the live subscription, so refresh to reflect the new plan and its
  // freshly granted credits.
  async function handleChangePlan(plan: SubscriptionPlan) {
    const planLabel = plan === "max" ? "Max" : "Pro";
    try {
      await osAccountsChangePlan(plan);
      setBillingStatus(`You are now on ${planLabel}. Your new credits are ready.`);
      await onRefresh();
    } catch (error) {
      const code = errorCode(error);
      if (code === "already_on_plan") {
        // Benign: the snapshot was stale and the subscription is already on
        // the requested plan. Refresh to show the current plan, not an error.
        setBillingStatus(`You are already on ${planLabel}.`);
        await onRefresh();
        return;
      }
      if (code === "subscription_required") {
        // No active subscription server-side: refresh so the card falls back
        // to the subscribe CTAs.
        setBillingStatus(messageFromError(error));
        await onRefresh();
        return;
      }
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

  // __billingDemo(...) parks the card in a fixture state (or "all" stacks every
  // variant) for design work. Every fixture reference is gated on
  // import.meta.env.DEV so the bundler drops BILLING_DEMO_FIXTURES (and the six
  // fixture accounts) from production — demoPlan is always null there anyway,
  // since the console command is never registered. See lib/billing-demo.ts.
  const demoAccount =
    import.meta.env.DEV && demoPlan && demoPlan !== "all"
      ? BILLING_DEMO_FIXTURES[demoPlan].account
      : undefined;
  const cardProps = {
    refreshing,
    spins,
    onRefresh: () => void handleRefresh(),
    onUpgrade: (plan: SubscriptionPlan) => void handleUpgrade(plan),
    onChangePlan: (plan: SubscriptionPlan) => void handleChangePlan(plan),
    onManage: () => void handleManageSubscription(),
  };

  return (
    <section className="settings-group" aria-labelledby="billing-heading">
      <h2 id="billing-heading" className="settings-group-heading">
        Billing
      </h2>
      <p className="settings-group-description">
        Manage usage and subscription details in OpenSoftware.
      </p>
      {billingStatus ? <p className="settings-status">{billingStatus}</p> : null}
      {import.meta.env.DEV && demoPlan === "all" ? (
        <div className="billing-demo-gallery">
          {BILLING_DEMO_ORDER.map((key) => (
            <div className="billing-demo-variant" key={key}>
              <p className="billing-demo-label">{BILLING_DEMO_FIXTURES[key].label}</p>
              <BillingCard account={BILLING_DEMO_FIXTURES[key].account} {...cardProps} />
            </div>
          ))}
        </div>
      ) : (
        <BillingCard account={demoAccount ?? account} {...cardProps} />
      )}
    </section>
  );
}

type BillingCardProps = {
  account: AccountStatus;
  refreshing: boolean;
  spins: number;
  onRefresh: () => void;
  onUpgrade: (plan: SubscriptionPlan) => void;
  onChangePlan: (plan: SubscriptionPlan) => void;
  onManage: () => void;
};

function BillingCard({
  account,
  refreshing,
  spins,
  onRefresh,
  onUpgrade,
  onChangePlan,
  onManage,
}: BillingCardProps) {
  const subscription = account.subscription;
  const liveSubscription = hasLiveSubscription(account);
  const usageRemainingPercent = usagePercentFromBalance(account.balance, subscription);
  const billingRecovery =
    subscription?.subscribed === true &&
    typeof subscription.status === "string" &&
    subscription.status.length > 0 &&
    !liveSubscription;
  // A subscribed account is on the paid plan even when the payload omits a
  // status (partial/older responses) — never relabel it as Free. billingRecovery
  // is a subset of this, kept to drive the "update billing" detail line.
  const onPaidPlan = subscription?.subscribed === true || liveSubscription;
  const canUpgrade = account.signedIn && !onPaidPlan;
  // Warm the meter toward "running low" so green never implies a near-empty
  // allowance. Only meaningful once we have a real signed-in reading.
  const lowUsage = account.signedIn && usageRemainingPercent <= 15;

  // Legacy subscription rows predate plan tiers and carry no slug; they are
  // all Pro, so anything that isn't explicitly "max" reads as Pro.
  const onMaxPlan = onPaidPlan && subscription?.plan === "max";
  const planName = onPaidPlan ? (onMaxPlan ? MAX_PLAN_NAME : PRO_PLAN_NAME) : FREE_PLAN_NAME;
  const planDetail = !onPaidPlan
    ? "No credit card required."
    : billingRecovery
      ? "Update billing in your account portal."
      : liveSubscription && subscription?.status === "trialing"
        ? (describeEnd("Billing starts", subscription.trialEnd) ?? "Free trial")
        : (describeEnd("Renews", subscription?.currentPeriodEnd) ?? "Active");
  const ctas: { label: string; onClick: () => void; title?: string }[] = onPaidPlan
    ? onMaxPlan
      ? [{ label: "Manage billing", onClick: onManage }]
      : // Pro subscribers keep billing management and gain an in-place upgrade
        // to Max (only Max may buy credits); this is their path beyond Pro.
        [
          { label: "Manage billing", onClick: onManage },
          {
            label: "Upgrade to Max",
            onClick: () => onChangePlan("max"),
            title: "For those who want to go beyond Pro",
          },
        ]
    : canUpgrade
      ? [
          { label: "Upgrade to Pro", onClick: () => onUpgrade("pro") },
          {
            label: "Upgrade to Max",
            onClick: () => onUpgrade("max"),
            title: "For those who want to go beyond Pro",
          },
        ]
      : [];

  return (
    <div className="settings-card billing-card">
      <div className="billing-plan">
        <div className="billing-plan-info">
          <h3 className="billing-plan-name">{planName}</h3>
          <p className="billing-plan-detail">{planDetail}</p>
        </div>
        {ctas.length > 0 ? (
          <div className="billing-plan-control">
            {ctas.map((cta) => (
              <button
                key={cta.label}
                type="button"
                className="btn btn-secondary"
                title={cta.title}
                onClick={cta.onClick}
              >
                {cta.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="billing-usage">
        <div className="billing-usage-head">
          <span className="billing-usage-label">Usage remaining</span>
          <span className="billing-usage-right">
            <span className="billing-usage-value">{formatPercent(usageRemainingPercent)}</span>
            <button
              type="button"
              className="icon-button"
              aria-label="Refresh usage"
              title="Refresh usage"
              disabled={refreshing || !account.signedIn}
              onClick={onRefresh}
            >
              <IconArrowRotateClockwise
                size={14}
                className="balance-refresh-icon"
                style={{ transform: `rotate(${spins * 360}deg)` }}
              />
            </button>
          </span>
        </div>
        <div
          className={`usage-remaining-progress${lowUsage ? " is-low" : ""}`}
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
      </div>
    </div>
  );
}

function displayName(account: AccountStatus) {
  return (
    account.user?.displayName ?? (account.user?.handle ? `@${account.user.handle}` : "Signed in")
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
    return clampPercent(((balance?.credits ?? 0) / (subscription?.planCredits ?? 1)) * 100);
  }
  if (subscription?.subscribed === false && Number.isFinite(balance?.credits)) {
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
