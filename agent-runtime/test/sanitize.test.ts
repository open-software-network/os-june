import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeForLog } from "../src/sanitize.ts";

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

test("bounds deeply nested log payloads", () => {
  let value: unknown = "leaf";
  for (let index = 0; index < 12; index += 1) value = { child: value };
  assert.match(JSON.stringify(sanitizeForLog(value)), /\[truncated\]/);
});
