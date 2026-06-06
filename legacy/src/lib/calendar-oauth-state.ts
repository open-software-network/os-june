import { createHmac, randomBytes, timingSafeEqual } from "crypto";

const STATE_TTL_SECONDS = 10 * 60;

type CalendarOAuthStatePayload = {
  v: 1;
  userId: string;
  workspaceId: string;
  exp: number;
  nonce: string;
};

export function createCalendarOAuthState(input: { userId: string; workspaceId: string; now?: Date }) {
  const now = input.now ?? new Date();
  const payload: CalendarOAuthStatePayload = {
    v: 1,
    userId: input.userId,
    workspaceId: input.workspaceId,
    exp: Math.floor(now.getTime() / 1000) + STATE_TTL_SECONDS,
    nonce: randomBytes(16).toString("base64url"),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

export function verifyCalendarOAuthState(state: string, now = new Date()) {
  const [encodedPayload, signature] = state.split(".");
  if (!encodedPayload || !signature || state.split(".").length !== 2) {
    throw new Error("Invalid calendar OAuth state");
  }
  if (!constantTimeEqual(signature, sign(encodedPayload))) {
    throw new Error("Invalid calendar OAuth state");
  }
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as CalendarOAuthStatePayload;
  if (payload.v !== 1 || !payload.userId || !payload.workspaceId || !payload.exp) {
    throw new Error("Invalid calendar OAuth state");
  }
  if (payload.exp < Math.floor(now.getTime() / 1000)) {
    throw new Error("Expired calendar OAuth state");
  }
  return payload;
}

function sign(payload: string) {
  return createHmac("sha256", stateSecret()).update(payload).digest("base64url");
}

function stateSecret() {
  const secret =
    process.env.CALENDAR_OAUTH_STATE_SECRET || process.env.APP_ENCRYPTION_KEY || process.env.OPEN_NOTEPAD_SECRET;
  if (!secret) {
    throw new Error("CALENDAR_OAUTH_STATE_SECRET is required for Google Calendar OAuth");
  }
  return secret;
}

function constantTimeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
