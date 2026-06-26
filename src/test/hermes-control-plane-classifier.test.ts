import { describe, expect, it } from "vitest";
import type { HermesGatewayEvent } from "../lib/hermes-gateway";
import {
  classifyHermesEvent,
  isSensitiveKey,
  parseHermesMode,
  sanitizePayload,
} from "../lib/hermes-control-plane";
import type {
  BackgroundHermesActivity,
  JuneHermesEvent,
  PendingHermesAction,
} from "../lib/hermes-control-plane";

// Every name the gateway currently models (HermesGatewayEventName), so the
// classifier's exhaustiveness is pinned to the transport's surface. If the
// transport adds a name, this list must grow and the classifier must map it.
const CURRENT_GATEWAY_EVENT_NAMES = [
  "gateway.ready",
  "session.info",
  "message.start",
  "message.delta",
  "message.complete",
  "thinking.delta",
  "reasoning.delta",
  "status.update",
  "tool.start",
  "tool.progress",
  "tool.complete",
  "clarify.request",
  "clarify.response",
  "approval.request",
  "approval.response",
  "subagent.start",
  "subagent.tool",
  "subagent.progress",
  "subagent.thinking",
  "subagent.complete",
  "error",
] as const;

function event<P>(type: string, payload?: P, sessionId = "sess-1") {
  return { type, session_id: sessionId, payload } as HermesGatewayEvent<P>;
}

describe("classifyHermesEvent — totality", () => {
  it("maps every current gateway event name to a defined JuneHermesEvent", () => {
    for (const name of CURRENT_GATEWAY_EVENT_NAMES) {
      const result = classifyHermesEvent(event(name, {}));
      expect(result, `expected a result for ${name}`).toBeDefined();
      expect(result.kind, `expected a kind for ${name}`).toBeTruthy();
    }
  });

  it("classifies an unknown event name as unsupported, never undefined", () => {
    const result = classifyHermesEvent(
      event("some.future.event", { foo: "bar" }),
    );
    expect(result).toBeDefined();
    expect(result.kind).toBe("unsupported");
    if (result.kind === "unsupported") {
      expect(result.rawType).toBe("some.future.event");
      expect(result.sessionId).toBe("sess-1");
      expect(result.sanitizedPayload).toEqual({ foo: "bar" });
    }
  });

  it("classifies a missing/empty type as unsupported rather than throwing", () => {
    const result = classifyHermesEvent({
      type: "",
    } as unknown as HermesGatewayEvent);
    expect(result.kind).toBe("unsupported");
  });
});

describe("classifyHermesEvent — transcript", () => {
  it("maps message.start/delta/complete to transcript with the right flags", () => {
    const start = classifyHermesEvent(
      event("message.start", { message_id: "m1" }),
    );
    expect(start).toMatchObject({
      kind: "transcript",
      sessionId: "sess-1",
      messageId: "m1",
      complete: false,
    });

    const delta = classifyHermesEvent(
      event("message.delta", { message_id: "m1", delta: "Hel" }),
    );
    expect(delta).toMatchObject({
      kind: "transcript",
      delta: "Hel",
      complete: false,
    });

    const complete = classifyHermesEvent(
      event("message.complete", { message_id: "m1", text: "Hello" }),
    );
    expect(complete).toMatchObject({
      kind: "transcript",
      complete: true,
    });
    if (complete.kind === "transcript") {
      expect(complete.delta).toBe("Hello");
    }
  });

  it("preserves whitespace-only deltas verbatim", () => {
    const delta = classifyHermesEvent(event("message.delta", { delta: "  " }));
    if (delta.kind === "transcript") {
      expect(delta.delta).toBe("  ");
    } else {
      throw new Error("expected transcript");
    }
  });
});

describe("classifyHermesEvent — reasoning", () => {
  it("maps thinking.delta and reasoning.delta to reasoning", () => {
    for (const name of ["thinking.delta", "reasoning.delta"]) {
      const result = classifyHermesEvent(event(name, { delta: "mmm" }));
      expect(result).toMatchObject({
        kind: "reasoning",
        sessionId: "sess-1",
        delta: "mmm",
      });
    }
  });
});

