// Dev-only console driver for the out-of-credits surfaces (FundingNotice
// above the composers, FundingChip in the sidebar footer).
//
//   window.__fundingDemo("free")     starter credits used up -> subscribe
//   window.__fundingDemo("pro")      depleted Pro -> in-place Max upgrade
//   window.__fundingDemo("max")      depleted Max -> top up via portal
//   window.__fundingDemo("billing")  past-due subscription -> manage billing
//   window.__fundingDemo("off")      back to the real account snapshot
//
// The surfaces derive everything from the account snapshot, so the driver
// swaps a synthetic snapshot into App's funding override state; the real
// account state is untouched and comes back on "off". Never bundled in
// production: App gates the dynamic import on import.meta.env.DEV.

import type { AccountStatus } from "./tauri";

export type FundingDemoBranch = "free" | "pro" | "max" | "billing";

export type FundingDemoApi = {
  /** Remove the window hook and restore the real account snapshot. */
  dispose: () => void;
};

const HELP = [
  "Out-of-credits surfaces demo:",
  '  __fundingDemo("free")     starter credits used up (subscribe prompt)',
  '  __fundingDemo("pro")      depleted Pro (in-place Max upgrade + confirm)',
  '  __fundingDemo("max")      depleted Max (top up via the account portal)',
  '  __fundingDemo("billing")  past-due subscription (manage billing)',
  '  __fundingDemo("stopped")  mid-turn depletion: the in-transcript stopped-turn',
  "                            card (opens the agent error gallery; combine with a",
  '                            branch, e.g. __fundingDemo("pro") first, to pick the',
  "                            tier card it wears)",
  '  __fundingDemo("off")      back to the real account',
  "",
  "Shows the composer notice, sidebar chip, and note-editor notice on any view. Dev only.",
].join("\n");

const BASE: Pick<AccountStatus, "signedIn" | "configured" | "user"> = {
  signedIn: true,
  configured: true,
  user: { id: "usr_demo", handle: "demo" },
};

const DEMO_ACCOUNTS: Record<FundingDemoBranch, AccountStatus> = {
  free: {
    ...BASE,
    subscription: { subscribed: false },
    balance: { credits: 0, usdMillis: 0 },
  },
  pro: {
    ...BASE,
    subscription: { subscribed: true, status: "active", plan: "pro" },
    balance: { credits: -3, usdMillis: 0 },
  },
  max: {
    ...BASE,
    subscription: { subscribed: true, status: "active", plan: "max" },
    balance: { credits: -3, usdMillis: 0 },
  },
  billing: {
    ...BASE,
    subscription: { subscribed: true, status: "past_due", plan: "pro" },
    balance: { credits: 0, usdMillis: 0 },
  },
};

export function registerFundingDemo({
  setOverride,
}: {
  setOverride: (account: AccountStatus | null) => void;
}): FundingDemoApi {
  // The stopped-turn card is a transcript part, so it can't be forced from
  // an account snapshot; the agent error gallery (__agentErrors, registered
  // by AgentWorkspace's module scope) already renders it. Track whether this
  // demo opened the gallery so "off" closes it again.
  let openedGallery = false;
  function agentErrors(): ((show: boolean) => string) | undefined {
    return (window as { __agentErrors?: (show: boolean) => string }).__agentErrors;
  }

  function drive(branch?: FundingDemoBranch | "stopped" | "off") {
    if (branch === undefined) return HELP;
    if (branch === "off") {
      setOverride(null);
      if (openedGallery) {
        openedGallery = false;
        agentErrors()?.(false);
      }
      return "funding demo off";
    }
    if (branch === "stopped") {
      const show = agentErrors();
      if (!show) return "Agent gallery unavailable; open the chat view once, then retry.";
      openedGallery = true;
      show(true);
      return 'Showing the stopped-turn credits card in the agent error gallery ("Out of credits" section). __fundingDemo("off") hides it.';
    }
    const preset = DEMO_ACCOUNTS[branch];
    if (!preset) return HELP;
    setOverride(preset);
    return `funding demo: ${branch}`;
  }

  (window as unknown as { __fundingDemo?: typeof drive }).__fundingDemo = drive;
  return {
    dispose: () => {
      delete (window as unknown as { __fundingDemo?: typeof drive }).__fundingDemo;
      setOverride(null);
      if (openedGallery) agentErrors()?.(false);
    },
  };
}
