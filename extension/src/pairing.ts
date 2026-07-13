// Pairing handshake state machine, pure so tests can drive it without a
// chrome.* mock. The background worker feeds it connect/message/disconnect
// events; it answers with the next state and any message to post on the
// native port.

import { helloMessage, parseHostMessage, type HelloMessage } from "./protocol";

export type PairingState =
  | { status: "disconnected" }
  | { status: "connecting" }
  /** Port open, hello sent, waiting for the app's verdict. */
  | { status: "handshaking" }
  | { status: "paired"; appVersion?: string }
  /** Protocol mismatch: the app told us to prompt for an extension update. */
  | { status: "incompatible"; expected?: number }
  /** The shim could not reach the app (June is not running). */
  | { status: "unreachable" };

export type PairingEvent =
  | { kind: "connect" }
  | { kind: "message"; message: unknown }
  | { kind: "disconnect" };

export type PairingTransition = {
  state: PairingState;
  /** Message to post on the native port, when the event calls for one. */
  send?: HelloMessage;
};

export const initialPairingState: PairingState = { status: "disconnected" };

export function reducePairing(
  state: PairingState,
  event: PairingEvent,
  extensionVersion: string,
): PairingTransition {
  switch (event.kind) {
    case "connect":
      return { state: { status: "handshaking" }, send: helloMessage(extensionVersion) };
    case "disconnect":
      // An incompatible or unreachable verdict outlives the port closing -
      // the popup must keep showing why pairing failed, not a generic
      // disconnected state.
      if (state.status === "incompatible" || state.status === "unreachable") {
        return { state };
      }
      return { state: { status: "disconnected" } };
    case "message": {
      const message = parseHostMessage(event.message);
      if (message === null) return { state };
      switch (message.type) {
        case "hello_ok":
          return { state: { status: "paired", appVersion: message.appVersion } };
        case "hello_incompatible":
          return { state: { status: "incompatible", expected: message.expected } };
        case "error":
          if (message.code === "app_unreachable") {
            return { state: { status: "unreachable" } };
          }
          return { state };
        case "pong":
          return { state };
      }
    }
  }
}
