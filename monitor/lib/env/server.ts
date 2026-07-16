import "server-only";

import { parseAllowedUserIds } from "@/lib/auth/allowlist";

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export type ServerEnv = {
  OS_ACCOUNTS_URL: string;
  OS_ACCOUNTS_API_URL: string;
  OS_ACCOUNTS_CLIENT_ID: string;
  APP_ORIGIN: string;
  ALLOWED_USER_IDS: ReadonlySet<string>;
  HEALTH_PROBE_TIMEOUT_MS: number;
  serviceOrigins: Readonly<Record<string, string>>;
};

export function getServerEnv(): ServerEnv {
  const serviceOrigins = {
    JUNE_API_URL: serviceOrigin("JUNE_API_URL", "https://june-api.opensoftware.co"),
    OS_API_URL: serviceOrigin("OS_API_URL", "https://api.opensoftware.co"),
    OS_ACCOUNTS_API_URL: serviceOrigin(
      "OS_ACCOUNTS_API_URL",
      "https://accounts-api.opensoftware.co",
    ),
    CHAT_API_URL: serviceOrigin("CHAT_API_URL", "https://chat-api.opensoftware.co"),
    CHAT_INFERENCE_URL: serviceOrigin(
      "CHAT_INFERENCE_URL",
      "https://chat-inference.opensoftware.co",
    ),
    CHAT_SYNC_URL: serviceOrigin("CHAT_SYNC_URL", "https://chat-sync.opensoftware.co"),
    OS_APP_URL: serviceOrigin("OS_APP_URL", "https://app.opensoftware.co"),
    OS_ACCOUNTS_URL: serviceOrigin("OS_ACCOUNTS_URL", "https://accounts.opensoftware.co"),
    CHAT_WEB_URL: serviceOrigin("CHAT_WEB_URL", "https://chat.opensoftware.co"),
    HEALTH_DASHBOARD_PROBE_URL: serviceOrigin(
      "HEALTH_DASHBOARD_PROBE_URL",
      "https://os-june-monitor-production.up.railway.app",
    ),
  };
  return {
    OS_ACCOUNTS_URL: serviceOrigins.OS_ACCOUNTS_URL,
    OS_ACCOUNTS_API_URL: serviceOrigins.OS_ACCOUNTS_API_URL,
    OS_ACCOUNTS_CLIENT_ID: process.env.OS_ACCOUNTS_CLIENT_ID?.trim() ?? "",
    APP_ORIGIN: normalizeOrigin(process.env.APP_ORIGIN ?? "http://localhost:3010"),
    ALLOWED_USER_IDS: parseAllowedUserIds(
      process.env.HEALTH_DASHBOARD_AUTHORIZED_USER_IDS ?? "",
    ),
    HEALTH_PROBE_TIMEOUT_MS: parseProbeTimeout(process.env.HEALTH_PROBE_TIMEOUT_MS),
    serviceOrigins,
  };
}

function serviceOrigin(name: string, fallback: string): string {
  return normalizeOrigin(process.env[name] ?? fallback);
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
