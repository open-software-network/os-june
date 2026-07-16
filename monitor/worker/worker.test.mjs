import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStateChangeMessage,
  failureIds,
  sameFailures,
  shouldPostOutage,
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

test("builds outage messages with state markers", () => {
  const incident = buildStateChangeMessage([], ["failed"], snapshot, "https://health.opensoftware.co");
  assert.match(incident, /outage detected/);
  assert.match(incident, /Failed API/);
  assert.match(incident, /\[os-health-outage\] failed/);
});

test("posts only new or changed active outages", () => {
  assert.equal(shouldPostOutage(null, []), false);
  assert.equal(shouldPostOutage(null, ["failed"]), true);
  assert.equal(shouldPostOutage([], ["failed"]), true);
  assert.equal(shouldPostOutage(["failed"], ["failed"]), false);
  assert.equal(shouldPostOutage(["failed"], []), false);
  assert.equal(shouldPostOutage(["failed"], ["other"]), true);
});
