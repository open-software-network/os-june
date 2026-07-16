import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getServerEnv } from "@/lib/env/server";

export async function GET() {
  const env = getServerEnv();
  if (!env.OS_ACCOUNTS_CLIENT_ID) {
    return NextResponse.redirect(new URL("/?auth=configuration", env.APP_ORIGIN));
  }

  const verifier = base64Url(randomBytes(32));
  const state = base64Url(randomBytes(24));
  const secure = new URL(env.APP_ORIGIN).protocol === "https:";
  const flowCookie = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge: 600,
  };
  const cookieStore = await cookies();
  cookieStore.set("june_monitor_pkce", verifier, flowCookie);
  cookieStore.set("june_monitor_state", state, flowCookie);

  const login = new URL("/login", env.OS_ACCOUNTS_URL);
  login.searchParams.set("client_id", env.OS_ACCOUNTS_CLIENT_ID);
  login.searchParams.set("redirect_uri", `${env.APP_ORIGIN}/auth/callback`);
  login.searchParams.set("scope", "profile:read");
  login.searchParams.set("state", state);
  login.searchParams.set("code_challenge", base64Url(createHash("sha256").update(verifier).digest()));
  login.searchParams.set("code_challenge_method", "S256");
  return NextResponse.redirect(login);
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
