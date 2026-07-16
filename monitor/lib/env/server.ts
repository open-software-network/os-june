import "server-only";

import { parseAllowedUserIds } from "@/lib/auth/allowlist";

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export type ServerEnv = {
  JUNE_API_URL: string;
  OS_ACCOUNTS_URL: string;
  OS_ACCOUNTS_API_URL: string;
  OS_ACCOUNTS_CLIENT_ID: string;
  APP_ORIGIN: string;
  ALLOWED_USER_IDS: ReadonlySet<string>;
  HEALTH_PROBE_TIMEOUT_MS: number;
};

export function getServerEnv(): ServerEnv {
  return {
    JUNE_API_URL: normalizeOrigin(
      process.env.JUNE_API_URL ?? "https://june-api.opensoftware.co",
    ),
    OS_ACCOUNTS_URL: normalizeOrigin(
      process.env.OS_ACCOUNTS_URL ?? "https://accounts.opensoftware.co",
    ),
    OS_ACCOUNTS_API_URL: normalizeOrigin(
      process.env.OS_ACCOUNTS_API_URL ?? "https://accounts-api.opensoftware.co",
    ),
    OS_ACCOUNTS_CLIENT_ID: process.env.OS_ACCOUNTS_CLIENT_ID?.trim() ?? "",
    APP_ORIGIN: normalizeOrigin(process.env.APP_ORIGIN ?? "http://localhost:3010"),
    ALLOWED_USER_IDS: parseAllowedUserIds(
      process.env.HEALTH_DASHBOARD_AUTHORIZED_USER_IDS ?? "",
    ),
    HEALTH_PROBE_TIMEOUT_MS: parseProbeTimeout(process.env.HEALTH_PROBE_TIMEOUT_MS),
  };
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`Expected an origin without a path: ${value}`);
  }
  return url.origin;
}

function parseProbeTimeout(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_PROBE_TIMEOUT_MS;
  return Math.min(15_000, Math.max(500, parsed));
}
