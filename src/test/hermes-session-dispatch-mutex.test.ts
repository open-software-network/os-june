import { describe, expect, it, vi } from "vitest";
import {
  reserveHermesSessionDispatch,
  reserveHermesSessionTransportHandoff,
  withHermesSessionDispatchLock,
} from "../lib/hermes-session-dispatch-mutex";

function deferred<Value>() {
  let resolve: (value: Value) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

describe("Hermes session dispatch mutex", () => {
  it("serializes dispatches for the same session", async () => {
    const firstDispatch = deferred<string>();
    const secondDispatch = deferred<string>();
    const events: string[] = [];

    const first = withHermesSessionDispatchLock("session-a", async () => {
      events.push("first started");
      const result = await firstDispatch.promise;
      events.push("first finished");
      return result;
    });
    const secondCallback = vi.fn(async () => {
      events.push("second started");
      return secondDispatch.promise;
    });
    const second = withHermesSessionDispatchLock("session-a", secondCallback);

    await vi.waitFor(() => expect(events).toEqual(["first started"]));
    expect(secondCallback).not.toHaveBeenCalled();

    firstDispatch.resolve("first result");
    await expect(first).resolves.toBe("first result");
    await vi.waitFor(() => expect(secondCallback).toHaveBeenCalledOnce());
    expect(events).toEqual(["first started", "first finished", "second started"]);

    secondDispatch.resolve("second result");
    await expect(second).resolves.toBe("second result");
  });

  it("allows different sessions to dispatch concurrently", async () => {
    const firstDispatch = deferred<void>();
    const secondDispatch = deferred<void>();
    const firstCallback = vi.fn(() => firstDispatch.promise);
    const secondCallback = vi.fn(() => secondDispatch.promise);

    const first = withHermesSessionDispatchLock("session-a", firstCallback);
    const second = withHermesSessionDispatchLock("session-b", secondCallback);

    await vi.waitFor(() => {
      expect(firstCallback).toHaveBeenCalledOnce();
      expect(secondCallback).toHaveBeenCalledOnce();
    });

    firstDispatch.resolve();
    secondDispatch.resolve();
    await Promise.all([first, second]);
  });

  it("releases the session after a dispatch fails", async () => {
    const firstDispatch = deferred<void>();
    const secondCallback = vi.fn(async () => "accepted");
    const failure = new Error("prompt rejected");

    const first = withHermesSessionDispatchLock("session-a", () => firstDispatch.promise);
    const second = withHermesSessionDispatchLock("session-a", secondCallback);

    firstDispatch.reject(failure);
    await expect(first).rejects.toBe(failure);
    await expect(second).resolves.toBe("accepted");
    expect(secondCallback).toHaveBeenCalledOnce();
  });

  it("preserves Send-time order when later preparation finishes first", async () => {
    const firstPreparation = deferred<void>();
    const events: string[] = [];
    const firstReservation = reserveHermesSessionDispatch("session-a");
    const secondReservation = reserveHermesSessionDispatch("session-a");

    expect(firstReservation.queuedBehindPrior).toBe(false);
    expect(secondReservation.queuedBehindPrior).toBe(true);

    const first = (async () => {
      await firstPreparation.promise;
      return firstReservation.run(async () => {
        events.push("first");
        return "first result";
      });
    })();
    const second = secondReservation.run(async () => {
      events.push("second");
      return "second result";
    });

    await Promise.resolve();
    expect(events).toEqual([]);
    firstPreparation.resolve();

    await expect(first).resolves.toBe("first result");
    await expect(second).resolves.toBe("second result");
    expect(events).toEqual(["first", "second"]);
  });

  it("keeps later reservations ordered when an earlier preparation is cancelled", async () => {
    const firstDispatch = deferred<void>();
    const events: string[] = [];
    const firstReservation = reserveHermesSessionDispatch("session-a");
    const cancelledReservation = reserveHermesSessionDispatch("session-a");
    const thirdReservation = reserveHermesSessionDispatch("session-a");

    const first = firstReservation.run(async () => {
      events.push("first started");
      await firstDispatch.promise;
      events.push("first finished");
    });
    cancelledReservation.cancel();
    const third = thirdReservation.run(async () => {
      events.push("third");
    });

    await vi.waitFor(() => expect(events).toEqual(["first started"]));
    firstDispatch.resolve();
    await Promise.all([first, third]);
    expect(events).toEqual(["first started", "first finished", "third"]);
  });

  it("lets a transport handoff gate an already-reserved dormant dispatch", async () => {
    const handoffSettled = deferred<void>();
    const events: string[] = [];
    const dormantDispatch = reserveHermesSessionDispatch("session-a");
    const handoff = reserveHermesSessionTransportHandoff("session-a");

    const handoffRun = handoff.run(async () => {
      events.push("handoff started");
      await handoffSettled.promise;
      events.push("handoff finished");
    });
    const dormantRun = dormantDispatch.run(async () => {
      events.push("dispatch started");
    });

    await vi.waitFor(() => expect(events).toEqual(["handoff started"]));
    handoffSettled.resolve();
    await Promise.all([handoffRun, dormantRun]);
    expect(events).toEqual(["handoff started", "handoff finished", "dispatch started"]);
  });
});
