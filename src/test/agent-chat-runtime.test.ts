import { describe, expect, it } from "vitest";
import { isTerminalHermesEvent, type JuneHermesEvent } from "../lib/hermes-control-plane";
import {
  buildAgentChatTurns,
  buildHermesSessionChatTurns,
  completedHermesMessageText,
  displayedComposerUserMessageText,
  repairContractionSpacing,
} from "../lib/agent-chat-runtime";
import { categoryPrompt } from "../lib/issue-report-prompt";
import { explicitSkillInvocationPrompt } from "../lib/skill-slash-commands";
import type { AgentMessageDto, HermesSessionMessage } from "../lib/tauri";

const DEFAULT_RECEIVED_AT = "2026-06-04T10:00:00.000Z";

type TranscriptEvent = Extract<JuneHermesEvent, { kind: "transcript" }>;
type ReasoningEvent = Extract<JuneHermesEvent, { kind: "reasoning" }>;
type ToolEvent = Extract<JuneHermesEvent, { kind: "tool" }>;
type PendingActionEvent = Extract<JuneHermesEvent, { kind: "pending_action" }>;
type PendingActionResolutionEvent = Extract<JuneHermesEvent, { kind: "pending_action_resolution" }>;
type BackgroundActivityEvent = Extract<JuneHermesEvent, { kind: "background_activity" }>;
type ErrorEvent = Extract<JuneHermesEvent, { kind: "error" }>;
type LifecycleEvent = Extract<JuneHermesEvent, { kind: "lifecycle" }>;

function transcriptEvent(event: Partial<TranscriptEvent> = {}): TranscriptEvent {
  return {
    kind: "transcript",
    sessionId: "",
    complete: false,
    failed: false,
    receivedAt: DEFAULT_RECEIVED_AT,
    ...event,
  };
}

function reasoningEvent(
  event: Pick<ReasoningEvent, "delta"> & Partial<ReasoningEvent>,
): ReasoningEvent {
  return {
    kind: "reasoning",
    sessionId: "",
    receivedAt: DEFAULT_RECEIVED_AT,
    ...event,
  };
}

function toolEvent(event: Partial<ToolEvent> & Pick<ToolEvent, "key">): ToolEvent {
  return {
    kind: "tool",
    sessionId: "",
    phase: "progress",
    text: "",
    isClarify: false,
    receivedAt: DEFAULT_RECEIVED_AT,
    ...event,
  };
}

function pendingActionEvent(
  event: Pick<PendingActionEvent, "action"> & Partial<PendingActionEvent>,
): PendingActionEvent {
  return {
    kind: "pending_action",
    sessionId: "",
    receivedAt: DEFAULT_RECEIVED_AT,
    ...event,
  };
}

function pendingActionResolutionEvent(
  event: Pick<PendingActionResolutionEvent, "action"> & Partial<PendingActionResolutionEvent>,
): PendingActionResolutionEvent {
  return {
    kind: "pending_action_resolution",
    sessionId: "",
    receivedAt: DEFAULT_RECEIVED_AT,
    ...event,
  };
}

function backgroundActivityEvent(
  event: Omit<Partial<BackgroundActivityEvent>, "activity"> & {
    activity: Partial<BackgroundActivityEvent["activity"]> &
      Pick<BackgroundActivityEvent["activity"], "phase">;
  },
): BackgroundActivityEvent {
  const receivedAt = event.receivedAt ?? DEFAULT_RECEIVED_AT;
  const { activity, ...rest } = event;
  return {
    kind: "background_activity",
    sessionId: "",
    receivedAt,
    ...rest,
    activity: {
      ...activity,
      subagentId: activity.subagentId ?? "subagent",
      lastEventAt: activity.lastEventAt ?? receivedAt,
    },
  };
}

function errorEvent(event: Partial<ErrorEvent> = {}): ErrorEvent {
  return {
    kind: "error",
    message: "The agent reported an error.",
    receivedAt: DEFAULT_RECEIVED_AT,
    ...event,
  };
}

function lifecycleEvent(event: Partial<LifecycleEvent> = {}): LifecycleEvent {
  return {
    kind: "lifecycle",
    sessionId: "",
    flavor: "info",
    status: "status.update",
    text: "",
    receivedAt: DEFAULT_RECEIVED_AT,
    ...event,
  };
}

describe("repairContractionSpacing", () => {
  it("re-inserts the space the gateway drops after a contraction", () => {
    // Real cases pulled from the persisted Hermes store.
    expect(repairContractionSpacing("it'snot")).toBe("it's not");
    expect(repairContractionSpacing("you'rereferring")).toBe("you're referring");
    expect(repairContractionSpacing("Mac'scamera")).toBe("Mac's camera");
    expect(repairContractionSpacing("here'swhat'sthere:")).toBe("here's what's there:");
    expect(repairContractionSpacing("we'vechecked and they'lldo it")).toBe(
      "we've checked and they'll do it",
    );
    expect(repairContractionSpacing("I'mdone, don'tworry")).toBe("I'm done, don't worry");
  });

  it("leaves correctly spaced and non-contraction text untouched", () => {
    // Idempotent: already-spaced text has no match.
    expect(repairContractionSpacing("it's not there")).toBe("it's not there");
    expect(repairContractionSpacing("its not a contraction")).toBe("its not a contraction");
    // Trailing punctuation, not a following word, isn't a dropped space.
    expect(repairContractionSpacing("that's it.")).toBe("that's it.");
    // Names with apostrophes aren't contraction enclitics.
    expect(repairContractionSpacing("d'Artagnan and O'Brien")).toBe("d'Artagnan and O'Brien");
  });

  it("does not corrupt a plural possessive glued to the next word", () => {
    // "kids' toys" glued is ambiguous with "kids'" + a "t…" word; the 's'
    // guard keeps it untouched rather than mis-splitting into "kids't oys".
    expect(repairContractionSpacing("kids'toys")).toBe("kids'toys");
    expect(repairContractionSpacing("the cars'doors")).toBe("the cars'doors");
  });
});

