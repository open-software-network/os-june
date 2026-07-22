import type { AccountStatus } from "../lib/tauri";
import { type MaxUpgradeTransport } from "../lib/billing-actions";
import type { MaxGrantWait } from "../lib/max-upgrade";
import type * as React from "react";

export type UseAccountActionsDependencies = {
  account: AccountStatus;
  appMaxGrantWaitRef: React.MutableRefObject<MaxGrantWait | undefined>;
  billingNoticeTimerRef: React.MutableRefObject<number | undefined>;
  maxUpgradePrompt: {
    action: "upgrade_to_max";
    plan: "max";
    transport: MaxUpgradeTransport;
  } | null;
  refreshAccount: () => Promise<AccountStatus | undefined>;
  setBillingNotice: React.Dispatch<React.SetStateAction<string | null>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setMaxUpgradeError: React.Dispatch<React.SetStateAction<string | undefined>>;
  setMaxUpgradePrompt: React.Dispatch<
    React.SetStateAction<{
      action: "upgrade_to_max";
      plan: "max";
      transport: MaxUpgradeTransport;
    } | null>
  >;
  showBillingNotice: (notice: string, autoClearMs?: number) => void;
};
