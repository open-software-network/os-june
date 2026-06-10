import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HermesGatewayClient,
  HermesGatewayError,
  isSessionBusyError,
} from "../lib/hermes-gateway";

type Listener = (event: unknown) => void;

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  private listeners = new Map<string, Listener[]>();

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(
    type: string,
    listener: Listener,
    options?: { once?: boolean },
  ) {
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
});
