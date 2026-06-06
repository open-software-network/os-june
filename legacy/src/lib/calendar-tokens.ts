import { encryptSecret } from "@/lib/crypto";
import type { CalendarConnectionResult } from "@/lib/providers/calendar";

export function encryptedCalendarTokens(connected: CalendarConnectionResult) {
  return {
    accessToken: connected.accessToken ? encryptSecret(connected.accessToken) : undefined,
    refreshToken: connected.refreshToken ? encryptSecret(connected.refreshToken) : undefined,
  };
}
