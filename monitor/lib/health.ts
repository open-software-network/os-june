import "server-only";

import checkDefinitions from "@/checks.json";
import { matchesContractResponse } from "@/lib/contract-probe";
import { getServerEnv } from "@/lib/env/server";
import { deriveOverallState } from "@/lib/health-state";

export type CheckState = "healthy" | "unhealthy";
export type OverallState = "operational" | "degraded" | "outage";

export type HealthCheck = {
  id: string;
  group: string;
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

type CheckDefinition = {
  id: string;
  group: string;
  label: string;
  description: string;
  envVar: string;
  defaultOrigin: string;
  path: string;
  critical: boolean;
  healthyDetail: string;
  parseHealth?: boolean;
  method?: "GET" | "POST";
  body?: unknown;
  expectedStatusCode?: number;
  expectedErrorCode?: number;
};

export async function collectHealthSnapshot(): Promise<HealthSnapshot> {
  const env = getServerEnv();
  const results = await Promise.all(
    (checkDefinitions as CheckDefinition[]).map((definition) =>
      probe({
        ...definition,
        url: `${env.serviceOrigins[definition.envVar] ?? definition.defaultOrigin}${definition.path}`,
        body: definition.body === undefined ? undefined : JSON.stringify(definition.body),
        timeoutMs: env.HEALTH_PROBE_TIMEOUT_MS,
      }),
    ),
  );
  const checks = results.map((result) => result.check);
  const juneMetadata = results.find((result) => result.definitionId === "june-health")?.metadata;

  return {
    status: deriveOverallState(checks),
    checkedAt: new Date().toISOString(),
    target: env.APP_ORIGIN,
    service: "Open Software production",
    version: juneMetadata?.version ?? null,
    checks,
  };
}

type ProbeInput = CheckDefinition & {
  url: string;
  timeoutMs: number;
  body?: string;
};

async function probe(input: ProbeInput): Promise<{
  definitionId: string;
  check: HealthCheck;
  metadata?: { service?: string; version?: string };
}> {
  const startedAt = performance.now();
  try {
    const response = await fetch(input.url, {
      cache: "no-store",
      method: input.method ?? "GET",
      headers: {
        accept: input.parseHealth || input.expectedErrorCode ? "application/json" : "text/plain",
        ...(input.body ? { "content-type": "application/json" } : {}),
      },
      body: input.body,
      signal: AbortSignal.timeout(input.timeoutMs),
    });
    const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
    let metadata: { service?: string; version?: string } | undefined;
    let detail = input.healthyDetail;

    if (input.expectedStatusCode !== undefined) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      const healthy = matchesContractResponse(
        response.status,
        body,
        input.expectedStatusCode,
        input.expectedErrorCode,
      );
      return {
        definitionId: input.id,
        check: makeCheck(
          input,
          healthy ? "healthy" : "unhealthy",
          latencyMs,
          response.status,
          healthy ? input.healthyDetail : "Unexpected API contract response",
        ),
      };
    }

    if (input.parseHealth && response.ok) {
      const body = (await response.json()) as HealthEnvelope;
      metadata = body.data ?? undefined;
      if (!body.success || body.data?.status !== "healthy") {
        return {
          definitionId: input.id,
          check: makeCheck(input, "unhealthy", latencyMs, response.status, "Invalid health response"),
          metadata,
        };
      }
      detail = [body.data.service, body.data.version ? `v${body.data.version}` : undefined]
        .filter(Boolean)
        .join(" ");
    }

    return {
      definitionId: input.id,
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
    return {
      definitionId: input.id,
      check: makeCheck(input, "unhealthy", latencyMs, null, detail),
    };
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
    group: input.group,
    label: input.label,
    description: input.description,
    state,
    latencyMs,
    statusCode,
    detail,
    critical: input.critical,
  };
}
