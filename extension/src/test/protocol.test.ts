import { describe, expect, it } from "vitest";
import {
  helloMessage,
  parseBrowserRequest,
  parseHostMessage,
  pingMessage,
  PROTOCOL_VERSION,
} from "../protocol";

describe("protocol messages", () => {
  it("stamps hello with the pinned protocol version and extension version", () => {
    expect(helloMessage("0.1.0")).toEqual({
      v: PROTOCOL_VERSION,
      type: "hello",
      extensionVersion: "0.1.0",
    });
  });

  it("builds ping with and without an id", () => {
    expect(pingMessage()).toEqual({ v: PROTOCOL_VERSION, type: "ping" });
    expect(pingMessage(7)).toEqual({ v: PROTOCOL_VERSION, type: "ping", id: 7 });
  });
});

describe("parseHostMessage", () => {
  it("accepts every known host message type", () => {
    for (const type of ["hello_ok", "hello_incompatible", "pong", "error"]) {
      expect(parseHostMessage({ v: PROTOCOL_VERSION, type })).toEqual({
        v: PROTOCOL_VERSION,
        type,
      });
    }
  });

  it("rejects non-objects, missing version, and unknown types", () => {
    expect(parseHostMessage(null)).toBeNull();
    expect(parseHostMessage("hello_ok")).toBeNull();
    expect(parseHostMessage({ type: "hello_ok" })).toBeNull();
    expect(parseHostMessage({ v: "1", type: "hello_ok" })).toBeNull();
    expect(parseHostMessage({ v: PROTOCOL_VERSION, type: "take_over_tab" })).toBeNull();
  });

  it("accepts only well-formed browser requests", () => {
    expect(
      parseBrowserRequest({
        v: PROTOCOL_VERSION,
        type: "request",
        id: 3,
        tool: "open_tab",
        arguments: { session_id: "s" },
      }),
    ).toMatchObject({ id: 3, tool: "open_tab" });
    expect(
      parseBrowserRequest({
        v: PROTOCOL_VERSION,
        type: "request",
        id: "3",
        tool: "open_tab",
        arguments: {},
      }),
    ).toBeNull();
    expect(
      parseBrowserRequest({ v: PROTOCOL_VERSION, type: "request", id: 3, tool: "open_tab" }),
    ).toBeNull();
    expect(
      parseBrowserRequest({
        v: PROTOCOL_VERSION,
        type: "request",
        id: 3,
        tool: "https://private.example/field-value",
        arguments: {},
      }),
    ).toBeNull();
  });

  it("accepts every attended inspect and interaction tool", () => {
    for (const tool of ["inspect_reference", "click", "fill", "press"] as const) {
      expect(
        parseBrowserRequest({
          v: PROTOCOL_VERSION,
          type: "request",
          id: 10,
          tool,
          arguments: { session_id: "s", tab_id: 7, ref: "e0:n1" },
        }),
      ).toMatchObject({ tool });
    }
  });
});
