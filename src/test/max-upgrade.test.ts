import { describe, expect, it, vi } from "vitest";
import { maxGrantLanded, pollForMaxGrant } from "../lib/max-upgrade";
import type { AccountStatus } from "../lib/tauri";

function account(plan: string, credits: number): AccountStatus {
  return {
    signedIn: true,
    configured: true,
    user: { id: "usr_1", handle: "alex" },
    balance: { credits, usdMillis: credits },
    subscription: { subscribed: true, status: "active", plan },
  };
}

describe("maxGrantLanded", () => {
  it("requires the plan to be Max", () => {
    expect(maxGrantLanded(account("pro", 50_000), 4000)).toBe(false);
  });

  it("requires the balance to rise above the pre-upgrade baseline", () => {
    // PATCH done, webhook grant not yet landed: plan is Max, credits stale.
    expect(maxGrantLanded(account("max", 4000), 4000)).toBe(false);
    expect(maxGrantLanded(account("max", 50_000), 4000)).toBe(true);
  });

  it("treats crossing back over zero as landed for depleted accounts", () => {
    // Depleted baseline is negative; any positive balance means the grant hit.
    expect(maxGrantLanded(account("max", -120), -120)).toBe(false);
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