describe("Agent chat runtime", () => {
  it("strips the cron preamble and flags a scheduled-run turn", () => {
    const preamble =
      "[IMPORTANT: You are running as a scheduled cron job. SILENT: respond " +
      'with exactly "[SILENT]" if nothing is new. Never combine [SILENT] ' +
      "with content — say [SILENT] and nothing more.]";
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "user",
        content: `${preamble}\n\nSummarize GitHub activity for the team.`,
        timestamp: "2026-06-11T12:00:00.000Z",
      },
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.isScheduledRun).toBe(true);
    expect(turns[0]?.parts).toEqual([
      {
        type: "text",
        text: "Summarize GitHub activity for the team.",
        status: "complete",
      },
    ]);
  });

  it("leaves an ordinary user turn unflagged", () => {
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "user",
        content: "Summarize GitHub activity for the team.",
        timestamp: "2026-06-11T12:00:00.000Z",
      },
    ]);

    expect(turns[0]?.isScheduledRun).toBeUndefined();
  });

  it("renders persisted Hermes user and assistant messages", () => {
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "user",
        content: "Hi",
        timestamp: 1_780_590_879,
      },
      {
        id: "2",
        role: "assistant",
        content: "Hi! How can I help?",
        timestamp: 1_780_590_880,
        reasoning: "The user greeted me.",
      },
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0]?.role).toBe("user");
    expect(turns[0]?.parts).toEqual([{ type: "text", text: "Hi", status: "complete" }]);
    expect(turns[1]?.parts).toEqual([
      {
        type: "reasoning",
        text: "The user greeted me.",
        status: "complete",
      },
      { type: "text", text: "Hi! How can I help?", status: "complete" },
    ]);
  });

  it("preserves same-timestamp Hermes user-before-assistant source order", () => {
    const createdAt = "2026-06-11T12:00:00.000Z";
    const turns = buildHermesSessionChatTurns([
      {
        id: "user-message",
        role: "user",
        content: "Please check this.",
        timestamp: createdAt,
      },
      {
        id: "assistant-message",
        role: "assistant",
        content: "Thinking about it.",
        timestamp: createdAt,
      },
    ]);

    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  });

  it("preserves same-timestamp task user-before-assistant source order", () => {
    const createdAt = "2026-06-11T12:00:00.000Z";
    const messages: AgentMessageDto[] = [
      {
        id: "user-message",
        taskId: "task-1",
        role: "user",
        content: "Please check this.",
        createdAt,
      },
      {
        id: "assistant-message",
        taskId: "task-1",
        role: "assistant",
        content: "Thinking about it.",
        createdAt,
      },
    ];

    const turns = buildAgentChatTurns(messages, []);

    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  });

  it("preserves same-timestamp Hermes assistant-before-user source order", () => {
    const createdAt = "2026-06-11T12:00:00.000Z";
    const turns = buildHermesSessionChatTurns([
      {
        id: "assistant-message",
        role: "assistant",
        content: "Here is the answer.",
        timestamp: createdAt,
      },
      {
        id: "user-follow-up",
        role: "user",
        content: "One more thing.",
        timestamp: createdAt,
      },
    ]);

    expect(turns.map((turn) => turn.role)).toEqual(["assistant", "user"]);
  });

  it("preserves same-timestamp task assistant-before-user source order", () => {
    const createdAt = "2026-06-11T12:00:00.000Z";
    const messages: AgentMessageDto[] = [
      {
        id: "assistant-message",
        taskId: "task-1",
        role: "assistant",
        content: "Here is the answer.",
        createdAt,
      },
      {
        id: "user-follow-up",
        taskId: "task-1",
        role: "user",
        content: "One more thing.",
        createdAt,
      },
    ];

    const turns = buildAgentChatTurns(messages, []);

    expect(turns.map((turn) => turn.role)).toEqual(["assistant", "user"]);
  });

  it("preserves same-timestamp Hermes same-role source order", () => {
    const createdAt = "2026-06-11T12:00:00.000Z";
    const turns = buildHermesSessionChatTurns([
      {
        id: "z-message",
        role: "assistant",
        content: "First assistant row.",
        timestamp: createdAt,
      },
      {
        id: "a-message",
        role: "assistant",
        content: "Second assistant row.",
        timestamp: createdAt,
      },
    ]);

    expect(
      turns.map((turn) => {
        const textPart = turn.parts.find((part) => part.type === "text");
        return textPart?.type === "text" ? textPart.text : "";
      }),
    ).toEqual(["First assistant row.", "Second assistant row."]);
  });

  it("preserves same-timestamp task same-role source order", () => {
    const createdAt = "2026-06-11T12:00:00.000Z";
    const messages: AgentMessageDto[] = [
      {
        id: "z-message",
        taskId: "task-1",
        role: "assistant",
        content: "First assistant row.",
        createdAt,
      },
      {
        id: "a-message",
        taskId: "task-1",
        role: "assistant",
        content: "Second assistant row.",
        createdAt,
      },
    ];

    const turns = buildAgentChatTurns(messages, []);

    expect(
      turns.map((turn) => {
        const textPart = turn.parts.find((part) => part.type === "text");
        return textPart?.type === "text" ? textPart.text : "";
      }),
    ).toEqual(["First assistant row.", "Second assistant row."]);
  });

  it("keeps synthetic same-timestamp assistant turns in source order", () => {
    const receivedAt = "2026-06-11T12:00:00.000Z";
    const turns = buildAgentChatTurns(
      [],
      [],
      Array.from({ length: 12 }, (_, index) =>
        transcriptEvent({
          receivedAt,
          complete: true,
          delta: `Reply ${index}`,
        }),
      ),
    );

    expect(
      turns.map((turn) => {
        const textPart = turn.parts.find((part) => part.type === "text");
        return textPart?.type === "text" ? textPart.text : "";
      }),
    ).toEqual(Array.from({ length: 12 }, (_, index) => `Reply ${index}`));
  });

  it("strips explicit skill context from persisted Hermes user messages", () => {
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "user",
        content: explicitSkillInvocationPrompt(
          [
            {
              name: "repo-build-pr",
              relativePath: "repo-build-pr/SKILL.md",
              content: "# Repo build PR\n\nOpen a draft PR.",
            },
          ],
          "implement issue JUN-46",
        ),
        timestamp: "2026-06-11T12:00:00.000Z",
      },
    ]);

    expect(turns[0]?.parts).toEqual([
      {
        type: "text",
        text: "implement issue JUN-46",
        status: "complete",
      },
    ]);
  });

  it("strips report prompts that contain explicit skill context", () => {
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "user",
        content: categoryPrompt(
          "feature",
          explicitSkillInvocationPrompt(
            [
              {
                name: "repo-build-pr",
                relativePath: "repo-build-pr/SKILL.md",
                content: "# Repo build PR\n\nOpen a draft PR.",
              },
            ],
            "add slash commands",
          ),
        ),
        timestamp: "2026-06-11T12:00:00.000Z",
      },
    ]);

    expect(turns[0]?.parts).toEqual([
      {
        type: "text",
        text: "add slash commands",
        status: "complete",
      },
    ]);
  });

  it("strips image-analysis failure scaffolding from persisted Hermes user messages", () => {
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "user",
        content: [
          "[The user attached an image but analysis failed.]",
          "[You can examine it with vision_analyze using image_url:",
          "/Users/alex/Library/Application Support/co.opensoftware.june-dev/hermes/images/upload_20260629_144756_1.png]",
          "",
          "wdyt?",
          "",
          "Attached files copied into the June workspace:",
          "- CleanShot.png (Workspace): uploads/CleanShot.png",
          "",
          "Use these file paths when inspecting or operating on the files.",
        ].join("\n"),
        timestamp: "2026-06-11T12:00:00.000Z",
      },
    ]);

    expect(turns[0]?.parts).toEqual([
      {
        type: "text",
        text: [
          "wdyt?",
          "",
          "Attached files copied into the June workspace:",
          "- CleanShot.png (Workspace): uploads/CleanShot.png",
          "",
          "Use these file paths when inspecting or operating on the files.",
        ].join("\n"),
        status: "complete",
      },
    ]);
  });

  it("hides attachment and image-analysis scaffolding from composer user display text", () => {
    expect(
      displayedComposerUserMessageText(
        [
          "[The user attached an image but analysis failed.]",
          "[You can examine it with vision_analyze using image_url:",
          "/Users/alex/Library/Application Support/co.opensoftware.june-dev/hermes/images/upload_20260629_144756_1.png]",
          "",
          "wdyt?",
          "",
          "Attached files copied into the June workspace:",
          "- CleanShot.png (Workspace): uploads/CleanShot.png",
          "",
          "Use these file paths when inspecting or operating on the files.",
        ].join("\n"),
      ),
    ).toBe("wdyt?");
  });

  it("keeps attachment paths in turn data but hides them from the rendered user bubble", () => {
    // The user bubble renders each part through displayedComposerUserMessageText
    // (AgentWorkspace), so it must show only the user's words. The built turn
    // data must still retain the attachment-path block, because
    // assignArtifactsToTurns attributes workspace artifacts by matching those
    // paths against the turn text. This pins both halves of that contract.
    const content = [
      "wdyt?",
      "",
      "Attached files copied into the June workspace:",
      "- screenshot.png (Workspace): uploads/screenshot.png",
      "",
      "Use these file paths when inspecting or operating on the files.",
      "",
      "--- Attached Context ---",
      "GLM 5.2 does not support image input in June.",
      "Reply directly and briefly.",
    ].join("\n");
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "user",
        content,
        timestamp: "2026-06-11T12:00:00.000Z",
      },
    ]);
    const part = turns[0]?.parts[0];
    const turnText = part?.type === "text" ? part.text : "";
    // Turn data retains the attachment path (artifact attribution reads this)…
    expect(turnText).toContain("uploads/screenshot.png");
    // …but the provider/vision scaffolding after the marker is already gone.
    expect(turnText).not.toContain("--- Attached Context ---");
    expect(turnText).not.toContain("does not support image input");
    // The rendered bubble shows only the user's words — no attachment block.
    expect(displayedComposerUserMessageText(turnText)).toBe("wdyt?");
  });

  it("extracts text from Hermes structured content payloads", () => {
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "user",
        content:
          'Say hello\n\n--- Attached Context ---\n{"ignored":true}\n\n--- Context Warnings ---\nwarning',
        timestamp: "2026-06-04T10:00:00.000Z",
      },
      {
        id: "2",
        role: "assistant",
        content: JSON.stringify([{ type: "output_text", text: "Hello there" }]),
        timestamp: "2026-06-04T10:00:01.000Z",
      },
      {
        id: "3",
        role: "assistant",
        content: { message: { content: "Nested reply" } },
        timestamp: "2026-06-04T10:00:02.000Z",
      } as HermesSessionMessage,
    ]);

    const textParts = turns.map((turn) =>
      turn.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
    );

    expect(textParts).toEqual(["Say hello", "Hello there", "Nested reply"]);
  });

  it("classifies Hermes context compaction summaries as system context", () => {
    const turns = buildHermesSessionChatTurns([
      {
        id: "compact-1",
        role: "assistant",
        content:
          "[CONTEXT COMPACTION - REFERENCE ONLY] Earlier turns were compacted.\n\n" +
          "## Active Task\nRecovered from a deterministic fallback.\n\n" +
          "--- END OF CONTEXT SUMMARY - respond to the message below, not the summary above ---",
        timestamp: "2026-06-04T10:00:00.000Z",
      },
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.role).toBe("system");
    expect(turns[0]?.parts).toEqual([
      {
        type: "context",
        text:
          "[CONTEXT COMPACTION - REFERENCE ONLY] Earlier turns were compacted.\n\n" +
          "## Active Task\nRecovered from a deterministic fallback.",
        preview:
          "Earlier turns were compacted; fallback summary generated without the LLM summarizer.",
        status: "complete",
      },
    ]);
  });

  it("appends live reasoning deltas without inserting log line breaks", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        transcriptEvent({
          receivedAt: "2026-06-04T10:00:00.000Z",
        }),
        reasoningEvent({
          receivedAt: "2026-06-04T10:00:00.100Z",
          delta: "I should prefer",
        }),
        reasoningEvent({
          receivedAt: "2026-06-04T10:00:00.200Z",
          delta: "ably use Homebrew.",
        }),
      ],
    );

    expect(turns[0]?.parts).toEqual([
      {
        type: "reasoning",
        text: "I should preferably use Homebrew.",
        status: "running",
      },
    ]);
  });

  it("closes a running reasoning turn when only a terminal lifecycle event follows", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        reasoningEvent({
          receivedAt: "2026-06-04T10:00:00.000Z",
          delta: "Checking the workspace.",
        }),
        lifecycleEvent({
          sessionId: "runtime-session",
          receivedAt: "2026-06-04T10:00:01.000Z",
          flavor: "terminal",
          status: "turn.complete",
        }),
      ],
    );

    expect(turns).toHaveLength(1);
    expect(turns[0]?.status).toBe("complete");
    expect(turns[0]?.parts).toEqual([
      {
        type: "reasoning",
        text: "Checking the workspace.",
        status: "complete",
      },
    ]);
  });

  it("does not create a turn for a terminal lifecycle event without an assistant turn", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        lifecycleEvent({
          sessionId: "runtime-session",
          receivedAt: "2026-06-04T10:00:01.000Z",
          flavor: "terminal",
          status: "turn.complete",
        }),
      ],
    );

    expect(turns).toEqual([]);
  });

  it("renders live clarify requests as answerable chat parts", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        toolEvent({
          key: "tool-1",
          phase: "start",
          receivedAt: "2026-06-04T10:00:00.000Z",
          name: "clarify",
          isClarify: true,
          sanitizedPayload: { tool_id: "tool-1", name: "clarify" },
        }),
        pendingActionEvent({
          sessionId: "runtime-session",
          receivedAt: "2026-06-04T10:00:00.100Z",
          action: {
            kind: "clarify",
            requestId: "clarify-1",
            question: "Which email provider should I configure?",
            choices: ["Gmail", "Fastmail"],
          },
        }),
      ],
    );

    expect(turns[0]?.parts).toEqual([
      {
        type: "clarify",
        id: "clarify-1",
        sessionId: "runtime-session",
        question: "Which email provider should I configure?",
        choices: ["Gmail", "Fastmail"],
        status: "pending",
      },
    ]);
  });

  it("marks clarify requests resolved after responses or tool completion", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        pendingActionEvent({
          receivedAt: "2026-06-04T10:00:00.000Z",
          action: {
            kind: "clarify",
            requestId: "clarify-1",
            question: "Use Gmail?",
            choices: ["Yes", "No"],
          },
        }),
        pendingActionResolutionEvent({
          receivedAt: "2026-06-04T10:00:01.000Z",
          action: {
            kind: "clarify",
            requestId: "clarify-1",
            question: "",
            choices: [],
            answer: "Yes",
          },
        }),
        toolEvent({
          key: "tool-1",
          phase: "complete",
          receivedAt: "2026-06-04T10:00:02.000Z",
          name: "clarify",
          isClarify: true,
          sanitizedPayload: { tool_id: "tool-1", name: "clarify" },
        }),
      ],
    );

    expect(turns[0]?.parts).toEqual([
      {
        type: "clarify",
        id: "clarify-1",
        question: "Use Gmail?",
        choices: ["Yes", "No"],
        answer: "Yes",
        status: "resolved",
      },
    ]);
  });

  it("marks approval requests resolved after responses", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        pendingActionEvent({
          sessionId: "runtime-session",
          receivedAt: "2026-06-04T10:00:00.000Z",
          action: {
            kind: "approval",
            requestId: "approval-1",
            command: "python script.py",
            description: "Run this command?",
            allowPermanent: true,
          },
        }),
        pendingActionResolutionEvent({
          sessionId: "runtime-session",
          receivedAt: "2026-06-04T10:00:01.000Z",
          action: {
            kind: "approval",
            requestId: "approval-1",
            command: "",
            description: "",
            allowPermanent: true,
            choice: "session",
          },
        }),
      ],
    );

    expect(turns[0]?.parts).toEqual([
      {
        type: "approval",
        id: "approval-1",
        sessionId: "runtime-session",
        command: "python script.py",
        description: "Run this command?",
        allowPermanent: true,
        choice: "session",
        status: "resolved",
      },
    ]);
  });

  it("preserves whitespace-only message deltas", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        transcriptEvent({
          receivedAt: "2026-06-04T10:00:00.000Z",
        }),
        transcriptEvent({
          receivedAt: "2026-06-04T10:00:00.100Z",
          delta: "Hello",
        }),
        transcriptEvent({
          receivedAt: "2026-06-04T10:00:00.200Z",
          delta: "\n\n",
        }),
        transcriptEvent({
          receivedAt: "2026-06-04T10:00:00.300Z",
          delta: "World",
        }),
      ],
    );

    expect(turns[0]?.parts).toEqual([{ type: "text", text: "Hello\n\nWorld", status: "running" }]);
  });

  it("appends repeated deltas verbatim instead of dropping them", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        transcriptEvent({
          receivedAt: "2026-06-04T10:00:00.000Z",
        }),
        transcriptEvent({
          receivedAt: "2026-06-04T10:00:00.100Z",
          delta: "no",
        }),
        transcriptEvent({
          receivedAt: "2026-06-04T10:00:00.200Z",
          delta: "no",
        }),
      ],
    );

    expect(turns[0]?.parts).toEqual([{ type: "text", text: "nono", status: "running" }]);
  });

  it("keeps legitimate repeated lines and paragraphs in persisted messages", () => {
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "assistant",
        content: "Run:\n\nfoo();\nfoo();\nbar();",
        timestamp: "2026-06-04T10:00:00.000Z",
      },
      {
        id: "2",
        role: "assistant",
        content: "Yes.\n\nYes.",
        timestamp: "2026-06-04T10:00:01.000Z",
      },
    ]);

    expect(turns[0]?.parts).toEqual([
      {
        type: "text",
        text: "Run:\n\nfoo();\nfoo();\nbar();",
        status: "complete",
      },
    ]);
    expect(turns[1]?.parts).toEqual([{ type: "text", text: "Yes.\n\nYes.", status: "complete" }]);
  });

  it("returns the raw completed message text for persistence", () => {
    const text = completedHermesMessageText([
      transcriptEvent({
        receivedAt: "2026-06-04T10:00:00.000Z",
      }),
      transcriptEvent({
        receivedAt: "2026-06-04T10:00:00.100Z",
        delta: "Yes.\n\nYes.",
      }),
      transcriptEvent({
        receivedAt: "2026-06-04T10:00:01.000Z",
        complete: true,
        delta: "Yes.\n\nYes.",
      }),
    ]);

    expect(text).toBe("Yes.\n\nYes.");
  });

  it("does not duplicate the opening text on interleaved text/tool turns", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        transcriptEvent({
          receivedAt: "2026-06-04T10:00:00.000Z",
        }),
        transcriptEvent({
          receivedAt: "2026-06-04T10:00:00.100Z",
          delta: "Let me check.",
        }),
        toolEvent({
          key: "tool-1",
          phase: "start",
          receivedAt: "2026-06-04T10:00:00.200Z",
          name: "search",
          sanitizedPayload: { tool_id: "tool-1", name: "search" },
        }),
        toolEvent({
          key: "tool-1",
          phase: "complete",
          receivedAt: "2026-06-04T10:00:00.300Z",
          name: "search",
          sanitizedPayload: { tool_id: "tool-1", name: "search" },
        }),
        transcriptEvent({
          receivedAt: "2026-06-04T10:00:00.400Z",
          delta: "Here is the answer.",
        }),
        transcriptEvent({
          receivedAt: "2026-06-04T10:00:01.000Z",
          complete: true,
          delta: "Let me check.Here is the answer.",
        }),
      ],
    );

    expect(turns[0]?.status).toBe("complete");
    expect(turns[0]?.parts.map((part) => (part.type === "text" ? part.text : part.type))).toEqual([
      "Let me check.",
      "tool",
      "Here is the answer.",
    ]);
  });

  it("replaces streamed text wholesale when the complete text disagrees", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        transcriptEvent({
          receivedAt: "2026-06-04T10:00:00.000Z",
          delta: "Partial garble",
        }),
        toolEvent({
          key: "tool-1",
          phase: "start",
          receivedAt: "2026-06-04T10:00:00.100Z",
          name: "search",
          sanitizedPayload: { tool_id: "tool-1", name: "search" },
        }),
        transcriptEvent({
          receivedAt: "2026-06-04T10:00:00.200Z",
          delta: "more",
        }),
        transcriptEvent({
          receivedAt: "2026-06-04T10:00:01.000Z",
          complete: true,
          delta: "The authoritative answer.",
        }),
      ],
    );

    expect(turns[0]?.parts.map((part) => (part.type === "text" ? part.text : part.type))).toEqual([
      "tool",
      "The authoritative answer.",
    ]);
  });

  it("keeps the verbatim stream when the complete text drops a boundary space", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        transcriptEvent({
          receivedAt: "2026-06-04T10:00:00.000Z",
          delta: "Let me explore it.",
        }),
        transcriptEvent({
          receivedAt: "2026-06-04T10:00:01.000Z",
          complete: true,
          delta: "Let me exploreit.",
        }),
      ],
    );

    expect(turns[0]?.parts.map((part) => (part.type === "text" ? part.text : part.type))).toEqual([
      "Let me explore it.",
    ]);
  });

  it("honors a complete payload that corrects streamed whitespace", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        transcriptEvent({
          receivedAt: "2026-06-04T10:00:00.000Z",
          delta: "return\nvalue",
        }),
        transcriptEvent({
          receivedAt: "2026-06-04T10:00:01.000Z",
          complete: true,
          delta: "return value",
        }),
      ],
    );

    expect(turns[0]?.parts.map((part) => (part.type === "text" ? part.text : part.type))).toEqual([
      "return value",
    ]);
  });

  it("does not truncate streamed text when the complete payload lags behind", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        transcriptEvent({
          receivedAt: "2026-06-04T10:00:00.000Z",
          delta: "Here is the full answer.",
        }),
        transcriptEvent({
          receivedAt: "2026-06-04T10:00:01.000Z",
          complete: true,
          delta: "Here is the full",
        }),
      ],
    );

    expect(turns[0]?.parts.map((part) => (part.type === "text" ? part.text : part.type))).toEqual([
      "Here is the full answer.",
    ]);
  });

  it("assigns unique turn ids to turns created in the same millisecond", () => {
    const receivedAt = "2026-06-04T10:00:00.000Z";
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        transcriptEvent({ receivedAt }),
        transcriptEvent({ receivedAt, complete: true, delta: "One" }),
        transcriptEvent({ receivedAt }),
        transcriptEvent({ receivedAt, complete: true, delta: "Two" }),
      ],
    );

    expect(turns).toHaveLength(2);
    expect(turns[0]?.id).not.toBe(turns[1]?.id);
  });

  it("keys tool events by tool_id so terminal events update the same part", () => {
    const event = toolEvent({
      key: "tool-9",
      phase: "start",
      receivedAt: "2026-06-04T10:00:00.000Z",
      sanitizedPayload: { tool_id: "tool-9" },
    });
    expect(event.key).toBe("tool-9");

    const turns = buildAgentChatTurns(
      [],
      [],
      [
        toolEvent({
          key: "tool-9",
          phase: "start",
          receivedAt: "2026-06-04T10:00:00.000Z",
          name: "search",
          text: "Searching",
          sanitizedPayload: { tool_id: "tool-9", name: "search", text: "Searching" },
        }),
        toolEvent({
          key: "tool-9",
          phase: "complete",
          receivedAt: "2026-06-04T10:00:01.000Z",
          sanitizedPayload: { tool_id: "tool-9" },
        }),
      ],
    );

    const toolParts = turns[0]?.parts.filter((part) => part.type === "tool");
    expect(toolParts).toHaveLength(1);
    expect(toolParts?.[0]?.status).toBe("complete");
  });

  it("ignores message.completed for transcript turns while keeping it terminal", () => {
    const completed = lifecycleEvent({
      sessionId: "runtime-session",
      flavor: "terminal",
      status: "message.completed",
      text: "Should not render",
      payload: { text: "Should not render" },
    });

    expect(isTerminalHermesEvent(completed)).toBe(true);
    expect(buildAgentChatTurns([], [], [completed])).toEqual([]);
  });

  it("does not duplicate assistant text when message.completed follows message.complete", () => {
    const complete = transcriptEvent({
      sessionId: "runtime-session",
      complete: true,
      failed: false,
      delta: "Done.",
    });
    const completed = lifecycleEvent({
      sessionId: "runtime-session",
      flavor: "terminal",
      status: "message.completed",
      text: "Done.",
      payload: { text: "Done." },
    });

    const turns = buildAgentChatTurns([], [], [complete, completed]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.parts).toEqual([{ type: "text", text: "Done.", status: "complete" }]);
  });

  it("does not merge same-name tool calls with distinct tool ids", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        toolEvent({
          key: "tool-a",
          phase: "start",
          receivedAt: "2026-06-04T10:00:00.000Z",
          name: "search",
          text: "First",
          sanitizedPayload: { tool_id: "tool-a", name: "search", text: "First" },
        }),
        toolEvent({
          key: "tool-b",
          phase: "start",
          receivedAt: "2026-06-04T10:00:01.000Z",
          name: "search",
          text: "Second",
          sanitizedPayload: { tool_id: "tool-b", name: "search", text: "Second" },
        }),
      ],
    );

    const toolParts = turns[0]?.parts.filter((part) => part.type === "tool");
    expect(toolParts?.map((part) => part.id)).toEqual(["tool-a", "tool-b"]);
  });

  it("attributes persisted tool events to the assistant turn they belong to", () => {
    const messages: AgentMessageDto[] = [
      {
        id: "m1",
        taskId: "task-1",
        role: "user",
        content: "First question",
        createdAt: "2026-06-04T10:00:00.000Z",
      },
      {
        id: "m2",
        taskId: "task-1",
        role: "assistant",
        content: "First answer",
        createdAt: "2026-06-04T10:00:10.000Z",
      },
      {
        id: "m3",
        taskId: "task-1",
        role: "user",
        content: "Second question",
        createdAt: "2026-06-04T10:01:00.000Z",
      },
      {
        id: "m4",
        taskId: "task-1",
        role: "assistant",
        content: "Second answer",
        createdAt: "2026-06-04T10:01:10.000Z",
      },
    ];
    const turns = buildAgentChatTurns(messages, [
      {
        id: "evt-1",
        taskId: "task-1",
        toolName: "Search",
        status: "completed",
        summary: "Searched the web",
        redacted: false,
        createdAt: "2026-06-04T10:00:05.000Z",
      },
      {
        id: "evt-2",
        taskId: "task-1",
        toolName: "Fetch",
        status: "completed",
        summary: "Fetched a page",
        redacted: false,
        createdAt: "2026-06-04T10:01:05.000Z",
      },
    ]);

    const firstAssistant = turns.find((turn) => turn.id === "m2");
    const secondAssistant = turns.find((turn) => turn.id === "m4");
    expect(firstAssistant?.parts.filter((part) => part.type === "tool")).toEqual([
      {
        type: "tool",
        id: "evt-1",
        name: "Search",
        text: "Searched the web",
        status: "complete",
      },
    ]);
    expect(secondAssistant?.parts.filter((part) => part.type === "tool")).toEqual([
      {
        type: "tool",
        id: "evt-2",
        name: "Fetch",
        text: "Fetched a page",
        status: "complete",
      },
    ]);
  });

  it("groups trailing persisted tool events into one in-flight turn", () => {
    const messages: AgentMessageDto[] = [
      {
        id: "m1",
        taskId: "task-1",
        role: "assistant",
        content: "Earlier answer",
        createdAt: "2026-06-04T10:00:00.000Z",
      },
    ];
    const turns = buildAgentChatTurns(messages, [
      {
        id: "evt-1",
        taskId: "task-1",
        toolName: "Search",
        status: "completed",
        summary: "Searched the web",
        redacted: false,
        createdAt: "2026-06-04T10:01:00.000Z",
      },
      {
        id: "evt-2",
        taskId: "task-1",
        toolName: "Fetch",
        status: "completed",
        summary: "Fetched a page",
        redacted: false,
        createdAt: "2026-06-04T10:01:05.000Z",
      },
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0]?.parts).toEqual([{ type: "text", text: "Earlier answer", status: "complete" }]);
    expect(turns[1]?.parts.filter((part) => part.type === "tool")).toHaveLength(2);
    expect(turns[1]?.status).toBe("complete");
  });

  it("does not leave a turn created by a terminal tool event running", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        toolEvent({
          key: "tool-1",
          phase: "complete",
          receivedAt: "2026-06-04T10:00:00.000Z",
          name: "search",
          text: "Done",
          sanitizedPayload: { tool_id: "tool-1", name: "search", text: "Done" },
        }),
      ],
    );

    expect(turns[0]?.status).toBe("complete");
  });

  it("labels live terminal tool rows by the activity in their payload", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        toolEvent({
          key: "tool-1",
          phase: "start",
          receivedAt: "2026-06-04T10:00:00.000Z",
          name: "terminal",
          sanitizedPayload: {
            tool_id: "tool-1",
            name: "terminal",
            command: "curl https://example.com/docs",
          },
        }),
      ],
    );

    const tool = turns[0]?.parts.find((part) => part.type === "tool");
    expect(tool).toMatchObject({
      name: "Browsing",
      status: "running",
    });
  });

  it("keeps inferred tool labels when progress frames omit the tool name", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        toolEvent({
          key: "tool-1",
          phase: "start",
          receivedAt: "2026-06-04T10:00:00.000Z",
          name: "terminal",
          sanitizedPayload: {
            tool_id: "tool-1",
            name: "terminal",
            command: "curl https://example.com/docs",
          },
        }),
        toolEvent({
          key: "tool-1",
          phase: "progress",
          receivedAt: "2026-06-04T10:00:01.000Z",
          text: "Fetched 42 lines",
          sanitizedPayload: {
            tool_id: "tool-1",
            output: "Fetched 42 lines",
          },
        }),
        toolEvent({
          key: "tool-1",
          phase: "complete",
          receivedAt: "2026-06-04T10:00:02.000Z",
          text: "Done",
          sanitizedPayload: {
            tool_id: "tool-1",
            result: "Done",
          },
        }),
      ],
    );

    const tool = turns[0]?.parts.find((part) => part.type === "tool");
    expect(tool).toMatchObject({
      name: "Browsing",
      status: "complete",
    });
    expect(tool?.type === "tool" ? tool.text : "").toContain("Fetched 42 lines");
  });

  it("keeps inferred labels when persisted tool result messages arrive", () => {
    const turns = buildHermesSessionChatTurns([
      {
        id: "assistant-1",
        role: "assistant",
        content: "",
        timestamp: "2026-06-04T10:00:00.000Z",
        tool_calls: JSON.stringify([
          {
            id: "call-1",
            function: {
              name: "list_files",
              arguments: { path: "src" },
            },
          },
        ]),
      },
      {
        id: "tool-1",
        role: "tool",
        tool_call_id: "call-1",
        tool_name: "list_files",
        content: "src/App.tsx",
        timestamp: "2026-06-04T10:00:01.000Z",
      },
    ]);

    const tool = turns[0]?.parts.find((part) => part.type === "tool");
    expect(tool).toMatchObject({
      name: "Reading files",
      status: "complete",
    });
    expect(tool?.type === "tool" ? tool.text : "").toContain("src/App.tsx");
  });

  it("marks the in-flight turn errored even when the error has no text", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        transcriptEvent({
          receivedAt: "2026-06-04T10:00:00.000Z",
        }),
        transcriptEvent({
          receivedAt: "2026-06-04T10:00:00.100Z",
          delta: "Working on it",
        }),
        errorEvent({
          receivedAt: "2026-06-04T10:00:01.000Z",
        }),
      ],
    );

    expect(turns[0]?.status).toBe("complete");
    expect(turns[0]?.parts).toContainEqual({
      type: "tool",
      id: "error:2026-06-04T10:00:01.000Z",
      name: "Error",
      text: "The agent reported an error.",
      status: "failed",
    });
  });

  // The raw provider error a turn dies with when the wallet is empty — this
  // exact shape reaches us as persisted assistant text and as live event text.
  const CREDITS_ERROR =
    "Error: Error code: 402 - {'data': None, 'success': False, 'error_code': 4301, 'message': 'insufficient_credits'}";

  it("folds a live insufficient-credits error event into a credits notice", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        errorEvent({
          receivedAt: "2026-06-04T10:00:01.000Z",
          message: CREDITS_ERROR,
        }),
      ],
    );

    expect(turns[0]?.parts).toEqual([{ type: "notice", kind: "credits", text: CREDITS_ERROR }]);
  });

  it("folds a summary-only classified error into the same notice path", () => {
    const event = errorEvent({
      sessionId: "runtime-session",
      message: CREDITS_ERROR,
    });
    expect(event.kind).toBe("error");

    const turns = buildAgentChatTurns([], [], [event]);

    expect(turns[0]?.parts).toEqual([{ type: "notice", kind: "credits", text: CREDITS_ERROR }]);
  });

  it("folds a persisted insufficient-credits error turn into a credits notice", () => {
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "assistant",
        content: CREDITS_ERROR,
        timestamp: "2026-06-04T10:00:00.000Z",
      },
    ]);

    expect(turns[0]?.parts).toEqual([{ type: "notice", kind: "credits", text: CREDITS_ERROR }]);
  });

  it("drops partially streamed text when the turn completes as a credits failure", () => {
    const turns = buildHermesSessionChatTurns(
      [],
      [
        transcriptEvent({
          receivedAt: "2026-06-04T10:00:00.000Z",
          delta: "Let me check",
        }),
        transcriptEvent({
          receivedAt: "2026-06-04T10:00:01.000Z",
          complete: true,
          delta: CREDITS_ERROR,
          failed: true,
        }),
      ],
    );

    expect(turns[0]?.parts).toEqual([{ type: "notice", kind: "credits", text: CREDITS_ERROR }]);
  });

  it("folds an insufficient-credits message.complete into a credits notice", () => {
    const turns = buildHermesSessionChatTurns(
      [],
      [
        transcriptEvent({
          receivedAt: "2026-06-04T10:00:01.000Z",
          complete: true,
          delta: CREDITS_ERROR,
          failed: true,
        }),
      ],
    );

    expect(turns[0]?.parts).toEqual([{ type: "notice", kind: "credits", text: CREDITS_ERROR }]);
  });

  it("keeps assistant prose about credits as ordinary text", () => {
    const prose = "If you see insufficient_credits errors, upgrade from settings.";
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "assistant",
        content: prose,
        timestamp: "2026-06-04T10:00:00.000Z",
      },
    ]);

    expect(turns[0]?.parts).toEqual([{ type: "text", text: prose, status: "complete" }]);
  });

  // The terminal error Hermes surfaces when a single oversized turn cannot be
  // compressed below the window (JUN-169) — reaches us as a live error event,
  // a failed message.complete, and persisted assistant text.
  const OVERFLOW_ERROR = "Context length exceeded (66,919 tokens). Cannot compress further.";

  it("folds a live context-overflow error event into a context-overflow notice", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        errorEvent({
          receivedAt: "2026-06-04T10:00:01.000Z",
          message: OVERFLOW_ERROR,
        }),
      ],
    );

    expect(turns[0]?.parts).toEqual([
      { type: "notice", kind: "context-overflow", text: OVERFLOW_ERROR },
    ]);
  });

  it("folds a live string_too_long rejection into a context-overflow notice", () => {
    // A single oversized string (per-string cap) is a hard size failure too;
    // the classifier catches the raw token so it degrades like the aggregate
    // overflow instead of surfacing raw (JUN-169 review).
    const text = "string_too_long: a single field exceeded the size limit.";
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        errorEvent({
          receivedAt: "2026-06-04T10:00:01.000Z",
          message: text,
        }),
      ],
    );

    expect(turns[0]?.parts).toEqual([{ type: "notice", kind: "context-overflow", text }]);
  });

  it("folds a failed context-overflow message.complete into a context-overflow notice", () => {
    const turns = buildHermesSessionChatTurns(
      [],
      [
        transcriptEvent({
          receivedAt: "2026-06-04T10:00:01.000Z",
          complete: true,
          delta: OVERFLOW_ERROR,
          failed: true,
        }),
      ],
    );

    expect(turns[0]?.parts).toEqual([
      { type: "notice", kind: "context-overflow", text: OVERFLOW_ERROR },
    ]);
  });

  it("folds a persisted context-overflow assistant turn into a context-overflow notice", () => {
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "assistant",
        content: OVERFLOW_ERROR,
        timestamp: "2026-06-04T10:00:00.000Z",
      },
    ]);

    expect(turns[0]?.parts).toEqual([
      { type: "notice", kind: "context-overflow", text: OVERFLOW_ERROR },
    ]);
  });

  it("keeps a persisted assistant answer that mentions context length as prose", () => {
    // A saved answer, not an error — the persisted path has no failure flag, so
    // it must fold only on unambiguous error sentinels, never on prose that
    // merely discusses context length (JUN-169 review: persisted prose
    // misclassification would drop the real answer on reload).
    const prose = "The maximum context length for GLM 5.2 is 200k tokens.";
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "assistant",
        content: prose,
        timestamp: "2026-06-04T10:00:00.000Z",
      },
    ]);

    expect(turns[0]?.parts).toEqual([{ type: "text", text: prose, status: "complete" }]);
  });

  it("keeps a persisted answer that explains the error tokens as prose", () => {
    // June discussing its own error codes in a saved answer must not reload as
    // an overflow notice: the sentinel is anchored to the start of the message,
    // so a mid-sentence mention of prompt_too_long/string_too_long stays text
    // (JUN-169 review).
    const prose =
      "The agent API can return prompt_too_long or string_too_long when a request is too big.";
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "assistant",
        content: prose,
        timestamp: "2026-06-04T10:00:00.000Z",
      },
    ]);

    expect(turns[0]?.parts).toEqual([{ type: "text", text: prose, status: "complete" }]);
  });

  it("folds a persisted prefixed overflow error into a context-overflow notice", () => {
    // Hermes persists a provider failure with the runtime "Error:" prefix (the
    // same shape as the credits path); a prefixed prompt_too_long must still
    // fold on reload, not fall back to the raw dead-end (JUN-169 review).
    const persisted =
      "Error: Error code: 400 - {'message': 'prompt_too_long: the request exceeds the maximum context length'}";
    const turns = buildHermesSessionChatTurns([
      {
        id: "1",
        role: "assistant",
        content: persisted,
        timestamp: "2026-06-04T10:00:00.000Z",
      },
    ]);

    expect(turns[0]?.parts).toEqual([
      { type: "notice", kind: "context-overflow", text: persisted },
    ]);
  });

  it("keeps a successful message.complete that mentions context length as prose", () => {
    const prose = "The maximum context length for GLM 5.2 is 200k tokens.";
    const turns = buildHermesSessionChatTurns(
      [],
      [
        transcriptEvent({
          receivedAt: "2026-06-04T10:00:01.000Z",
          complete: true,
          delta: prose,
          failed: false,
        }),
      ],
    );

    expect(turns[0]?.parts).toEqual([{ type: "text", text: prose, status: "complete" }]);
  });

  it("renders delegated subagents as live tool rows (regression: silently dropped)", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        backgroundActivityEvent({
          receivedAt: "2026-06-04T10:00:00.000Z",
          activity: {
            subagentId: "sa-1",
            phase: "start",
            taskIndex: 0,
            taskCount: 2,
            goal: "Write the privacy page",
          },
        }),
        backgroundActivityEvent({
          receivedAt: "2026-06-04T10:00:00.050Z",
          activity: {
            subagentId: "sa-2",
            phase: "start",
            taskIndex: 1,
            taskCount: 2,
            goal: "Write the terms page",
          },
        }),
        backgroundActivityEvent({
          receivedAt: "2026-06-04T10:00:01.000Z",
          activity: {
            subagentId: "sa-1",
            phase: "tool",
            goal: "Write the privacy page",
            resultPreview: "edit privacy.tsx",
          },
        }),
        backgroundActivityEvent({
          receivedAt: "2026-06-04T10:00:02.000Z",
          activity: {
            subagentId: "sa-1",
            phase: "complete",
            goal: "Write the privacy page",
            resultPreview: "Done: 1 file written",
          },
        }),
      ],
    );

    const tools = turns[0]?.parts.filter((part) => part.type === "tool");
    expect(tools).toHaveLength(2);
    // Two parallel subagents, keyed by id, each labeled by its goal.
    expect(tools?.[0]).toMatchObject({
      id: "subagent:sa-1",
      name: "Subagent: Write the privacy page",
      status: "complete",
    });
    expect(tools?.[1]).toMatchObject({
      id: "subagent:sa-2",
      name: "Subagent: Write the terms page",
      status: "running",
    });
    // The first subagent's row accumulated its activity then its summary.
    expect((tools?.[0] as { text?: string }).text).toContain("edit privacy.tsx");
    expect((tools?.[0] as { text?: string }).text).toContain("Done: 1 file written");
  });

  it("keeps the goal label when a later subagent event omits it", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        backgroundActivityEvent({
          receivedAt: "2026-06-04T10:00:00.000Z",
          activity: { subagentId: "sa-1", phase: "start", goal: "Write the privacy page" },
        }),
        // A tool event carrying only the id + preview, no goal.
        backgroundActivityEvent({
          receivedAt: "2026-06-04T10:00:01.000Z",
          activity: { subagentId: "sa-1", phase: "tool", resultPreview: "edit privacy.tsx" },
        }),
      ],
    );
    const tool = turns[0]?.parts.find((part) => part.type === "tool");
    // The richer label must survive the goal-less follow-up (no flicker).
    expect(tool).toMatchObject({
      name: "Subagent: Write the privacy page",
      status: "running",
    });
  });

  it("resolves a failure-flavored terminal subtype instead of staying running", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        backgroundActivityEvent({
          receivedAt: "2026-06-04T10:00:00.000Z",
          activity: { subagentId: "sa-1", phase: "start", goal: "Write the privacy page" },
        }),
        // A subtype not in the documented union; must still terminate the row.
        backgroundActivityEvent({
          receivedAt: "2026-06-04T10:00:05.000Z",
          activity: { subagentId: "sa-1", phase: "error" },
        }),
      ],
    );
    const tool = turns[0]?.parts.find((part) => part.type === "tool");
    expect(tool).toMatchObject({
      name: "Subagent: Write the privacy page",
      status: "failed",
    });
  });

  it("keeps blocked subagent rows running because they can resume", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        backgroundActivityEvent({
          receivedAt: "2026-06-04T10:00:00.000Z",
          activity: { subagentId: "sa-1", phase: "start", goal: "Write the privacy page" },
        }),
        backgroundActivityEvent({
          receivedAt: "2026-06-04T10:00:05.000Z",
          activity: { subagentId: "sa-1", phase: "blocked" },
        }),
      ],
    );
    const tool = turns[0]?.parts.find((part) => part.type === "tool");
    expect(tool).toMatchObject({
      name: "Subagent: Write the privacy page",
      status: "running",
    });
  });

  it("labels a goal-less subagent by its task position and marks failures", () => {
    const turns = buildAgentChatTurns(
      [],
      [],
      [
        backgroundActivityEvent({
          receivedAt: "2026-06-04T10:00:00.000Z",
          activity: { phase: "start", taskIndex: 2, taskCount: 5 },
        }),
        backgroundActivityEvent({
          receivedAt: "2026-06-04T10:00:01.000Z",
          activity: { phase: "error", taskIndex: 2, taskCount: 5 },
        }),
      ],
    );
    const tool = turns[0]?.parts.find((part) => part.type === "tool");
    expect(tool).toMatchObject({
      id: "subagent:task-2",
      name: "Subagent 3 of 5",
      status: "failed",
    });
  });
});
