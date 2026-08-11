import assert from "node:assert/strict";
import test from "node:test";
import { runtimeInterruptionFromSdk } from "../src/sdk-engine.ts";
import { REQUEST_CLARIFICATION_TOOL } from "../src/types.ts";

test("keeps the SDK interruption id and tool call id as an explicit binding", () => {
  const interruption = runtimeInterruptionFromSdk({
    id: "approval-1",
    callId: "tool-call-1",
    name: "computer_use",
    arguments: JSON.stringify({ action: "capture", app: "Notes" }),
  });

  assert.deepEqual(interruption, {
    id: "approval-1",
    callId: "tool-call-1",
    kind: "approval",
    toolName: "computer_use",
    arguments: { action: "capture", app: "Notes" },
  });
});

test("maps request_clarification approval pauses to structured clarification interruptions", () => {
  const interruption = runtimeInterruptionFromSdk({
    id: "clarify-1",
    name: "request_clarification",
    arguments: JSON.stringify({
      question: "Which project should I update?",
      choices: ["Clovy", "Accounts"],
    }),
  });
  assert.deepEqual(interruption, {
    id: "clarify-1",
    kind: "clarification",
    toolName: "request_clarification",
    arguments: {
      question: "Which project should I update?",
      choices: ["Clovy", "Accounts"],
    },
    question: "Which project should I update?",
    choices: ["Clovy", "Accounts"],
  });
});

test("the built-in clarification tool always pauses for a user answer", () => {
  assert.equal(REQUEST_CLARIFICATION_TOOL.name, "request_clarification");
  assert.equal(REQUEST_CLARIFICATION_TOOL.requiresApproval, true);
  assert.deepEqual(REQUEST_CLARIFICATION_TOOL.parameters.required, ["question"]);
});
