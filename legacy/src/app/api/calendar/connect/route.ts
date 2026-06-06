import { getCalendarProvider } from "@/lib/providers/calendar";
import { prisma } from "@/lib/db";
import { handleRoute } from "@/lib/http";
import { getWorkspaceContext } from "@/lib/workspace";
import { createCalendarOAuthState } from "@/lib/calendar-oauth-state";
import { encryptedCalendarTokens } from "@/lib/calendar-tokens";

export async function POST() {
  return handleRoute(async () => {
    const { user, workspace } = await getWorkspaceContext();
    const provider = getCalendarProvider();
    if (provider.getAuthorizationUrl) {
      const authorizationUrl = provider.getAuthorizationUrl(
        createCalendarOAuthState({ userId: user.id, workspaceId: workspace.id }),
      );
      return { authorizationUrl };
    }

    const connected = await provider.connect(user.email);
    const tokens = encryptedCalendarTokens(connected);

    const connection = await prisma.calendarConnection.upsert({
      where: { workspaceId: workspace.id },
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
        workspaceId: workspace.id,
        provider: connected.provider,
        providerUserId: connected.providerUserId,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: connected.expiresAt,
        events: { create: connected.events },
      },
      include: { events: { orderBy: { startsAt: "asc" } } },
    });

    return { connection };
  });
}
