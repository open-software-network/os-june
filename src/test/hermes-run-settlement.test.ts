import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type HermesActiveSessionRow,
  watchHermesRunSettlement,
} from "../lib/hermes-run-settlement";

function snapshotSource() {
  const observers = new Set<(rows: readonly HermesActiveSessionRow[] | undefined) => void>();
  const observeActiveSessions = vi.fn(
    (observer: (rows: readonly HermesActiveSessionRow[] | undefined) => void) => {
      observers.add(observer);
      return () => observers.delete(observer);
    },
  );
  return {
    emit(rows: readonly HermesActiveSessionRow[] | undefined) {
      for (const observer of [...observers]) observer(rows);
    },
    observeActiveSessions,
    observers,
  };
}

describe("Hermes run settlement", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("settles after two reachable idle observations", () => {
    const source = snapshotSource();
    const onSettled = vi.fn();

    watchHermesRunSettlement({
      storedSessionId: "stored-1",
      observeActiveSessions: source.observeActiveSessions,
      onSettled,
      timeoutMs: 100,
    });

    source.emit([]);
    expect(onSettled).not.toHaveBeenCalled();
    source.emit([]);
    expect(onSettled).toHaveBeenCalledOnce();
    expect(source.observers).toHaveLength(0);
  });

  it("requires consecutive idle observations and ignores unrelated busy sessions", () => {
    const source = snapshotSource();
    const onSettled = vi.fn();

    watchHermesRunSettlement({
      storedSessionId: "stored-1",
      observeActiveSessions: source.observeActiveSessions,
      onSettled,
      timeoutMs: 100,
    });

    source.emit([]);
    source.emit([{ session_key: "stored-1", status: "working" }]);
    source.emit([{ session_key: "someone-else", status: "working" }]);
    expect(onSettled).not.toHaveBeenCalled();
    source.emit([{ session_key: "stored-1", status: "idle" }]);

    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("treats a non-idle runtime-id match as busy", () => {
    const source = snapshotSource();
    const onSettled = vi.fn();

    watchHermesRunSettlement({
      storedSessionId: "stored-1",
      runtimeSessionId: "runtime-1",
      observeActiveSessions: source.observeActiveSessions,
      onSettled,
      timeoutMs: 100,
    });

    source.emit([{ id: "runtime-1", status: "working" }]);
    source.emit([{ id: "runtime-1", status: "idle" }]);
    expect(onSettled).not.toHaveBeenCalled();
    source.emit([{ id: "runtime-1", status: "idle" }]);
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("ignores unreachable observations and stops at the timeout", async () => {
    const source = snapshotSource();
    const onSettled = vi.fn();

    watchHermesRunSettlement({
      storedSessionId: "stored-timeout",
      observeActiveSessions: source.observeActiveSessions,
      onSettled,
      timeoutMs: 25,
    });

    source.emit(undefined);
    source.emit(undefined);
    await vi.advanceTimersByTimeAsync(100);

    expect(onSettled).not.toHaveBeenCalled();
    expect(source.observers).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resets an idle streak when a snapshot is unreachable", () => {
    const source = snapshotSource();
    const onSettled = vi.fn();

    watchHermesRunSettlement({
      storedSessionId: "stored-retry",
      observeActiveSessions: source.observeActiveSessions,
      onSettled,
      timeoutMs: 100,
    });

    source.emit([]);
    source.emit(undefined);
    source.emit([]);
    expect(onSettled).not.toHaveBeenCalled();
    source.emit([]);
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("coalesces a duplicate watch and keeps the first callback", () => {
    const source = snapshotSource();
    const secondSource = snapshotSource();
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    const firstHandle = watchHermesRunSettlement({
      storedSessionId: "stored-shared",
      observeActiveSessions: source.observeActiveSessions,
      onSettled: firstCallback,
      timeoutMs: 100,
    });
    const secondHandle = watchHermesRunSettlement({
      storedSessionId: "stored-shared",
      runtimeSessionId: "runtime-from-second-call",
      observeActiveSessions: secondSource.observeActiveSessions,
      onSettled: secondCallback,
      timeoutMs: 2,
    });

    expect(secondHandle).toBe(firstHandle);
    source.emit([{ id: "runtime-from-second-call", status: "working" }]);
    source.emit([]);
    source.emit([{ id: "runtime-from-second-call", status: "working" }]);

    expect(firstCallback).not.toHaveBeenCalled();
    expect(secondCallback).not.toHaveBeenCalled();
    expect(source.observeActiveSessions).toHaveBeenCalledOnce();
    expect(secondSource.observeActiveSessions).not.toHaveBeenCalled();
  });

  it("cancels an active watch and unsubscribes it", async () => {
    const source = snapshotSource();
    const onSettled = vi.fn();
    const handle = watchHermesRunSettlement({
      storedSessionId: "stored-cancelled",
      observeActiveSessions: source.observeActiveSessions,
      onSettled,
      timeoutMs: 100,
    });

    handle.cancel();
    source.emit([]);
    source.emit([]);
    await vi.advanceTimersByTimeAsync(100);

    expect(onSettled).not.toHaveBeenCalled();
    expect(source.observers).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
