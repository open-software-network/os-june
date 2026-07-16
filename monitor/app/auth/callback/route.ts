import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { requestAccountsApi } from "@/lib/api/accounts";
import { setTokenCookies } from "@/lib/auth/session";
import { getServerEnv } from "@/lib/env/server";

type TokenPair = { access_token: string; refresh_token: string };

export async function GET(request: NextRequest) {
  const env = getServerEnv();
  const cookieStore = await cookies();
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const verifier = cookieStore.get("june_monitor_pkce")?.value;
  const expectedState = cookieStore.get("june_monitor_state")?.value;
  cookieStore.delete("june_monitor_pkce");
  cookieStore.delete("june_monitor_state");

  if (!code || !verifier || !expectedState || state !== expectedState) {
    return NextResponse.redirect(new URL("/?auth=failed", env.APP_ORIGIN));
  }

  try {
    const token = await requestAccountsApi<TokenPair>("/auth/token", {
      method: "POST",
      body: {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: `${env.APP_ORIGIN}/auth/callback`,
      },
    });
    if (!token.success || !token.data) {
      return NextResponse.redirect(new URL("/?auth=failed", env.APP_ORIGIN));
    }
    await setTokenCookies(token.data);
    return NextResponse.redirect(new URL("/", env.APP_ORIGIN));
  } catch {
    return NextResponse.redirect(new URL("/?auth=failed", env.APP_ORIGIN));
  }
}
