import { IconWallet3 } from "central-icons/IconWallet3";
import type { AccountStatus } from "../../lib/tauri";

// Mirrors scribe-api's flat metered estimate. Users below this floor can pass
// the subscription gates but still fail when dictation, recording processing,
// or agent work attempts to reserve credits.
export const METERED_USAGE_CREDIT_FLOOR = 250;

type Props = {
  account: AccountStatus;
  onTopUp: () => void;
};

export function CreditBalanceBanner({ account, onTopUp }: Props) {
  if (!shouldShowLowCreditBanner(account)) return null;

  return (
    <section
      className="message-card credit-balance-banner"
      role="alert"
      aria-label="Low credit balance"
    >
      <p className="credit-balance-banner-message">
        <span className="credit-balance-banner-eyebrow">
          <IconWallet3 size={14} aria-hidden />
          Low balance
        </span>
        <span className="credit-balance-banner-body">
          Your balance is below the amount needed to start dictation,
          recordings, or agent work.
        </span>
      </p>
      <div className="credit-balance-banner-actions">
        <button type="button" className="btn btn-ghost" onClick={onTopUp}>
          Add funds
        </button>
      </div>
    </section>
  );
}

export function shouldShowLowCreditBanner(account: AccountStatus) {
  if (!hasMeteredAccess(account)) return false;
  const creditBalance = accountCreditBalance(account);
  return (
    creditBalance !== undefined &&
    Number.isFinite(creditBalance) &&
    creditBalance < METERED_USAGE_CREDIT_FLOOR
  );
}

export function accountCreditBalance(account: AccountStatus) {
  return account.balance?.credits ?? account.balance?.usdMillis;
}

function hasMeteredAccess(account: AccountStatus) {
  const status = account.subscription?.status;
  return (
    account.signedIn &&
    account.subscription?.subscribed === true &&
    (status === "trialing" || status === "active")
  );
}
