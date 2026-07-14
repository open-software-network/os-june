import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchHermesRunSettlement } from "../lib/hermes-run-settlement";

describe("Hermes run settlement", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("settles after two reachable idle observations", async () => {
    const listActiveSessions = vi.fn(async () => []);
    const onSettled = vi.fn();

    watchHermesRunSettlement({
      storedSessionId: "stored-1",
      listActiveSessions,
      onSettled,
      pollIntervalMs: 20,
      timeoutMs: 100,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(listActiveSessions).toHaveBeenCalledOnce();
    expect(onSettled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20);
    expect(listActiveSessions).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(100);
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("requires consecutive idle observations and ignores unrelated busy sessions", async () => {
    const snapshots = [
      [],
      [{ session_key: "stored-1", status: "working" }],
      [{ session_key: "someone-else", status: "working" }],
      [{ session_key: "stored-1", status: "idle" }],
    ];
    const listActiveSessions = vi.fn(async () => snapshots.shift() ?? []);
    const onSettled = vi.fn();

    watchHermesRunSettlement({
      storedSessionId: "stored-1",
      listActiveSessions,
      onSettled,
      pollIntervalMs: 10,
      timeoutMs: 100,
    });

    await vi.advanceTimersByTimeAsync(20);
    expect(onSettled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);

    expect(onSettled).toHaveBeenCalledOnce();
    expect(listActiveSessions).toHaveBeenCalledTimes(4);
  });

  it("treats a non-idle runtime-id match as busy", async () => {
    const snapshots = [
      [{ id: "runtime-1", status: "working" }],
      [{ id: "runtime-1", status: "idle" }],
      [{ id: "runtime-1", status: "idle" }],
    ];
    const onSettled = vi.fn();

    watchHermesRunSettlement({
      storedSessionId: "stored-1",
      runtimeSessionId: "runtime-1",
      listActiveSessions: vi.fn(async () => snapshots.shift() ?? []),
      onSettled,
      pollIntervalMs: 10,
      timeoutMs: 100,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(onSettled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("retries errors without settling and stops at the timeout", async () => {
    const listActiveSessions = vi.fn(async () => {
      throw new Error("gateway unavailable");
    });
    const onSettled = vi.fn();

    watchHermesRunSettlement({
      storedSessionId: "stored-timeout",
      listActiveSessions,
      onSettled,
      pollIntervalMs: 10,
      timeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(listActiveSessions).toHaveBeenCalledTimes(3);
    expect(onSettled).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resets an idle streak when a poll fails", async () => {
    const listActiveSessions = vi
      .fn<() => Promise<readonly []>>()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockResolvedValue([]);
    const onSettled = vi.fn();

    watchHermesRunSettlement({
      storedSessionId: "stored-retry",
      listActiveSessions,
      onSettled,
      pollIntervalMs: 10,
      timeoutMs: 100,
    });

    await vi.advanceTimersByTimeAsync(20);
    expect(onSettled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("coalesces a duplicate watch and keeps the first callback", async () => {
    const listActiveSessions = vi.fn(async () => [
      { id: "runtime-from-second-call", status: "working" },
    ]);
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    const firstHandle = watchHermesRunSettlement({
      storedSessionId: "stored-shared",
      listActiveSessions,
      onSettled: firstCallback,
      pollIntervalMs: 10,
      timeoutMs: 100,
    });
    const secondHandle = watchHermesRunSettlement({
      storedSessionId: "stored-shared",
      runtimeSessionId: "runtime-from-second-call",
      listActiveSessions: vi.fn(async () => []),
      onSettled: secondCallback,
      pollIntervalMs: 1,
      timeoutMs: 2,
    });

    expect(secondHandle).toBe(firstHandle);
    await vi.advanceTimersByTimeAsync(30);

    expect(firstCallback).not.toHaveBeenCalled();
    expect(secondCallback).not.toHaveBeenCalled();
    expect(listActiveSessions).toHaveBeenCalledTimes(4);
  });

  it("cancels an active watch, including an in-flight observation", async () => {
    let resolveList: (rows: readonly []) => void = () => undefined;
    const listActiveSessions = vi.fn(
      () =>
        new Promise<readonly []>((resolve) => {
          resolveList = resolve;
        }),
    );
    const onSettled = vi.fn();
    const handle = watchHermesRunSettlement({
      storedSessionId: "stored-cancelled",
      listActiveSessions,
      onSettled,
      pollIntervalMs: 10,
      timeoutMs: 100,
    });

    handle.cancel();
    resolveList([]);
    await vi.advanceTimersByTimeAsync(100);

    expect(listActiveSessions).toHaveBeenCalledOnce();
    expect(onSettled).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
