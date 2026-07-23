import assert from "node:assert/strict";
import test from "node:test";
import { runtimeInterruptionFromSdk } from "../src/sdk-engine.ts";
import { REQUEST_CLARIFICATION_TOOL } from "../src/types.ts";

test("maps request_clarification approval pauses to structured clarification interruptions", () => {
  const interruption = runtimeInterruptionFromSdk({
    id: "clarify-1",
    name: "request_clarification",
    arguments: JSON.stringify({
      question: "Which project should I update?",
      choices: ["June", "Accounts"],
    }),
  });
  assert.deepEqual(interruption, {
    id: "clarify-1",
    kind: "clarification",
    toolName: "request_clarification",
    arguments: {
      question: "Which project should I update?",
      choices: ["June", "Accounts"],
    },
    question: "Which project should I update?",
    choices: ["June", "Accounts"],
  });
});

test("the built-in clarification tool always pauses for a user answer", () => {
  assert.equal(REQUEST_CLARIFICATION_TOOL.name, "request_clarification");
  assert.equal(REQUEST_CLARIFICATION_TOOL.requiresApproval, true);
  assert.deepEqual(REQUEST_CLARIFICATION_TOOL.parameters.required, ["question"]);
});
