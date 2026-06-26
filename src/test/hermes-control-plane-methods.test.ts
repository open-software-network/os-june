import { describe, expect, it, vi } from "vitest";
import { createHermesMethods } from "../lib/hermes-control-plane";

function setup() {
  const request = vi.fn(async () => ({ ok: true }));
  const methods = createHermesMethods(request);
  return { request, methods };
}

describe("createHermesMethods — typed command wrappers", () => {
  it("steerSession forwards session id and text to session.steer", async () => {
    const { request, methods } = setup();
    await methods.steerSession({ sessionId: "s1", text: "focus on tests" });
    expect(request).toHaveBeenCalledWith("session.steer", {
      session_id: "s1",
      text: "focus on tests",
    });
  });

  it("branchSession forwards the fork point to session.branch", async () => {
    const { request, methods } = setup();
    await methods.branchSession({ sessionId: "s1", fromMessageId: "m4" });
    expect(request).toHaveBeenCalledWith("session.branch", {
      session_id: "s1",
      from_message_id: "m4",
    });
  });

  it("compressSession calls session.compress", async () => {
    const { request, methods } = setup();
    await methods.compressSession({ sessionId: "s1" });
    expect(request).toHaveBeenCalledWith("session.compress", {
      session_id: "s1",
    });
  });

  it("getSessionUsage calls session.usage and returns the result", async () => {
    const { request, methods } = setup();
    const usage = await methods.getSessionUsage({ sessionId: "s1" });
    expect(request).toHaveBeenCalledWith("session.usage", { session_id: "s1" });
    expect(usage).toEqual({ ok: true });
  });

  it("dispatchCommand forwards the command and args to command.dispatch", async () => {
    const { request, methods } = setup();
    await methods.dispatchCommand({
      sessionId: "s1",
      command: "/compact",
      args: { keep: 5 },
    });
    expect(request).toHaveBeenCalledWith("command.dispatch", {
      session_id: "s1",
      command: "/compact",
      args: { keep: 5 },
    });
  });

  it("switchActiveSessionModel dispatches /model through command.dispatch", async () => {
    const { request, methods } = setup();
    await methods.switchActiveSessionModel({
      mode: "sandboxed",
      sessionId: "s1",
      model: "kimi-k2-6",
    });
    // Built on dispatchCommand: the mode only routes the gateway at the call
    // site and never reaches the wire.
    expect(request).toHaveBeenCalledWith("command.dispatch", {
      session_id: "s1",
      command: "/model kimi-k2-6",
    });
  });

  it("respondToSudo forwards approval + mode to sudo.respond", async () => {
    const { request, methods } = setup();
    await methods.respondToSudo({
      sessionId: "s1",
      requestId: "su1",
      approved: true,
      mode: "unrestricted",
    });
    expect(request).toHaveBeenCalledWith("sudo.respond", {
      session_id: "s1",
      request_id: "su1",
      approved: true,
      mode: "unrestricted",
    });
  });

  it("respondToSecret forwards the value to secret.respond", async () => {
    const { request, methods } = setup();
    await methods.respondToSecret({
      sessionId: "s1",
      requestId: "se1",
      value: "sk-123",
    });
    expect(request).toHaveBeenCalledWith("secret.respond", {
      session_id: "s1",
      request_id: "se1",
      value: "sk-123",
    });
  });

  it("interruptSubagent calls subagent.interrupt", async () => {
    const { request, methods } = setup();
    await methods.interruptSubagent({ sessionId: "s1", subagentId: "sub1" });
    expect(request).toHaveBeenCalledWith("subagent.interrupt", {
      session_id: "s1",
      subagent_id: "sub1",
    });
  });

  it("attachImage forwards image data to image.attach", async () => {
    const { request, methods } = setup();
    await methods.attachImage({
      sessionId: "s1",
      mimeType: "image/png",
      dataBase64: "AAAA",
    });
    expect(request).toHaveBeenCalledWith("image.attach", {
      session_id: "s1",
      mime_type: "image/png",
      data_base64: "AAAA",
    });
  });

  it("omits undefined optional params rather than sending nulls", async () => {
    const { request, methods } = setup();
    await methods.branchSession({ sessionId: "s1" });
    expect(request).toHaveBeenCalledWith("session.branch", {
      session_id: "s1",
    });
  });

  it("accepts a gateway-like client with a .request method", async () => {
    const client = { request: vi.fn(async () => undefined) };
    const methods = createHermesMethods(client);
    await methods.compressSession({ sessionId: "s9" });
    expect(client.request).toHaveBeenCalledWith("session.compress", {
      session_id: "s9",
    });
  });
});
