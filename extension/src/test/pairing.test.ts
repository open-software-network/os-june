import { describe, expect, it } from "vitest";
import { initialPairingState, reducePairing, type PairingState } from "../pairing";
import { PROTOCOL_VERSION } from "../protocol";

const VERSION = "0.1.0";

function drive(events: Parameters<typeof reducePairing>[1][]): PairingState {
  let state = initialPairingState;
  for (const event of events) {
    state = reducePairing(state, event, VERSION).state;
  }
  return state;
}

describe("pairing handshake", () => {
  it("sends hello on connect and enters handshaking", () => {
    const transition = reducePairing(initialPairingState, { kind: "connect" }, VERSION);
    expect(transition.state).toEqual({ status: "handshaking" });
    expect(transition.send).toEqual({
      v: PROTOCOL_VERSION,
      type: "hello",
      extensionVersion: VERSION,
    });
  });

  it("pairs on hello_ok and records the app version", () => {
    const state = drive([
      { kind: "connect" },
      { kind: "message", message: { v: 1, type: "hello_ok", appVersion: "0.0.32" } },
    ]);
    expect(state).toEqual({ status: "paired", appVersion: "0.0.32" });
  });

  it("surfaces a protocol mismatch as the update prompt state", () => {
    const state = drive([
      { kind: "connect" },
      { kind: "message", message: { v: 2, type: "hello_incompatible", expected: 2 } },
    ]);
    expect(state).toEqual({ status: "incompatible", expected: 2 });
  });

  it("keeps the incompatible verdict when the port then disconnects", () => {
    const state = drive([
      { kind: "connect" },
      { kind: "message", message: { v: 1, type: "hello_incompatible", expected: 2 } },
      { kind: "disconnect" },
    ]);
    expect(state.status).toBe("incompatible");
  });

  it("maps the shim's app_unreachable error to unreachable and keeps it after disconnect", () => {
    const state = drive([
      { kind: "connect" },
      { kind: "message", message: { v: 1, type: "error", code: "app_unreachable" } },
      { kind: "disconnect" },
    ]);
    expect(state).toEqual({ status: "unreachable" });
  });

  it("returns to disconnected when a paired port closes", () => {
    const state = drive([
      { kind: "connect" },
      { kind: "message", message: { v: 1, type: "hello_ok" } },
      { kind: "disconnect" },
    ]);
    expect(state).toEqual({ status: "disconnected" });
  });

  it("ignores malformed and unknown messages without changing state", () => {
    const state = drive([
      { kind: "connect" },
      { kind: "message", message: "garbage" },
      { kind: "message", message: { v: 1, type: "unknown_future_thing" } },
    ]);
    expect(state).toEqual({ status: "handshaking" });
  });
});
