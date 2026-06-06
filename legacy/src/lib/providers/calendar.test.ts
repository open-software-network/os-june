import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleCalendarProvider, MockCalendarProvider } from "@/lib/providers/calendar";

describe("MockCalendarProvider", () => {
  it("returns normalized upcoming events", async () => {
    const provider = new MockCalendarProvider();
    const connected = await provider.connect("jun@example.com");

    expect(connected.provider).toBe("mock-google");
    expect(connected.events[0]).toMatchObject({ title: "Daily Sync" });
  });
});

describe("GoogleCalendarProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds a Google OAuth URL with calendar readonly scope", () => {
    const provider = new GoogleCalendarProvider(
      "client_id",
      "client_secret",
      "http://localhost:3000/api/calendar/callback",
    );
    const url = provider.getAuthorizationUrl("signed_state");

    expect(url).toContain("https://accounts.google.com/o/oauth2/v2/auth?");
    expect(url).toContain("client_id=client_id");
    expect(url).toContain("calendar.readonly");
    expect(url).toContain("state=signed_state");
  });

  it("exchanges auth codes and normalizes Google Calendar events", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "access_123",
            refresh_token: "refresh_123",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                summary: "engineering sync",
                start: { dateTime: "2026-05-13T12:45:00Z" },
                end: { dateTime: "2026-05-13T13:00:00Z" },
                attendees: [{ email: "matt@example.com", displayName: "Matt" }],
              },
            ],
          }),
          { status: 200 },
        ),
      );

    const provider = new GoogleCalendarProvider(
      "client_id",
      "client_secret",
      "http://localhost:3000/api/calendar/callback",
    );
    const connected = await provider.connectWithCode("code_123");

    expect(connected).toMatchObject({
      provider: "google",
      accessToken: "access_123",
      refreshToken: "refresh_123",
      events: [{ title: "engineering sync", attendees: "Matt" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
