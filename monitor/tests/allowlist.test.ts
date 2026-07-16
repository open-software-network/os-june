import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedUser, parseAllowedUserIds } from "../lib/auth/allowlist.ts";

test("an empty allowlist fails closed", () => {
  const allowlist = parseAllowedUserIds("");
  assert.equal(allowlist.size, 0);
  assert.equal(isAllowedUser("usr_june", allowlist), false);
});

test("valid user ids are trimmed and matched exactly", () => {
  const allowlist = parseAllowedUserIds(" usr_alpha,usr_beta-2, usr_alpha ");
  assert.deepEqual([...allowlist], ["usr_alpha", "usr_beta-2"]);
  assert.equal(isAllowedUser("usr_alpha", allowlist), true);
  assert.equal(isAllowedUser("USR_ALPHA", allowlist), false);
});

test("malformed entries never grant access", () => {
  const allowlist = parseAllowedUserIds("*,alpha,usr_valid, https://example.com");
  assert.deepEqual([...allowlist], ["usr_valid"]);
});
