import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { readRouteAuth } from "@/lib/auth/session";
import { collectHealthSnapshot } from "@/lib/health";

export const dynamic = "force-dynamic";

export async function GET() {
  const requestId = randomUUID();
  const auth = await readRouteAuth(requestId);
  if (auth.status === "denied") {
    return json({ message: "This account is not allowed to view the monitor" }, 403, requestId);
  }
  if (auth.status !== "authorized") {
    return json({ message: "Sign in first" }, 401, requestId);
  }
  return json(await collectHealthSnapshot(), 200, requestId);
}

function json(body: unknown, status: number, requestId: string) {
  const response = NextResponse.json(body, { status });
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("x-request-id", requestId);
  return response;
}
