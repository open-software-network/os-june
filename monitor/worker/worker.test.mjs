import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDigestMessage,
  buildStateChangeMessage,
  failureIds,
  sameFailures,
  shouldSendDigest,
  zonedDateAndHour,
} from "./worker.mjs";

const snapshot = {
  checks: [
    { id: "healthy", label: "Healthy", state: "healthy", detail: "Ready", statusCode: 200 },
    { id: "failed", label: "Failed API", state: "unhealthy", detail: "HTTP 503", statusCode: 503 },
  ],
};

test("sorts the failing check ids", () => {
  assert.deepEqual(failureIds(snapshot), ["failed"]);
  assert.equal(sameFailures(["a", "b"], ["a", "b"]), true);
  assert.equal(sameFailures(["a"], ["b"]), false);
});

test("builds incident and recovery messages with state markers", () => {
  const incident = buildStateChangeMessage([], ["failed"], snapshot, "https://health.opensoftware.co");
  assert.match(incident, /incident detected/);
  assert.match(incident, /Failed API/);
  assert.match(incident, /\[os-health-state\] failed/);

  const recovery = buildStateChangeMessage(["failed"], [], { checks: [snapshot.checks[0]] }, "https://health.opensoftware.co");
  assert.match(recovery, /recovered/);
  assert.match(recovery, /\[os-health-state\] healthy/);
});

test("builds a daily digest", () => {
  const message = buildDigestMessage(snapshot, "https://health.opensoftware.co");
  assert.match(message, /1\/2 checks healthy/);
  assert.match(message, /\[os-health-digest\]/);
});

test("sends one digest after the configured local hour", () => {
  const now = new Date("2026-07-16T13:05:00.000Z");
  assert.deepEqual(zonedDateAndHour(now, "America/New_York"), { date: "2026-07-16", hour: 9 });
  assert.equal(shouldSendDigest(now, "America/New_York", 9, "2026-07-15"), true);
  assert.equal(shouldSendDigest(now, "America/New_York", 9, "2026-07-16"), false);
});
