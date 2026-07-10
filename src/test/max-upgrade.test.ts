import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_GRANT_HOSTED_POLL_TIMEOUT_MS,
  MAX_GRANT_POLL_TIMEOUT_MS,
  MAX_UPGRADE_BROWSER_STATUS,
  MAX_UPGRADE_BUSY_LABEL,
  MAX_UPGRADE_CHARGE_CONFIRM_BODY,
  MAX_UPGRADE_CONFIRM_BODY,
  MAX_UPGRADE_CONFIRM_LABEL,
  MAX_UPGRADE_HOSTED_SLOW_STATUS,
  MAX_UPGRADE_PORTAL_LABEL,
  MAX_UPGRADE_READY_STATUS,
  MAX_UPGRADE_SLOW_STATUS,
  MAX_UPGRADE_STALE_ACTION_NOTICE,
  MAX_UPGRADE_WAITING_STATUS,
  accountLooksPreGrant,
  beginMaxGrantWait,
  clearMaxGrantWait,
  currentMaxGrantWait,
  isHostedMaxUpgradeFallbackError,
  markMaxGrantWaitSlow,
  maxGrantWaitForAccount,
  maxGrantLanded,
  maxUpgradeSlowStatus,
  pollForMaxGrant,
} from "../lib/max-upgrade";
import type { AccountStatus } from "../lib/tauri";

beforeEach(() => clearMaxGrantWait());

function account(plan: string, credits: number): AccountStatus {
  return {
    signedIn: true,
    configured: true,
    user: { id: "usr_1", handle: "alex" },
    balance: { credits, usdMillis: credits },
    subscription: { subscribed: true, status: "active", plan },
  };
}

describe("Max upgrade copy", () => {
  it("describes the secure browser confirmation without announcing Max before the grant", () => {
    expect(MAX_UPGRADE_CONFIRM_BODY).toContain("secure Stripe page");
    expect(MAX_UPGRADE_CONFIRM_BODY).toContain("review and confirm the prorated charge");
    expect(MAX_UPGRADE_CONFIRM_LABEL).toBe("Upgrade now");
    expect(MAX_UPGRADE_BUSY_LABEL).toBe("Upgrading...");
    expect(MAX_UPGRADE_BROWSER_STATUS).toBe("Waiting for you to confirm in the browser");
    expect(MAX_UPGRADE_WAITING_STATUS).toBe("Upgrade started. Waiting for payment confirmation.");
    expect(MAX_UPGRADE_WAITING_STATUS).not.toContain("Max is active");
    expect(MAX_UPGRADE_SLOW_STATUS).not.toContain("Max is active");
    expect(MAX_UPGRADE_SLOW_STATUS).toContain("Payment not confirmed yet");
    expect(MAX_UPGRADE_PORTAL_LABEL).toBe("Open billing");
    expect(MAX_UPGRADE_READY_STATUS).toBe("Max is active.");
    expect(MAX_UPGRADE_STALE_ACTION_NOTICE).toBe("Your plan changed - pick an option again");
  });

  it("states the immediate saved-card charge in the PATCH consent copy", () => {
    // The charge-now copy is the consent for the PATCH transport; it must
    // say the card is charged immediately and never promise a Stripe review.
    expect(MAX_UPGRADE_CHARGE_CONFIRM_BODY).toContain("charged to your saved card now");
    expect(MAX_UPGRADE_CHARGE_CONFIRM_BODY).not.toContain("Stripe page");
  });

  it("keeps the hosted slow copy non-terminal with a retry pointer", () => {
    // Outlasting the hosted poll window usually means the user is still on
    // (or abandoned) the Stripe page - not that payment failed.
    expect(MAX_UPGRADE_HOSTED_SLOW_STATUS).toBe(
      "Still waiting for payment confirmation. If you closed the Stripe page, you can try again.",
    );
    expect(MAX_UPGRADE_HOSTED_SLOW_STATUS).not.toContain("not confirmed");
    expect(MAX_UPGRADE_HOSTED_SLOW_STATUS).not.toContain("Max is active");
  });

  it("gives the hosted round trip a much longer poll window than the webhook wait", () => {
    expect(MAX_GRANT_HOSTED_POLL_TIMEOUT_MS).toBe(300_000);
    expect(MAX_GRANT_HOSTED_POLL_TIMEOUT_MS).toBeGreaterThan(MAX_GRANT_POLL_TIMEOUT_MS);
  });
});

