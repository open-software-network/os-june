import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { refreshAccessToken } from "@/lib/auth/session";
import { getServerEnv } from "@/lib/env/server";

export async function GET() {
  const env = getServerEnv();
  const access = await refreshAccessToken(randomUUID());
  return NextResponse.redirect(new URL(access ? "/" : "/?auth=expired", env.APP_ORIGIN));
}
