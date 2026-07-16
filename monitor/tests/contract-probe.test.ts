import assert from "node:assert/strict";
import test from "node:test";
import { matchesContractResponse } from "../lib/contract-probe.ts";

test("matches the expected auth contract", () => {
  assert.equal(matchesContractResponse(401, { error_code: 3001 }, 401, 3001), true);
});

test("rejects an unexpected status code", () => {
  assert.equal(matchesContractResponse(404, { error_code: 3001 }, 401, 3001), false);
});

test("rejects an unexpected error envelope", () => {
  assert.equal(matchesContractResponse(401, { error_code: 3002 }, 401, 3001), false);
  assert.equal(matchesContractResponse(401, null, 401, 3001), false);
});

test("supports status-only contracts", () => {
  assert.equal(matchesContractResponse(204, null, 204), true);
});
