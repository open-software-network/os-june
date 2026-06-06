import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCalendarProvider } from "@/lib/providers/calendar";
import { requireUser } from "@/lib/auth";
import { verifyCalendarOAuthState } from "@/lib/calendar-oauth-state";
import { encryptedCalendarTokens } from "@/lib/calendar-tokens";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const appUrl = process.env.APP_URL ?? "http://localhost:3000";

  if (!code || !state) {
    redirect(`${appUrl}?calendar=missing_code`);
  }

  let statePayload: ReturnType<typeof verifyCalendarOAuthState>;
  try {
    statePayload = verifyCalendarOAuthState(state);
  } catch {
    redirect(`${appUrl}?calendar=invalid_state`);
  }

  let user: Awaited<ReturnType<typeof requireUser>>;
  try {
    user = await requireUser();
  } catch {
    redirect(`${appUrl}?calendar=invalid_state`);
  }
  if (statePayload.userId !== user.id) {
    redirect(`${appUrl}?calendar=invalid_state`);
  }
  const membership = await prisma.membership.findFirst({
    where: { userId: user.id, workspaceId: statePayload.workspaceId },
  });
  if (!membership) {
    redirect(`${appUrl}?calendar=invalid_state`);
  }

  const provider = getCalendarProvider();
  if (!provider.connectWithCode) {
    redirect(`${appUrl}?calendar=unsupported`);
  }

  const connected = await provider.connectWithCode(code);
  const tokens = encryptedCalendarTokens(connected);
  await prisma.calendarConnection.upsert({
    where: { workspaceId: statePayload.workspaceId },
    update: {
      provider: connected.provider,
      providerUserId: connected.providerUserId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: connected.expiresAt,
      events: {
        deleteMany: {},
        create: connected.events,
      },
    },
    create: {
      workspaceId: statePayload.workspaceId,
      provider: connected.provider,
      providerUserId: connected.providerUserId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: connected.expiresAt,
      events: { create: connected.events },
    },
  });

  redirect(`${appUrl}?calendar=connected`);
}