describe("classifyHermesEvent — tools", () => {
  it("maps tool phases and preserves metadata for tool cards", () => {
    const start = classifyHermesEvent(
      event("tool.start", {
        tool_call_id: "tc1",
        name: "read_file",
        path: "/tmp/x",
      }),
    );
    expect(start).toMatchObject({
      kind: "tool",
      phase: "start",
      toolCallId: "tc1",
      name: "read_file",
    });
    if (start.kind === "tool") {
      // The raw payload is preserved so a tool card can render arguments.
      expect(start.payload).toMatchObject({ path: "/tmp/x" });
    }

    expect(classifyHermesEvent(event("tool.progress", {}))).toMatchObject({
      kind: "tool",
      phase: "progress",
    });
    expect(classifyHermesEvent(event("tool.complete", {}))).toMatchObject({
      kind: "tool",
      phase: "complete",
    });
  });

  it("falls back across tool_name / tool field aliases", () => {
    const byToolName = classifyHermesEvent(
      event("tool.start", { tool_name: "shell" }),
    );
    if (byToolName.kind === "tool") expect(byToolName.name).toBe("shell");
    const byTool = classifyHermesEvent(event("tool.start", { tool: "grep" }));
    if (byTool.kind === "tool") expect(byTool.name).toBe("grep");
  });
});

describe("classifyHermesEvent — pending actions", () => {
  it("maps clarify.request to a clarify pending action", () => {
    const result = classifyHermesEvent(
      event("clarify.request", {
        request_id: "c1",
        question: "Which file?",
        choices: ["a.ts", "b.ts"],
      }),
    );
    expect(result.kind).toBe("pending_action");
    if (result.kind === "pending_action") {
      const action = result.action;
      expect(action.kind).toBe("clarify");
      if (action.kind === "clarify") {
        expect(action.requestId).toBe("c1");
        expect(action.question).toBe("Which file?");
        expect(action.choices).toEqual(["a.ts", "b.ts"]);
      }
    }
  });

  it("maps approval.request to an approval pending action with metadata", () => {
    const result = classifyHermesEvent(
      event("approval.request", {
        request_id: "a1",
        tool_name: "shell",
        description: "Run the build",
        command: "pnpm build",
      }),
    );
    expect(result.kind).toBe("pending_action");
    if (result.kind === "pending_action" && result.action.kind === "approval") {
      expect(result.action.requestId).toBe("a1");
      expect(result.action.toolName).toBe("shell");
      expect(result.action.description).toBe("Run the build");
    }
  });

  it("maps sudo.request to a sudo pending action carrying mode", () => {
    const result = classifyHermesEvent(
      event("sudo.request", {
        request_id: "su1",
        command: "apt install foo",
        reason: "needs root",
        mode: "unrestricted",
      }),
    );
    expect(result.kind).toBe("pending_action");
    if (result.kind === "pending_action" && result.action.kind === "sudo") {
      expect(result.action.requestId).toBe("su1");
      expect(result.action.command).toBe("apt install foo");
      expect(result.action.mode).toBe("unrestricted");
    }
  });

  it("maps secret.request to a secret pending action that never carries the value", () => {
    const result = classifyHermesEvent(
      event("secret.request", {
        request_id: "se1",
        key_name: "OPENAI_API_KEY",
        reason: "to call the API",
        // A misbehaving gateway includes the value; it must not survive.
        api_key: "sk-leak-me",
        value: "sk-leak-me",
      }),
    );
    expect(result.kind).toBe("pending_action");
    if (result.kind === "pending_action" && result.action.kind === "secret") {
      expect(result.action.requestId).toBe("se1");
      expect(result.action.keyName).toBe("OPENAI_API_KEY");
      expect(result.action.redacted).toBe(true);
      // The action has no field that could carry the secret value.
      expect(JSON.stringify(result.action)).not.toContain("sk-leak-me");
    }
  });

  it("synthesizes a request id when the gateway omits one", () => {
    const result = classifyHermesEvent(event("clarify.request", {}));
    if (result.kind === "pending_action") {
      expect(result.action.requestId).toBeTruthy();
    }
  });
});

