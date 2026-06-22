import { describe, expect, it } from "vitest";

import { isPolicyBlockedMessage } from "../lib/errors";

describe("isPolicyBlockedMessage", () => {
  it("matches canonical policy block markers", () => {
    expect(isPolicyBlockedMessage("policy_blocked")).toBe(true);
    expect(
      isPolicyBlockedMessage(
        "Error: Error code: 403 - {'data': None, 'success': False, 'error_code': 4031, 'message': 'policy_blocked'}",
      ),
    ).toBe(true);
  });

  it("does not treat generic HTTP 403 errors as policy blocks", () => {
    expect(isPolicyBlockedMessage("Error: Error code: 403 - Unauthorized")).toBe(
      false,
    );
    expect(
      isPolicyBlockedMessage("Error: Error code: 403 - rate limit exceeded"),
    ).toBe(false);
  });
});
