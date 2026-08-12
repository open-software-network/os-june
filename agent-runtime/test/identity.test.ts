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

const conversationHistory: RunStartParams["history"] = [
  {
    id: "person-context",
    kind: "message",
    role: "assistant",
    text: "June is the project lead mentioned in the brief.",
  },
];

const unrelatedConversationHistory: RunStartParams["history"] = [
  {
    id: "unrelated-context",
    kind: "message",
    role: "assistant",
    text: "The user prefers dark mode.",
  },
];

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

test("leaves ambiguous legacy-name questions on the contextual model path", () => {
  assert.equal(
    clovyIdentityResult({
      ...params("Who is June?"),
      history: conversationHistory,
    }),
    undefined,
  );
});

test("answers explicit legacy assistant-name questions despite earlier context", () => {
  assert.equal(
    clovyIdentityResult({
      ...params("Are you called June?"),
      history: conversationHistory,
    })?.finalOutput,
    CLOVY_IDENTITY_REPLY,
  );
});

test("answers ambiguous legacy-name questions after unrelated context", () => {
  assert.equal(
    clovyIdentityResult({
      ...params("Who is June?"),
      history: unrelatedConversationHistory,
    })?.finalOutput,
    CLOVY_IDENTITY_REPLY,
  );
});

test("recognizes normalized legacy-name context in compact summaries", () => {
  assert.equal(
    clovyIdentityResult({
      ...params("Who is June?"),
      history: [
        {
          id: "normalized-summary",
          kind: "context_summary",
          text: "The project lead is Ｊｕｎｅ.",
        },
      ],
    }),
    undefined,
  );
});