describe("classifyHermesEvent — clarify/approval responses are lifecycle, not pending", () => {
  it("does not surface a .response as a new pending action", () => {
    for (const name of ["clarify.response", "approval.response"]) {
      const result = classifyHermesEvent(event(name, { request_id: "x" }));
      expect(result.kind).not.toBe("pending_action");
    }
  });
});

describe("classifyHermesEvent — background activity", () => {
  it("maps subagent.* to background_activity with phase + identity", () => {
    const start = classifyHermesEvent(
      event("subagent.start", {
        subagent_id: "sub1",
        goal: "Research",
        parent_session_id: "sess-1",
      }),
    );
    expect(start.kind).toBe("background_activity");
    if (start.kind === "background_activity") {
      const activity: BackgroundHermesActivity = start.activity;
      expect(activity.subagentId).toBe("sub1");
      expect(activity.phase).toBe("start");
      expect(activity.goal).toBe("Research");
      expect(activity.parentSessionId).toBe("sess-1");
      expect(activity.lastEventAt).toBeTruthy();
    }

    expect(
      classifyHermesEvent(event("subagent.tool", { subagent_id: "s" })),
    ).toMatchObject({ kind: "background_activity" });
    expect(
      classifyHermesEvent(event("subagent.progress", { subagent_id: "s" })),
    ).toMatchObject({ kind: "background_activity" });
    expect(
      classifyHermesEvent(event("subagent.thinking", { subagent_id: "s" })),
    ).toMatchObject({ kind: "background_activity" });
    expect(
      classifyHermesEvent(event("subagent.complete", { subagent_id: "s" })),
    ).toMatchObject({ kind: "background_activity" });
  });

  it("maps subagent.error and subagent.blocked to their phases", () => {
    const err = classifyHermesEvent(
      event("subagent.error", { subagent_id: "s" }),
    );
    if (err.kind === "background_activity") {
      expect(err.activity.phase).toBe("error");
    } else {
      throw new Error("expected background_activity");
    }
    const blocked = classifyHermesEvent(
      event("subagent.blocked", { subagent_id: "s" }),
    );
    if (blocked.kind === "background_activity") {
      expect(blocked.activity.phase).toBe("blocked");
    }
  });

  it("accepts handle as an alias for subagent id", () => {
    const result = classifyHermesEvent(
      event("subagent.progress", { handle: "h-9", tool: "grep" }),
    );
    if (result.kind === "background_activity") {
      expect(result.activity.subagentId).toBe("h-9");
      expect(result.activity.handle).toBe("h-9");
      expect(result.activity.currentTool).toBe("grep");
    }
  });
});

describe("classifyHermesEvent — lifecycle", () => {
  it("maps gateway.ready, session.info, status.update, lifecycle.* to lifecycle", () => {
    for (const name of [
      "gateway.ready",
      "session.info",
      "status.update",
      "lifecycle.start",
      "lifecycle.complete",
      "session.start",
      "session.complete",
    ]) {
      const result = classifyHermesEvent(event(name, { status: "ready" }));
      expect(result.kind, `expected lifecycle for ${name}`).toBe("lifecycle");
      if (result.kind === "lifecycle") {
        expect(result.status).toBeTruthy();
      }
    }
  });
});

describe("classifyHermesEvent — error redaction", () => {
  it("keeps message and code but redacts secret-like payload fields", () => {
    const result = classifyHermesEvent(
      event("error", {
        message: "Upstream auth failed",
        code: 401,
        recoverable: false,
        authorization: "Bearer sk-super-secret-value",
        nested: { api_key: "leak", note: "fine" },
      }),
    );
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toBe("Upstream auth failed");
      expect(result.code).toBe(401);
      expect(result.recoverable).toBe(false);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("sk-super-secret-value");
      expect(serialized).not.toContain("leak");
    }
  });

  it("provides a fallback message when the error payload has none", () => {
    const result = classifyHermesEvent(event("error", { code: 500 }));
    if (result.kind === "error") {
      expect(result.message).toBeTruthy();
    }
  });
});

