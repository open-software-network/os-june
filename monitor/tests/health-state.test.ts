import assert from "node:assert/strict";
import test from "node:test";
import type { HealthCheck } from "../lib/health.ts";
import { deriveOverallState } from "../lib/health-state.ts";

test("all healthy checks are operational", () => {
  assert.equal(deriveOverallState([check(true, "healthy"), check(false, "healthy")]), "operational");
});

test("a failed supporting check is degraded", () => {
  assert.equal(deriveOverallState([check(true, "healthy"), check(false, "unhealthy")]), "degraded");
});

test("a failed critical check is an outage", () => {
  assert.equal(deriveOverallState([check(true, "unhealthy"), check(false, "healthy")]), "outage");
});

function check(critical: boolean, state: HealthCheck["state"]): HealthCheck {
  return {
    id: critical ? "june-live" : "accounts-ready",
    group: "Test",
    label: "Check",
    description: "Check",
    state,
    latencyMs: 1,
    statusCode: state === "healthy" ? 200 : null,
    detail: state,
    critical,
  };
}
