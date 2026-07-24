import assert from "node:assert/strict";
import test from "node:test";
import { OpenAIAgentsEngine } from "../src/sdk-engine.ts";
import { MODEL_CHAT_COMPLETIONS_TOOL } from "../src/rpc-model-provider.ts";
import type { EngineEvent, EngineRunInput, JsonObject } from "../src/types.ts";

test("continues model inference after a host tool result", async () => {
  const modelRequests: JsonObject[] = [];
  const toolCalls: Array<{ name: string; callId?: string }> = [];
  const engine = new OpenAIAgentsEngine(async (input) => {
    if (input.name !== MODEL_CHAT_COMPLETIONS_TOOL) {
      toolCalls.push({ name: input.name, callId: input.callId });
      return { skills: [] };
    }
    if (!("request" in input.arguments)) {
      throw new Error("The test streams complete in one page");
    }
    const request = input.arguments.request;
    modelRequests.push(request);
    if (modelRequests.length === 1) {
      return streamPage("tool-stream", {
        id: "completion-tool",
        object: "chat.completion.chunk",
        created: 1,
        model: "private-auto",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call-list-skills",
                  type: "function",
                  function: { name: "list_skills", arguments: "{}" },
                },
              ],
            },
          },
        ],
      });
    }
    return streamPage("answer-stream", {
      id: "completion-answer",
      object: "chat.completion.chunk",
      created: 2,
      model: "private-auto",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          delta: { role: "assistant", content: "No skills are installed." },
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    });
  });
  await engine.initialize({ clientName: "June", clientVersion: "test" });
  const events: EngineEvent[] = [];
  const input: EngineRunInput = {
    sessionId: "session-1",
    runId: "run-1",
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
    params: {
      model: "private-auto",
      instructions: "Use list_skills, then answer.",
      workspace: "/tmp/june-workspace",
      safetyMode: "sandboxed",
      input: "What skills are installed?",
      history: [],
      tools: [
        {
          name: "list_skills",
          description: "List installed skills.",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
      skills: [],
      contextWindow: 16_000,
    },
  };

  const result = await engine.start(input);

  assert.equal(result.finalOutput, "No skills are installed.");
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0]?.name, "list_skills");
  assert.ok(toolCalls[0]?.callId);
  assert.equal(modelRequests.length, 2);
  const secondMessages = modelRequests[1]?.messages;
  assert.ok(Array.isArray(secondMessages));
  assert.ok(
    secondMessages.some(
      (message) =>
        isRecord(message) &&
        message.role === "tool" &&
        message.tool_call_id === "call-list-skills",
    ),
  );
  assert.ok(events.some((event) => event.type === "tool.completed"));
});

test("serializes an approval interruption after assistant history", async () => {
  const modelRequests: JsonObject[] = [];
  const engine = new OpenAIAgentsEngine(async (input) => {
    if (input.name !== MODEL_CHAT_COMPLETIONS_TOOL) {
      throw new Error(`Approval tool should not execute before resume: ${input.name}`);
    }
    if (!("request" in input.arguments)) {
      throw new Error("The test stream completes in one page");
    }
    modelRequests.push(input.arguments.request);
    return streamPage("approval-stream", {
      id: "completion-approval",
      object: "chat.completion.chunk",
      created: 3,
      model: "private-auto",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call-write-file",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: "{\"path\":\"qa-proof.txt\",\"content\":\"OK\"}",
                },
              },
            ],
          },
        },
      ],
    });
  });
  await engine.initialize({ clientName: "June", clientVersion: "test" });

  const result = await engine.start({
    sessionId: "session-history",
    runId: "run-approval",
    signal: new AbortController().signal,
    emit: () => {},
    params: {
      model: "private-auto",
      instructions: "Use the requested file tool.",
      workspace: "/tmp/june-workspace",
      safetyMode: "sandboxed",
      input: "Create the file.",
      history: [
        { id: "user-1", kind: "message", role: "user", text: "Say hello." },
        { id: "assistant-1", kind: "message", role: "assistant", text: "Hello." },
      ],
      tools: [
        {
          name: "write_file",
          description: "Write a file.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
            required: ["path", "content"],
            additionalProperties: false,
          },
          requiresApproval: true,
        },
      ],
      skills: [],
      contextWindow: 16_000,
    },
  });

  assert.equal(result.interruptions.length, 1);
  assert.ok(result.serializedState);
  const messages = modelRequests[0]?.messages;
  assert.ok(Array.isArray(messages));
  assert.ok(
    messages.some(
      (message) =>
        isRecord(message) &&
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some(
          (part) => isRecord(part) && part.type === "text" && part.text === "Hello.",
        ),
    ),
  );
});

test("resumes a serialized approval and continues after the host tool result", async () => {
  let modelRequestCount = 0;
  let toolInvocationCount = 0;
  const engine = new OpenAIAgentsEngine(async (input) => {
    if (input.name !== MODEL_CHAT_COMPLETIONS_TOOL) {
      toolInvocationCount += 1;
      assert.equal(input.name, "write_file");
      return { path: "qa-proof.txt", written: true };
    }
    if (!("request" in input.arguments)) {
      throw new Error("The test streams complete in one page");
    }
    modelRequestCount += 1;
    if (modelRequestCount === 1) {
      return streamPage("approval-start", {
        id: "completion-approval-start",
        object: "chat.completion.chunk",
        created: 4,
        model: "private-auto",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call-write-file-resume",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: "{\"path\":\"qa-proof.txt\",\"content\":\"OK\"}",
                  },
                },
              ],
            },
          },
        ],
      });
    }
    return streamPage("approval-finish", {
      id: "completion-approval-finish",
      object: "chat.completion.chunk",
      created: 5,
      model: "private-auto",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          delta: { role: "assistant", content: "The file contains OK." },
        },
      ],
    });
  });
  await engine.initialize({ clientName: "June", clientVersion: "test" });
  const commonParams = {
    model: "private-auto",
    instructions: "Use the requested file tool.",
    workspace: "/tmp/june-workspace",
    safetyMode: "sandboxed" as const,
    tools: [
      {
        name: "write_file",
        description: "Write a file.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
        requiresApproval: true,
      },
    ],
    skills: [],
    contextWindow: 16_000,
  };
  const paused = await engine.start({
    sessionId: "session-resume",
    runId: "run-resume",
    signal: new AbortController().signal,
    emit: () => {},
    params: {
      ...commonParams,
      input: "Create the file.",
      history: [],
    },
  });
  assert.equal(paused.interruptions.length, 1);
  assert.ok(paused.serializedState);

  const resumed = await engine.resume({
    sessionId: "session-resume",
    runId: "run-resume",
    signal: new AbortController().signal,
    emit: () => {},
    params: {
      ...commonParams,
      serializedState: paused.serializedState,
      resolutions: [
        {
          interruptionId: paused.interruptions[0]!.id,
          decision: "approve",
        },
      ],
    },
  });

  assert.equal(toolInvocationCount, 1);
  assert.equal(modelRequestCount, 2);
  assert.equal(resumed.finalOutput, "The file contains OK.");
  assert.equal(resumed.interruptions.length, 0);
});

function streamPage(streamId: string, chunk: JsonObject) {
  return { streamId, chunks: [chunk], done: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
