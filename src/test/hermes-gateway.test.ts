import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  forceDisconnectHermesGatewayClients,
  HermesGatewayClient,
  HermesGatewayError,
  HermesGatewayRequestTimeoutError,
  HermesGatewaySendQueueOverflowError,
  isSessionBusyError,
} from "../lib/hermes-gateway";
import {
  createHermesIdleSubmitGateway,
  HERMES_IDLE_SUBMIT_PROBE_TIMEOUT_MS,
} from "../lib/hermes-idle-submit-recovery";

type Listener = (event: unknown) => void;

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  bufferedAmount = 0;
  sent: string[] = [];
  private listeners = new Map<string, Listener[]>();

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener, options?: { once?: boolean }) {
    const wrapped: Listener = options?.once
      ? (event) => {
          this.removeEventListener(type, wrapped);
          listener(event);
        }
      : listener;
    const list = this.listeners.get(type) ?? [];
    list.push(wrapped);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: Listener) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((item) => item !== listener),
    );
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  message(frame: unknown) {
    this.emit("message", { data: JSON.stringify(frame) });
  }

  emit(type: string, event: unknown) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

describe("HermesGatewayClient", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("coalesces concurrent connect calls onto a single socket", async () => {
    const client = new HermesGatewayClient();
    const first = client.connect("ws://gateway");
    const second = client.connect("ws://gateway");

    // The second caller must not kill the in-flight socket.
    expect(FakeWebSocket.instances).toHaveLength(1);

    FakeWebSocket.instances[0].open();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].readyState).toBe(FakeWebSocket.OPEN);
  });

  it("short-circuits connect when the socket is already open", async () => {
    const client = new HermesGatewayClient();
    const first = client.connect("ws://gateway");
    FakeWebSocket.instances[0].open();
    await first;

    await client.connect("ws://gateway");
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("unregisters a mode client when its initial connection times out", async () => {
    vi.useFakeTimers();
    try {
      const client = new HermesGatewayClient(false);
      const onClose = vi.fn();
      client.onClose(onClose);
      const connecting = client.connect("ws://gateway");
      const socket = FakeWebSocket.instances[0];
      socket.close = vi.fn();
      const timedOut = expect(connecting).rejects.toThrow("Hermes gateway connection timed out.");

      await vi.advanceTimersByTimeAsync(15_000);
      await timedOut;

      // A delayed open event from the failed socket must not resurrect the
      // client in the mode registry or participate in future disconnects.
      socket.open();
      forceDisconnectHermesGatewayClients(false);
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a stale socket's close event for requests pending on the new socket", async () => {
    const client = new HermesGatewayClient();
    const first = client.connect("ws://gateway");
    const stale = FakeWebSocket.instances[0];
    stale.open();
    await first;

    client.close();
    const second = client.connect("ws://gateway");
    expect(FakeWebSocket.instances).toHaveLength(2);
    const fresh = FakeWebSocket.instances[1];
    fresh.open();
    await second;

    const pending = client.request<{ ok: boolean }>("ping");
    // A late close event from the replaced socket must not reject requests
    // pending on the socket that superseded it.
    stale.emit("close", {});

    const frame = JSON.parse(fresh.sent[0]) as { id: number };
    fresh.message({ id: frame.id, result: { ok: true } });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it("rejects requests pending on the current socket when it closes", async () => {
    const client = new HermesGatewayClient();
    const connecting = client.connect("ws://gateway");
    const socket = FakeWebSocket.instances[0];
    socket.open();
    await connecting;

    const pending = client.request("ping");
    socket.close();

    await expect(pending).rejects.toThrow("Hermes gateway connection closed.");
  });

  it("keeps the RPC error code so callers can branch on busy rejections", async () => {
    const client = new HermesGatewayClient();
    const connecting = client.connect("ws://gateway");
    const socket = FakeWebSocket.instances[0];
    socket.open();
    await connecting;

    const pending = client.request("prompt.submit", { text: "hi" });
    const frame = JSON.parse(socket.sent[0]) as { id: number };
    socket.message({
      id: frame.id,
      error: { code: 4009, message: "session busy" },
    });

    const error = await pending.then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(HermesGatewayError);
    expect((error as HermesGatewayError).code).toBe(4009);
    expect(isSessionBusyError(error)).toBe(true);
    expect(isSessionBusyError(new Error("session busy"))).toBe(false);
  });

  it("queues sends behind socket backpressure and flushes them in request order", async () => {
    vi.useFakeTimers();
    try {
      const client = new HermesGatewayClient();
      const connecting = client.connect("ws://gateway");
      const socket = FakeWebSocket.instances[0];
      socket.open();
      await connecting;

      socket.bufferedAmount = Number.MAX_SAFE_INTEGER;
      const first = client.request<{ ok: string }>("first");
      const second = client.request<{ ok: string }>("second");
      expect(socket.sent).toEqual([]);

      socket.bufferedAmount = 0;
      await vi.advanceTimersByTimeAsync(16);

      const frames = socket.sent.map((raw) => JSON.parse(raw) as { id: number; method: string });
      expect(frames.map((frame) => frame.method)).toEqual(["first", "second"]);

      socket.message({ id: frames[0].id, result: { ok: "first" } });
      socket.message({ id: frames[1].id, result: { ok: "second" } });
      await expect(first).resolves.toEqual({ ok: "first" });
      await expect(second).resolves.toEqual({ ok: "second" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a request that would overflow the bounded send queue", async () => {
    const client = new HermesGatewayClient();
    const connecting = client.connect("ws://gateway");
    const socket = FakeWebSocket.instances[0];
    socket.open();
    await connecting;

    socket.bufferedAmount = Number.MAX_SAFE_INTEGER;
    const queued = Array.from({ length: 128 }, (_, index) =>
      client.request(`queued.${index}`).catch((error: unknown) => error),
    );

    const overflow = client.request("overflow");
    await expect(overflow).rejects.toBeInstanceOf(HermesGatewaySendQueueOverflowError);
    await expect(overflow).rejects.toMatchObject({ method: "overflow" });
    expect(socket.sent).toEqual([]);

    client.close();
    const errors = await Promise.all(queued);
    expect(errors).toHaveLength(128);
    expect(errors.every((error) => error instanceof Error)).toBe(true);
  });

  it("keeps request timeout accounting active while a send waits for drain", async () => {
    vi.useFakeTimers();
    try {
      const client = new HermesGatewayClient();
      const connecting = client.connect("ws://gateway");
      const socket = FakeWebSocket.instances[0];
      socket.open();
      await connecting;

      socket.bufferedAmount = Number.MAX_SAFE_INTEGER;
      const pending = client.request("session.active_list", {}, 25);
      const timedOut = pending.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(25);
      await expect(timedOut).resolves.toBeInstanceOf(HermesGatewayRequestTimeoutError);

      socket.bufferedAmount = 0;
      await vi.advanceTimersByTimeAsync(16);
      expect(socket.sent).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispatches a 500-frame burst in ordered, yielding time-budgeted batches", async () => {
    vi.useFakeTimers();
    try {
      const client = new HermesGatewayClient();
      const connecting = client.connect("ws://gateway");
      const socket = FakeWebSocket.instances[0];
      socket.open();
      await connecting;

      let simulatedNow = 0;
      let batch = 0;
      const batchSizes: number[] = [];
      const received: number[] = [];
      vi.spyOn(performance, "now").mockImplementation(() => simulatedNow);
      const setTimeout = window.setTimeout.bind(window);
      vi.spyOn(window, "setTimeout").mockImplementation(((
        handler: TimerHandler,
        timeout?: number,
        ...args: unknown[]
      ) => {
        if (timeout === 0) batch += 1;
        return setTimeout(handler, timeout, ...args);
      }) as typeof window.setTimeout);
      client.onEvent((event) => {
        const index = (event.payload as { index: number }).index;
        received.push(index);
        batchSizes[batch] = (batchSizes[batch] ?? 0) + 1;
        simulatedNow += 1;
      });

      for (let index = 0; index < 500; index += 1) {
        socket.message({
          method: "event",
          params: { type: "message.delta", session_id: "session-1", payload: { index } },
        });
      }

      expect(received).toEqual([]);
      await Promise.resolve();
      expect(received.length).toBeGreaterThan(0);
      expect(received.length).toBeLessThan(500);

      await vi.runAllTimersAsync();

      expect(received).toEqual(Array.from({ length: 500 }, (_, index) => index));
      expect(batchSizes.length).toBeGreaterThan(1);
      expect(Math.max(...batchSizes)).toBeLessThanOrEqual(8);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not replay a queued frame to a listener attached after ingress", async () => {
    const client = new HermesGatewayClient();
    const connecting = client.connect("ws://gateway");
    const socket = FakeWebSocket.instances[0];
    socket.open();
    await connecting;

    socket.message({
      method: "event",
      params: { type: "message.delta", session_id: "session-1" },
    });
    const lateListener = vi.fn();
    client.onEvent(lateListener);

    await Promise.resolve();
    expect(lateListener).not.toHaveBeenCalled();
  });

  it("notifies close listeners on unexpected drops but not on explicit close", async () => {
    const client = new HermesGatewayClient();
    const onClose = vi.fn();
    client.onClose(onClose);

    const first = client.connect("ws://gateway");
    FakeWebSocket.instances[0].open();
    await first;

    // Server-side drop → listeners fire.
    FakeWebSocket.instances[0].close();
    expect(onClose).toHaveBeenCalledTimes(1);

    const second = client.connect("ws://gateway");
    FakeWebSocket.instances[1].open();
    await second;

    // Intentional teardown → listeners stay quiet.
    client.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("force-disconnects a stalled mode and allows its existing client to reconnect", async () => {
    const client = new HermesGatewayClient(false);
    const onClose = vi.fn();
    client.onClose(onClose);

    const first = client.connect("ws://gateway");
    const stalled = FakeWebSocket.instances[0];
    stalled.open();
    await first;

    forceDisconnectHermesGatewayClients(false);

    expect(stalled.readyState).toBe(FakeWebSocket.CLOSED);
    expect(onClose).toHaveBeenCalledOnce();

    const recovering = client.connect("ws://gateway");
    const recovered = FakeWebSocket.instances[1];
    recovered.open();
    await recovering;

    expect(recovered.readyState).toBe(FakeWebSocket.OPEN);
    expect(onClose).toHaveBeenCalledOnce();
    client.close();
  });

  it("bounds an idle submit stall by reconnecting and retrying its first request once", async () => {
    vi.useFakeTimers();
    try {
      const client = new HermesGatewayClient(false);
      const connecting = client.connect("ws://gateway");
      FakeWebSocket.instances[0].open();
      await connecting;
      const reconnect = vi.fn(async () => {
        const reconnecting = client.connect("ws://gateway");
        FakeWebSocket.instances.at(-1)?.open();
        await reconnecting;
        return client;
      });
      const submitGateway = createHermesIdleSubmitGateway({
        fullMode: false,
        gateway: client,
        shouldProbeFirstRequest: () => true,
        reconnect,
      });
      const startedAt = Date.now();
      const pending = submitGateway.request<{ session_id: string }>("session.create", {
        title: "Recovered submit",
      });

      // The first socket remains OPEN but never produces a response frame.
      await vi.advanceTimersByTimeAsync(HERMES_IDLE_SUBMIT_PROBE_TIMEOUT_MS);
      expect(reconnect).toHaveBeenCalledOnce();
      expect(FakeWebSocket.instances).toHaveLength(2);

      const recovered = FakeWebSocket.instances[1];
      const retriedFrame = JSON.parse(recovered.sent[0]) as { id: number; method: string };
      expect(retriedFrame.method).toBe("session.create");
      recovered.message({ id: retriedFrame.id, result: { session_id: "runtime-recovered" } });

      await expect(pending).resolves.toEqual({ session_id: "runtime-recovered" });
      expect(Date.now() - startedAt).toBeLessThan(10_000);
      expect(FakeWebSocket.instances[0].sent).toHaveLength(1);
      expect(recovered.sent).toHaveLength(1);
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a healthy idle submit on one connection and scopes the short deadline to its first request", async () => {
    vi.useFakeTimers();
    try {
      const client = new HermesGatewayClient(false);
      const connecting = client.connect("ws://gateway");
      const socket = FakeWebSocket.instances[0];
      socket.open();
      await connecting;
      const reconnect = vi.fn(async () => client);
      const submitGateway = createHermesIdleSubmitGateway({
        fullMode: false,
        gateway: client,
        shouldProbeFirstRequest: () => true,
        reconnect,
      });
      const creating = submitGateway.request<{ session_id: string }>("session.create", {
        title: "Healthy submit",
      });
      const createFrame = JSON.parse(socket.sent[0]) as { id: number };
      socket.message({ id: createFrame.id, result: { session_id: "runtime-healthy" } });
      await expect(creating).resolves.toEqual({ session_id: "runtime-healthy" });

      const submitting = submitGateway.request<{ accepted: boolean }>("prompt.submit", {
        session_id: "runtime-healthy",
        text: "Continue normally",
      });
      await vi.advanceTimersByTimeAsync(HERMES_IDLE_SUBMIT_PROBE_TIMEOUT_MS + 1);
      expect(reconnect).not.toHaveBeenCalled();
      expect(socket.readyState).toBe(FakeWebSocket.OPEN);

      const submitFrame = JSON.parse(socket.sent[1]) as { id: number };
      socket.message({ id: submitFrame.id, result: { accepted: true } });
      await expect(submitting).resolves.toEqual({ accepted: true });
      expect(FakeWebSocket.instances).toHaveLength(1);
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the healthy active-submit request deadline unchanged", async () => {
    vi.useFakeTimers();
    try {
      const client = new HermesGatewayClient(false);
      const connecting = client.connect("ws://gateway");
      const socket = FakeWebSocket.instances[0];
      socket.open();
      await connecting;
      const reconnect = vi.fn(async () => client);
      let workingSessionExists = false;
      const submitGateway = createHermesIdleSubmitGateway({
        fullMode: false,
        gateway: client,
        shouldProbeFirstRequest: () => !workingSessionExists,
        reconnect,
      });
      // A run can start after submit preparation begins but before its first
      // Gateway request. Read the shared lifecycle signal at request time so
      // that race cannot force-disconnect active work.
      workingSessionExists = true;
      const pending = submitGateway.request<{ accepted: boolean }>("prompt.submit", {
        session_id: "runtime-active",
        text: "Keep going",
      });

      await vi.advanceTimersByTimeAsync(HERMES_IDLE_SUBMIT_PROBE_TIMEOUT_MS + 1);
      expect(reconnect).not.toHaveBeenCalled();
      expect(socket.readyState).toBe(FakeWebSocket.OPEN);

      const frame = JSON.parse(socket.sent[0]) as { id: number };
      socket.message({ id: frame.id, result: { accepted: true } });
      await expect(pending).resolves.toEqual({ accepted: true });
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a retry failure without attempting a second reconnect", async () => {
    vi.useFakeTimers();
    try {
      const client = new HermesGatewayClient(false);
      const connecting = client.connect("ws://gateway");
      FakeWebSocket.instances[0].open();
      await connecting;
      const reconnect = vi.fn(async () => {
        const reconnecting = client.connect("ws://gateway");
        FakeWebSocket.instances.at(-1)?.open();
        await reconnecting;
        return client;
      });
      const submitGateway = createHermesIdleSubmitGateway({
        fullMode: false,
        gateway: client,
        shouldProbeFirstRequest: () => true,
        reconnect,
      });
      const pending = submitGateway.request("session.resume", {
        session_id: "stored-session",
      });

      await vi.advanceTimersByTimeAsync(HERMES_IDLE_SUBMIT_PROBE_TIMEOUT_MS);
      const recovered = FakeWebSocket.instances[1];
      const retriedFrame = JSON.parse(recovered.sent[0]) as { id: number };
      recovered.message({
        id: retriedFrame.id,
        error: { code: 5001, message: "Gateway still unavailable." },
      });

      await expect(pending).rejects.toMatchObject({
        code: 5001,
        message: "Gateway still unavailable.",
      });
      expect(reconnect).toHaveBeenCalledOnce();
      expect(FakeWebSocket.instances).toHaveLength(2);
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
