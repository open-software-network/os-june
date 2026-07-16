import type { HealthCheck, OverallState } from "./health.ts";

export function deriveOverallState(checks: readonly HealthCheck[]): OverallState {
  if (checks.some((check) => check.critical && check.state === "unhealthy")) return "outage";
  if (checks.some((check) => check.state === "unhealthy")) return "degraded";
  return "operational";
}
