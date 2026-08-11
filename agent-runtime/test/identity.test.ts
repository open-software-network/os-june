import assert from "node:assert/strict";
import test from "node:test";
import { CLOVY_IDENTITY_REPLY, clovyIdentityResult } from "../src/identity.ts";
import type { RunStartParams } from "../src/types.ts";

const params = (input: string, attachments: RunStartParams["attachments"] = []): RunStartParams => ({
  model: "open-software/auto",
  instructions: "Answer the user.",
  workspace: "/tmp/clovy-identity-test",
  safetyMode: "sandboxed",
  input,
  attachments,
  history: [],
  tools: [],
  skills: [],
  contextWindow: 16_000,
});

test("answers legacy identity variants as Clovy only", () => {
  for (const input of [
    "Are you called June?",
    "Do you go by June?",
    "Have you ever been called June?",
    "Should I call you June?",
    "Was your name June?",
  ]) {
    assert.equal(clovyIdentityResult(params(input))?.finalOutput, CLOVY_IDENTITY_REPLY);
  }
});

test("leaves attachment questions on the attachment-aware path", () => {
  assert.equal(
    clovyIdentityResult(
      params("What is June?", [
        {
          path: "/tmp/clovy-identity-test/reference.png",
          mimeType: "image/png",
        },
      ]),
    ),
    undefined,
  );
});
