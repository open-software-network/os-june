import { afterEach, describe, expect, it } from "vitest";
import { createCalendarOAuthState, verifyCalendarOAuthState } from "@/lib/calendar-oauth-state";

describe("calendar OAuth state", () => {
  afterEach(() => {
    delete process.env.CALENDAR_OAUTH_STATE_SECRET;
  });

  it("round-trips signed user and workspace state", () => {
    process.env.CALENDAR_OAUTH_STATE_SECRET = "state-secret";
    const state = createCalendarOAuthState({
      userId: "user_1",
      workspaceId: "workspace_1",
      now: new Date("2026-06-01T00:00:00Z"),
    });

    expect(verifyCalendarOAuthState(state, new Date("2026-06-01T00:05:00Z"))).toMatchObject({
      userId: "user_1",
      workspaceId: "workspace_1",
    });
  });

  it("rejects tampered state", () => {
    process.env.CALENDAR_OAUTH_STATE_SECRET = "state-secret";
    const state = createCalendarOAuthState({ userId: "user_1", workspaceId: "workspace_1" });
    const [payload, signature] = state.split(".");
    const tampered = `${Buffer.from(JSON.stringify({ v: 1, userId: "user_1", workspaceId: "other", exp: 9999999999, nonce: "n" })).toString("base64url")}.${signature}`;

    expect(payload).toBeTruthy();
    expect(() => verifyCalendarOAuthState(tampered)).toThrow("Invalid calendar OAuth state");
  });

  it("rejects expired state", () => {
    process.env.CALENDAR_OAUTH_STATE_SECRET = "state-secret";
    const state = createCalendarOAuthState({
      userId: "user_1",
      workspaceId: "workspace_1",
      now: new Date("2026-06-01T00:00:00Z"),
    });

    expect(() => verifyCalendarOAuthState(state, new Date("2026-06-01T00:11:00Z"))).toThrow(
      "Expired calendar OAuth state",
    );
  });
});
