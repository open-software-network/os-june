import { describe, expect, it, vi } from "vitest";
import { createHermesMethods } from "../lib/hermes-control-plane";

function setup() {
  const request = vi.fn(async () => ({ ok: true }));
  const methods = createHermesMethods(request);
  return { request, methods };
}

describe("createHermesMethods — typed command wrappers", () => {
  it("createSession maps optional agent-run tool scope to the gateway wire shape", async () => {
    const { request, methods } = setup();
    await methods.createSession({
      title: "Use Computer use",
      cols: 96,
      model: "grok-4-5",
      reasoningEffort: "high",
      enabledToolsets: ["june_computer_use"],
    });
    expect(request).toHaveBeenCalledWith("session.create", {
      title: "Use Computer use",
      cols: 96,
      model: "grok-4-5",
      reasoning_effort: "high",
      enabled_toolsets: ["june_computer_use"],
    });
  });

  it("submitPrompt maps optional agent-run tool scope to the gateway wire shape", async () => {
    const { request, methods } = setup();
    await methods.submitPrompt({
      sessionId: "runtime-1",
      text: "Open Calculator.",
      enabledToolsets: ["june_computer_use"],
    });
    expect(request).toHaveBeenCalledWith("prompt.submit", {
      session_id: "runtime-1",
      text: "Open Calculator.",
      enabled_toolsets: ["june_computer_use"],
    });
  });

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

  it("switchActiveSessionModel sets a session-scoped model through config.set", async () => {
    const { request, methods } = setup();
    await methods.switchActiveSessionModel({
      mode: "sandboxed",
      sessionId: "s1",
      model: "kimi-k2-6",
    });
    // The mode only routes the gateway at the call site and never reaches the
    // wire. The session flag prevents a session choice from changing Hermes'
    // process-wide default.
    expect(request).toHaveBeenCalledWith("config.set", {
      session_id: "s1",
      key: "model",
      value: "kimi-k2-6 --session",
      confirm_expensive_model: true,
    });
  });

  it("setSessionReasoningEffort sets the reasoning key through config.set", async () => {
    const { request, methods } = setup();
    await methods.setSessionReasoningEffort({
      sessionId: "runtime-1",
      effort: "high",
    });
    // The session id is the RUNTIME id (the gateway's live-session map key),
    // and the effort passes through untouched: callers own the level mapping.
    expect(request).toHaveBeenCalledWith("config.set", {
      session_id: "runtime-1",
      key: "reasoning",
      value: "high",
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

  it("attachImage forwards image data to image.attach_bytes", async () => {
    const { request, methods } = setup();
    await methods.attachImage({
      sessionId: "s1",
      mimeType: "image/png",
      dataBase64: "AAAA",
      fileName: "diagram.png",
    });
    expect(request).toHaveBeenCalledWith("image.attach_bytes", {
      session_id: "s1",
      mime_type: "image/png",
      content_base64: "AAAA",
      filename: "diagram.png",
    });
  });

  it("attachImagePath forwards only a native path to image.attach", async () => {
    const { request, methods } = setup();
    await methods.attachImagePath({
      sessionId: "runtime-1",
      path: "/workspace/session-attachments/abc/diagram.png",
    });
    expect(request).toHaveBeenCalledWith("image.attach", {
      session_id: "runtime-1",
      path: "/workspace/session-attachments/abc/diagram.png",
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
