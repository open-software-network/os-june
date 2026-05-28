import { describe, expect, it } from "vitest";
import { shouldBlockOnSignIn } from "../lib/account-gate";

describe("shouldBlockOnSignIn", () => {
  it("blocks when the user is not signed in", () => {
    expect(shouldBlockOnSignIn({ signedIn: false, configured: true })).toBe(
      true,
    );
  });

  it("allows when the user is signed in", () => {
    expect(
      shouldBlockOnSignIn({
        signedIn: true,
        configured: true,
        user: { id: "usr_1", handle: "jakub" },
        balance: { usdMillis: 0 },
      }),
    ).toBe(false);
  });
});
