import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFailureDetails, sanitizeForLog } from "../src/sanitize.ts";

test("redacts secret fields and credential-like strings", () => {
  assert.deepEqual(
    sanitizeForLog({
      authorization: "Bearer live-secret",
      nested: { apiKey: "sk_live_abcdefghijklmnop", safe: "Bearer another-secret" },
    }),
    {
      authorization: "[redacted]",
      nested: { apiKey: "[redacted]", safe: "Bearer [redacted]" },
    },
  );
});

test("redacts named secrets embedded in error and shell-output strings", () => {
  const sanitized = sanitizeForLog(
    'request failed: {"access_token":"plain-value","password":"two words"} api_key=plain-key',
  );

  assert.equal(
    sanitized,
    'request failed: {"access_token":"[redacted]","password":"[redacted]"} api_key=[redacted]',
  );
});

test("redacts complete authorization and cookie header values", () => {
  assert.equal(
    sanitizeForLog(
      "Authorization: Basic dXNlcjpwYXNz\nCookie: session=abc; csrf=def\nstatus=failed",
    ),
    "Authorization: [redacted]\nCookie: [redacted]\nstatus=failed",
  );
});

test("bounds deeply nested log payloads", () => {
  let value: unknown = "leaf";
  for (let index = 0; index < 12; index += 1) value = { child: value };
  assert.match(JSON.stringify(sanitizeForLog(value)), /\[truncated\]/);
});

test("classifies tagged tool failures without exposing credentials", () => {
  const error = Object.assign(new Error("tool failed with Bearer live-secret"), {
    failureCategory: "tool",
    failureCode: "agent_tool_failed",
  });

  assert.deepEqual(runtimeFailureDetails(error), {
    message: "tool failed with Bearer [redacted]",
    category: "tool",
    code: "agent_tool_failed",
    retryable: false,
  });
});

test("separates provider, context, credit, and local runtime failures", () => {
  assert.equal(runtimeFailureDetails(new Error("provider returned 503")).category, "provider");
  assert.equal(runtimeFailureDetails(new Error("agent_chat_failed")).category, "provider");
  assert.equal(runtimeFailureDetails(new Error("maximum context length reached")).category, "context");
  assert.equal(runtimeFailureDetails(new Error("402 insufficient credits")).category, "credits");
  assert.equal(runtimeFailureDetails(new Error("unexpected local failure")).category, "runtime");
});