describe("classifyHermesEvent — unsupported sanitization", () => {
  it("sanitizes the payload it carries on unsupported events", () => {
    const result = classifyHermesEvent(
      event("totally.unknown", {
        secret: "hunter2",
        keep: "visible",
      }),
    );
    if (result.kind === "unsupported") {
      const serialized = JSON.stringify(result.sanitizedPayload);
      expect(serialized).not.toContain("hunter2");
      expect(serialized).toContain("visible");
    }
  });
});

describe("sanitizePayload", () => {
  it("masks sensitive keys (case-insensitive) at any depth", () => {
    const out = sanitizePayload({
      token: "abc",
      apiKey: "abc",
      api_key: "abc",
      Secret: "abc",
      password: "abc",
      private_key: "abc",
      privateKey: "abc",
      credential: "abc",
      Authorization: "abc",
      nested: { deep: { secret: "abc" } },
      list: [{ password: "abc" }],
      keep: "ok",
    }) as Record<string, unknown>;

    for (const key of [
      "token",
      "apiKey",
      "api_key",
      "Secret",
      "password",
      "private_key",
      "privateKey",
      "credential",
      "Authorization",
    ]) {
      expect(out[key], `${key} should be redacted`).toBe("[redacted]");
    }
    expect(
      (out.nested as Record<string, Record<string, unknown>>).deep.secret,
    ).toBe("[redacted]");
    expect((out.list as Record<string, unknown>[])[0].password).toBe(
      "[redacted]",
    );
    expect(out.keep).toBe("ok");
  });

  it("masks values that look like credentials even under a benign key", () => {
    const out = sanitizePayload({
      header: "Bearer abcdef123456",
      blob: "x".repeat(40),
      short: "hello",
    }) as Record<string, unknown>;
    expect(out.header).toBe("[redacted]");
    expect(out.blob).toBe("[redacted]");
    expect(out.short).toBe("hello");
  });

  it("does not mutate the input and tolerates cycles", () => {
    const input: Record<string, unknown> = { a: 1, password: "p" };
    input.self = input;
    const out = sanitizePayload(input) as Record<string, unknown>;
    expect(input.password).toBe("p"); // original untouched
    expect(out.password).toBe("[redacted]");
    expect(out.self).toBe("[circular]");
  });

  it("exposes isSensitiveKey for downstream tooling", () => {
    expect(isSensitiveKey("API_KEY")).toBe(true);
    expect(isSensitiveKey("username")).toBe(false);
  });
});

describe("exhaustive switch ergonomics", () => {
  it("lets a consumer switch on kind without a default and stay total", () => {
    // This is a compile-time guarantee made executable: every kind is handled.
    function describeEvent(e: JuneHermesEvent): string {
      switch (e.kind) {
        case "transcript":
          return "transcript";
        case "reasoning":
          return "reasoning";
        case "tool":
          return "tool";
        case "pending_action":
          return "pending";
        case "background_activity":
          return "background";
        case "lifecycle":
          return "lifecycle";
        case "error":
          return "error";
        case "unsupported":
          return "unsupported";
      }
    }
    const action: PendingHermesAction = {
      kind: "clarify",
      requestId: "x",
      question: "q",
    };
    expect(
      describeEvent({
        kind: "pending_action",
        sessionId: "s",
        action,
      }),
    ).toBe("pending");
  });
});

// The single shared mode parser the classifier and the chat runtime both use
// (deduped from two verbatim copies). Validating it here pins the one parse.
describe("parseHermesMode", () => {
  it("accepts the two known modes verbatim", () => {
    expect(parseHermesMode("sandboxed")).toBe("sandboxed");
    expect(parseHermesMode("unrestricted")).toBe("unrestricted");
  });

  it("returns undefined for anything else (no coercion, caller picks the default)", () => {
    expect(parseHermesMode(undefined)).toBeUndefined();
    expect(parseHermesMode(null)).toBeUndefined();
    expect(parseHermesMode("")).toBeUndefined();
    expect(parseHermesMode("SANDBOXED")).toBeUndefined();
    expect(parseHermesMode("restricted")).toBeUndefined();
    expect(parseHermesMode(1)).toBeUndefined();
    expect(parseHermesMode({})).toBeUndefined();
  });
});
