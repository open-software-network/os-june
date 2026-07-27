import assert from "node:assert/strict";
import test from "node:test";
import { runtimeInterruptionFromSdk } from "../src/sdk-engine.ts";
import { REQUEST_SECRET_TOOL } from "../src/types.ts";

test("maps request_secret pauses without including a secret value", () => {
  const interruption = runtimeInterruptionFromSdk({
    id: "secret-1",
    name: "request_secret",
    arguments: JSON.stringify({ reason: "Authenticate a local command" }),
  });

  assert.deepEqual(interruption, {
    id: "secret-1",
    kind: "secret",
    toolName: "request_secret",
    arguments: { reason: "Authenticate a local command" },
    reason: "Authenticate a local command",
  });
  assert.equal(JSON.stringify(interruption).includes("secretValue"), false);
});

test("the built-in secret tool always pauses at the host keychain boundary", () => {
  assert.equal(REQUEST_SECRET_TOOL.name, "request_secret");
  assert.equal(REQUEST_SECRET_TOOL.requiresApproval, true);
});
