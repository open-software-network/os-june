import { NextResponse } from "next/server";
import { logoutFromAccounts } from "@/lib/auth/session";
import { getServerEnv } from "@/lib/env/server";

export async function POST() {
  await logoutFromAccounts();
  return NextResponse.redirect(new URL("/", getServerEnv().APP_ORIGIN), 303);
}
