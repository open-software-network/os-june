import "server-only";

import { cookies } from "next/headers";
import { requestAccountsApi } from "@/lib/api/accounts";
import { isAllowedUser } from "@/lib/auth/allowlist";
import { getServerEnv } from "@/lib/env/server";

const ACCESS_COOKIE = "june_monitor_access";
const REFRESH_COOKIE = "june_monitor_refresh";
const EXPIRED_ACCESS_TOKEN = 3001;

export type AccountUser = {
  id: string;
  handle: string;
  email: string | null;
  display_name?: string | null;
  avatar_url?: string | null;
};

type TokenPair = { access_token: string; refresh_token: string };

export type AuthResult =
  | { status: "authorized"; user: AccountUser }
  | { status: "denied"; user: AccountUser }
  | { status: "signed_out" }
  | { status: "expired" };

export async function readPageAuth(): Promise<AuthResult> {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get(ACCESS_COOKIE)?.value;
  if (!accessToken) {
    return cookieStore.has(REFRESH_COOKIE) ? { status: "expired" } : { status: "signed_out" };
  }
  const user = await getAccountUser(accessToken);
  if (user.status === "expired") return { status: "expired" };
  if (user.status === "failed") return { status: "signed_out" };
  return authorizeUser(user.user);
}

export async function readRouteAuth(requestId: string): Promise<AuthResult> {
  const cookieStore = await cookies();
  let accessToken = cookieStore.get(ACCESS_COOKIE)?.value;
  if (!accessToken) accessToken = await refreshAccessToken(requestId);
  if (!accessToken) return { status: "signed_out" };

  let user = await getAccountUser(accessToken, requestId);
  if (user.status === "expired") {
    accessToken = await refreshAccessToken(requestId);
    if (!accessToken) return { status: "signed_out" };
    user = await getAccountUser(accessToken, requestId);
  }
  if (user.status !== "ok") return { status: "signed_out" };
  return authorizeUser(user.user);
}

export async function setTokenCookies(token: TokenPair): Promise<void> {
  const cookieStore = await cookies();
  const secure = new URL(getServerEnv().APP_ORIGIN).protocol === "https:";
  const options = { httpOnly: true, sameSite: "lax" as const, secure, path: "/" };
  cookieStore.set(ACCESS_COOKIE, token.access_token, options);
  cookieStore.set(REFRESH_COOKIE, token.refresh_token, options);
}

export async function refreshAccessToken(requestId: string): Promise<string | undefined> {
  const cookieStore = await cookies();
  const refreshToken = cookieStore.get(REFRESH_COOKIE)?.value;
  if (!refreshToken) return undefined;
  try {
    const response = await requestAccountsApi<TokenPair>("/auth/refresh", {
      method: "POST",
      requestId,
      body: { refresh_token: refreshToken },
    });
    if (!response.success || !response.data) {
      await clearTokenCookies();
      return undefined;
    }
    await setTokenCookies(response.data);
    return response.data.access_token;
  } catch {
    await clearTokenCookies();
    return undefined;
  }
}

export async function clearTokenCookies(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(ACCESS_COOKIE);
  cookieStore.delete(REFRESH_COOKIE);
}

export async function logoutFromAccounts(): Promise<void> {
  const cookieStore = await cookies();
  const refreshToken = cookieStore.get(REFRESH_COOKIE)?.value;
  if (refreshToken) {
    try {
      await requestAccountsApi<unknown>("/auth/logout", {
        method: "POST",
        body: { refresh_token: refreshToken },
      });
    } catch {
      // Local sign-out must still succeed if OS Accounts is unavailable.
    }
  }
  await clearTokenCookies();
}

function authorizeUser(user: AccountUser): AuthResult {
  return isAllowedUser(user.id, getServerEnv().ALLOWED_USER_IDS)
    ? { status: "authorized", user }
    : { status: "denied", user };
}

async function getAccountUser(
  accessToken: string,
  requestId?: string,
): Promise<
  | { status: "ok"; user: AccountUser }
  | { status: "expired" }
  | { status: "failed" }
> {
  try {
    const response = await requestAccountsApi<AccountUser>("/me", {
      authorization: `Bearer ${accessToken}`,
      requestId,
    });
    if (response.success && response.data) return { status: "ok", user: response.data };
    if (response.error_code === EXPIRED_ACCESS_TOKEN) return { status: "expired" };
    return { status: "failed" };
  } catch {
    return { status: "failed" };
  }
}
