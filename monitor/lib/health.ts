import "server-only";

import { getServerEnv } from "@/lib/env/server";
import { deriveOverallState } from "@/lib/health-state";

export type CheckState = "healthy" | "unhealthy";
export type OverallState = "operational" | "degraded" | "outage";

export type HealthCheck = {
  id: "june-live" | "june-ready" | "june-health" | "accounts-ready";
  label: string;
  description: string;
  state: CheckState;
  latencyMs: number;
  statusCode: number | null;
  detail: string;
  critical: boolean;
};

export type HealthSnapshot = {
  status: OverallState;
  checkedAt: string;
  target: string;
  service: string;
  version: string | null;
  checks: HealthCheck[];
};

type HealthEnvelope = {
  success?: boolean;
  data?: { status?: string; service?: string; version?: string } | null;
};

export async function collectHealthSnapshot(): Promise<HealthSnapshot> {
  const env = getServerEnv();
  const [live, ready, summary, accounts] = await Promise.all([
    probe({
      id: "june-live",
      label: "API process",
      description: "June API liveness",
      url: `${env.JUNE_API_URL}/livez`,
      critical: true,
      healthyDetail: "Process is accepting connections",
      timeoutMs: env.HEALTH_PROBE_TIMEOUT_MS,
    }),
    probe({
      id: "june-ready",
      label: "Request readiness",
      description: "June API traffic gate",
      url: `${env.JUNE_API_URL}/readyz`,
      critical: true,
      healthyDetail: "Ready to serve requests",
      timeoutMs: env.HEALTH_PROBE_TIMEOUT_MS,
    }),
    probe({
      id: "june-health",
      label: "Deployment",
      description: "Service identity and build",
      url: `${env.JUNE_API_URL}/healthz`,
      critical: false,
      healthyDetail: "Build metadata is available",
      timeoutMs: env.HEALTH_PROBE_TIMEOUT_MS,
      parseHealth: true,
    }),
    probe({
      id: "accounts-ready",
      label: "Identity dependency",
      description: "OS Accounts readiness",
      url: `${env.OS_ACCOUNTS_API_URL}/ready`,
      critical: false,
      healthyDetail: "Login dependency is ready",
      timeoutMs: env.HEALTH_PROBE_TIMEOUT_MS,
    }),
  ]);
  const checks = [live.check, ready.check, summary.check, accounts.check];
  return {
    status: deriveOverallState(checks),
    checkedAt: new Date().toISOString(),
    target: env.JUNE_API_URL,
    service: summary.metadata?.service ?? "june-api",
    version: summary.metadata?.version ?? null,
    checks,
  };
}

type ProbeInput = {
  id: HealthCheck["id"];
  label: string;
  description: string;
  url: string;
  critical: boolean;
  healthyDetail: string;
  timeoutMs: number;
  parseHealth?: boolean;
};

async function probe(input: ProbeInput): Promise<{
  check: HealthCheck;
  metadata?: { service?: string; version?: string };
}> {
  const startedAt = performance.now();
  try {
    const response = await fetch(input.url, {
      cache: "no-store",
      headers: { accept: input.parseHealth ? "application/json" : "text/plain" },
      signal: AbortSignal.timeout(input.timeoutMs),
    });
    const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
    let metadata: { service?: string; version?: string } | undefined;
    let detail = input.healthyDetail;
    if (input.parseHealth && response.ok) {
      const body = (await response.json()) as HealthEnvelope;
      metadata = body.data ?? undefined;
      if (!body.success || body.data?.status !== "healthy") {
        return {
          check: makeCheck(input, "unhealthy", latencyMs, response.status, "Invalid health response"),
          metadata,
        };
      }
      detail = [body.data.service, body.data.version ? `v${body.data.version}` : undefined]
        .filter(Boolean)
        .join(" ");
    }
    return {
      check: makeCheck(
        input,
        response.ok ? "healthy" : "unhealthy",
        latencyMs,
        response.status,
        response.ok ? detail : `HTTP ${response.status}`,
      ),
      metadata,
    };
  } catch (error) {
    const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
    const detail = error instanceof Error && error.name === "TimeoutError" ? "Probe timed out" : "Unreachable";
    return { check: makeCheck(input, "unhealthy", latencyMs, null, detail) };
  }
}

function makeCheck(
  input: ProbeInput,
  state: CheckState,
  latencyMs: number,
  statusCode: number | null,
  detail: string,
): HealthCheck {
  return {
    id: input.id,
    label: input.label,
    description: input.description,
    state,
    latencyMs,
    statusCode,
    detail,
    critical: input.critical,
  };
}