describe("hosted Max upgrade fallback", () => {
  it.each([
    "upgrade_session_unavailable",
    "plan_not_enabled",
  ])("treats %s as a definitive capability signal", (code) => {
    expect(isHostedMaxUpgradeFallbackError({ code })).toBe(true);
  });

  it.each([
    // Transient failures are ordinary retryable errors, never license to
    // switch transports: a PATCH after one would charge the saved card under
    // hosted-review consent the user never gave.
    "network_error",
    "auth_refresh_unavailable",
    "empty_response",
    "already_on_plan",
    "subscription_required",
    "unknown_plan",
    "browser_open_failed",
  ])("does not fall back for %s", (code) => {
    expect(isHostedMaxUpgradeFallbackError({ code })).toBe(false);
  });
});

describe("maxUpgradeSlowStatus", () => {
  it("picks the non-terminal copy for hosted waits and the portal copy for PATCH waits", () => {
    const hostedWait = beginMaxGrantWait(1200, "usr_1", "browser");
    expect(hostedWait.hosted).toBe(true);
    expect(maxUpgradeSlowStatus(hostedWait)).toBe(MAX_UPGRADE_HOSTED_SLOW_STATUS);

    const patchWait = beginMaxGrantWait(1200, "usr_1", "waiting");
    expect(patchWait.hosted).toBe(false);
    expect(maxUpgradeSlowStatus(patchWait)).toBe(MAX_UPGRADE_SLOW_STATUS);
  });

  it("keeps the hosted flag through the browser -> waiting phase transition", () => {
    const wait = beginMaxGrantWait(1200, "usr_1", "browser");
    markMaxGrantWaitSlow(wait);
    expect(wait.hosted).toBe(true);
    expect(maxUpgradeSlowStatus(wait)).toBe(MAX_UPGRADE_HOSTED_SLOW_STATUS);
  });
});

describe("accountLooksPreGrant", () => {
  it("treats a failed refresh as still pending so the poll can recover", () => {
    expect(accountLooksPreGrant(undefined, -120)).toBe(true);
  });

  it("treats a plan that has not flipped to Max as still pending", () => {
    expect(accountLooksPreGrant(account("pro", -120), -120)).toBe(true);
  });

  it("treats unmoved credits on Max as still pending (the grant webhook is coming)", () => {
    expect(accountLooksPreGrant(account("max", -120), -120)).toBe(true);
  });

  it("treats any credits movement on Max as settled so the surface re-derives", () => {
    // A long-settled Max account's balance has nothing to do with the stale
    // baseline; a poll anchored to that baseline could never succeed.
    expect(accountLooksPreGrant(account("max", -800), -120)).toBe(false);
    expect(accountLooksPreGrant(account("max", 50_000), -120)).toBe(false);
  });

  it("treats a Max snapshot without a credits reading as settled - a poll could never see it rise", () => {
    expect(
      accountLooksPreGrant(
        {
          signedIn: true,
          configured: true,
          subscription: { subscribed: true, status: "active", plan: "max" },
        },
        -120,
      ),
    ).toBe(false);
  });
});

describe("shared Max grant wait", () => {
  it("preserves waiting and timeout phases across upgrade surfaces", () => {
    const wait = beginMaxGrantWait(1200, "usr_1");

    expect(currentMaxGrantWait()).toBe(wait);
    expect(maxGrantWaitForAccount("usr_1")).toBe(wait);
    expect(maxGrantWaitForAccount("usr_2")).toBeUndefined();
    expect(currentMaxGrantWait()).toMatchObject({
      accountId: "usr_1",
      baselineCredits: 1200,
      phase: "waiting",
    });

    markMaxGrantWaitSlow(wait);
    expect(currentMaxGrantWait()).toMatchObject({
      accountId: "usr_1",
      baselineCredits: 1200,
      phase: "slow",
    });

    clearMaxGrantWait(wait);
    expect(currentMaxGrantWait()).toBeUndefined();
  });
});

describe("maxGrantLanded", () => {
  it("requires the plan to be Max", () => {
    expect(maxGrantLanded(account("pro", 50_000), 4000)).toBe(false);
  });

  it("requires the balance to rise above the pre-upgrade baseline", () => {
    // PATCH done, webhook grant not yet landed: plan is Max, credits stale.
    expect(maxGrantLanded(account("max", 4000), 4000)).toBe(false);
    expect(maxGrantLanded(account("max", 50_000), 4000)).toBe(true);
  });

  it("detects a grant even when a depleted credit balance remains negative", () => {
    expect(maxGrantLanded(account("max", -120), -120)).toBe(false);
    expect(maxGrantLanded(account("max", -20), -120)).toBe(true);
    expect(maxGrantLanded(account("max", 49_880), -120)).toBe(true);
  });

  it("is false without a snapshot or credits reading", () => {
    expect(maxGrantLanded(undefined, 0)).toBe(false);
    expect(
      maxGrantLanded(
        {
          signedIn: true,
          configured: true,
          subscription: { subscribed: true, status: "active", plan: "max" },
        },
        0,
      ),
    ).toBe(false);
  });
});

