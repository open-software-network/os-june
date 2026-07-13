// Native messaging protocol contract, extension half (JUN-287). The app half
// pins its copy in src-tauri/src/extension_host.rs; the hello handshake
// compares the two. Chrome handles the 4-byte length framing on this side -
// port messages arrive as parsed JSON objects - so this module owns message
// shape and validation only.

/** Bump when the message contract changes incompatibly. */
export const PROTOCOL_VERSION = 1;

/** Must match NATIVE_HOST_NAME in src-tauri/src/extension_host.rs. */
export const NATIVE_HOST_NAME = "co.opensoftware.june.extension";

export type HelloMessage = {
  v: number;
  type: "hello";
  extensionVersion: string;
};

export type PingMessage = {
  v: number;
  type: "ping";
  id?: number;
};

export type HostMessage =
  | { v: number; type: "hello_ok"; appVersion?: string }
  | { v: number; type: "hello_incompatible"; expected?: number }
  | { v: number; type: "pong"; id?: number }
  | { v: number; type: "error"; code?: string };

export function helloMessage(extensionVersion: string): HelloMessage {
  return { v: PROTOCOL_VERSION, type: "hello", extensionVersion };
}

export function pingMessage(id?: number): PingMessage {
  return id === undefined
    ? { v: PROTOCOL_VERSION, type: "ping" }
    : { v: PROTOCOL_VERSION, type: "ping", id };
}

/**
 * Narrows an untrusted port message to the host message union. Returns null
 * for anything that is not an object carrying an integer `v` and a known
 * string `type` - unknown message types are dropped rather than crashing the
 * worker, so an older extension survives a newer app sending new frames.
 */
export function parseHostMessage(raw: unknown): HostMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (!Number.isInteger(value.v)) return null;
  if (
    value.type !== "hello_ok" &&
    value.type !== "hello_incompatible" &&
    value.type !== "pong" &&
    value.type !== "error"
  ) {
    return null;
  }
  return value as HostMessage;
}