describe("pollForMaxGrant", () => {
  it("polls staged snapshots until the grant lands", async () => {
    const refresh = vi
      .fn<() => Promise<AccountStatus | undefined>>()
      // PATCH returned, plan flipped, credits still stale...
      .mockResolvedValueOnce(account("max", -120))
      .mockResolvedValueOnce(account("max", -120))
      // ...then the webhook grant lands.
      .mockResolvedValue(account("max", 49_880));

    const landed = await pollForMaxGrant(refresh, -120, { intervalMs: 5, timeoutMs: 1000 });

    expect(landed).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("resolves immediately when the first refresh already shows the grant", async () => {
    const refresh = vi
      .fn<() => Promise<AccountStatus | undefined>>()
      .mockResolvedValue(account("max", 50_000));

    const landed = await pollForMaxGrant(refresh, 4000, { intervalMs: 5, timeoutMs: 1000 });

    expect(landed).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("gives up after the timeout and stops polling", async () => {
    const refresh = vi
      .fn<() => Promise<AccountStatus | undefined>>()
      .mockResolvedValue(account("max", -120));

    const landed = await pollForMaxGrant(refresh, -120, { intervalMs: 10, timeoutMs: 45 });

    expect(landed).toBe(false);
    // Bounded: interval 10ms with a 45ms budget can fit at most a handful of
    // polls; the point is it stopped rather than looping forever.
    const calls = refresh.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(calls).toBeLessThanOrEqual(6);
    const callsAfterReturn = refresh.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(refresh.mock.calls.length).toBe(callsAfterReturn);
  });

  it("keeps polling past refreshes that fail to resolve a snapshot", async () => {
    const refresh = vi
      .fn<() => Promise<AccountStatus | undefined>>()
      // A transient refresh failure surfaces as undefined, not a throw.
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(account("max", 50_000));

    const landed = await pollForMaxGrant(refresh, 0, { intervalMs: 5, timeoutMs: 1000 });

    expect(landed).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("keeps polling through a refresh that rejects, then completes on the grant", async () => {
    const refresh = vi
      .fn<() => Promise<AccountStatus | undefined>>()
      // A refresh that throws (instead of resolving undefined) is a
      // transient miss, not a reason to abort the poll.
      .mockRejectedValueOnce(new Error("network wobble"))
      .mockResolvedValue(account("max", 50_000));
    const cleanup = vi.fn();

    const landed = await pollForMaxGrant(refresh, 0, { intervalMs: 5, timeoutMs: 1000 }).then(
      (result) => {
        cleanup();
        return result;
      },
    );

    expect(landed).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(2);
    // The caller's cleanup chain ran; nothing rejected.
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("always resolves so caller cleanup runs even when every refresh rejects", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      const refresh = vi
        .fn<() => Promise<AccountStatus | undefined>>()
        .mockRejectedValue(new Error("accounts unreachable"));
      const cleanup = vi.fn();

      // Mirrors the component chains (.then(() => setAwaitingGrant(false))):
      // a rejection here would pin the waiting panels forever.
      const landed = await pollForMaxGrant(refresh, 0, { intervalMs: 5, timeoutMs: 30 }).then(
        (result) => {
          cleanup();
          return result;
        },
      );

      expect(landed).toBe(false);
      expect(cleanup).toHaveBeenCalledOnce();
      expect(refresh.mock.calls.length).toBeGreaterThanOrEqual(2);
      // Persistent failure leaves a debug trail instead of a rejection.
      expect(debug).toHaveBeenCalled();
    } finally {
      debug.mockRestore();
    }
  });

  it("issues refreshes strictly one at a time, never in parallel", async () => {
    // The poll is the single refresh path after an upgrade; overlapping
    // requests could resolve out of order and let a stale pre-grant snapshot
    // overwrite a fresh Max one. Serialized awaits make that impossible.
    let inFlight = 0;
    let maxInFlight = 0;
    let call = 0;
    const refresh = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      call += 1;
      return call >= 3 ? account("max", 50_000) : account("max", -120);
    });

    const landed = await pollForMaxGrant(refresh, -120, { intervalMs: 5, timeoutMs: 1000 });

    expect(landed).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(1);
  });
});
