import type { AgentChatPart, AgentChatTurn } from "./agent-chat-runtime";

// A hand-built catalog of every agent response part type and every status it can
// render in. Used by the dev-tools response gallery (window.__agentGallery) so we
// can eyeball and tune the styling of each surface in one place, without having
// to coax a live agent into emitting each variant.
//
// Each section is rendered through the real <AgentChatTurnRow>, so what you see
// here is exactly what ships.
// Mirrors the AgentArtifact shape in AgentWorkspace.tsx. Kept structural (not
// imported) so this catalog stays dependency-free; the fields must match.
export type AgentGalleryArtifact = {
  name: string;
  path: string;
  rootLabel: string;
  size?: number | null;
};

export type AgentChatGallerySection = {
  label: string;
  description?: string;
  turns: AgentChatTurn[];
  // Generated-file cards hang off the turn, not its parts. When present they're
  // passed to <AgentChatTurnRow> so the artifact card renders in the catalog.
  // The turn text must name each file for it to surface (see
  // artifactsMentionedInText).
  artifacts?: AgentGalleryArtifact[];
};

// Fixed timestamps keep the gallery deterministic (no churn from relativeDate).
const BASE = "2026-06-09T12:00:00.000Z";

// Labels shared between the full catalog and buildAgentErrorGallery's filter —
// constants so renaming a section can't silently drop it from the error
// gallery.
const ERROR_SECTION_LABEL = "Error";
const CREDITS_SECTION_LABEL = "Out of credits";

function userTurn(id: string, text: string): AgentChatTurn {
  return {
    id: `gallery:${id}`,
    role: "user",
    createdAt: BASE,
    status: "complete",
    parts: [{ type: "text", text, status: "complete" }],
  };
}

function assistantTurn(
  id: string,
  parts: AgentChatPart[],
  status: AgentChatTurn["status"] = "complete",
): AgentChatTurn {
  return {
    id: `gallery:${id}`,
    role: "assistant",
    createdAt: BASE,
    status,
    parts,
  };
}

const MARKDOWN_SAMPLE = `## Markdown rendering

Here is a paragraph with **bold**, *italic*, ~~strikethrough~~, and \`inline code\`.
Also a [link to the docs](https://example.com).

- Bulleted list item one
- Item two with a longer line that wraps to check leading and rhythm
- Item three

1. Ordered item one
2. Ordered item two

> A blockquote, for when the agent is citing something.

\`\`\`ts
function greet(name: string) {
  return \`Hello, \${name}\`;
}
\`\`\`

| Column | Value |
| ------ | ----- |
| Alpha  | 1     |
| Beta   | 2     |
`;

export function buildAgentChatGallery(): AgentChatGallerySection[] {
  return [
    {
      label: "User message",
      description: "The person's own turn (markdown supported).",
      turns: [
        userTurn(
          "user",
          "Can you summarize the meeting notes and **bold** the action items?",
        ),
      ],
    },
    {
      label: "Assistant text (markdown)",
      description:
        "Standard assistant prose. Exercises every markdown element.",
      turns: [
        assistantTurn("text", [
          { type: "text", text: MARKDOWN_SAMPLE, status: "complete" },
        ]),
      ],
    },
    {
      label: "Generated files",
      description:
        "Download cards for files the agent produced. The icon is keyed off the file extension; the download button only shows on hover.",
      turns: [
        assistantTurn("artifacts", [
          {
            type: "text",
            text: "Done. I exported three files: the chart as `revenue-chart.png`, the write-up in `summary.md`, and the raw run output in `build-log.txt`.",
            status: "complete",
          },
        ]),
      ],
      artifacts: [
        {
          name: "revenue-chart.png",
          path: "~/Library/Application Support/co.opensoftware.scribe/hermes/workspace/revenue-chart.png",
          rootLabel: "Workspace",
          size: 31_000,
        },
        {
          name: "summary.md",
          path: "~/Library/Application Support/co.opensoftware.scribe/hermes/workspace/summary.md",
          rootLabel: "Workspace",
          size: 4_200,
        },
        {
          name: "build-log.txt",
          path: "~/Library/Application Support/co.opensoftware.scribe/hermes/workspace/2026-06-09/run-4821/artifacts/logs/build-log.txt",
          rootLabel: "Home",
          size: 1_280_000,
        },
      ],
    },
    {
      label: "Thinking: in progress",
      description:
        "Reasoning + tool still running. Shows the shimmering “Thinking” disclosure and a running tool row.",
      turns: [
        assistantTurn(
          "thinking-running",
          [
            {
              type: "reasoning",
              text: "Let me check the filesystem snapshot before answering, then decide whether a tool call is needed.",
              status: "running",
            },
            {
              type: "tool",
              id: "tool-running",
              name: "Read File",
              text: "",
              status: "running",
            },
          ],
          "running",
        ),
      ],
    },
    {
      label: "Thought: completed, with tools",
      description:
        "Collapsed “Thought” disclosure folding completed + failed tool calls, followed by the answer text.",
      turns: [
        assistantTurn("thought-complete", [
          {
            type: "reasoning",
            text: "The note lives in the local store. I read it, ran a quick grep, then composed the summary.",
            status: "complete",
          },
          {
            type: "tool",
            id: "tool-complete",
            name: "Run Command",
            text: "$ grep -n 'TODO' notes.md\n12: TODO: send recap\n40: TODO: book room",
            status: "complete",
          },
          {
            type: "tool",
            id: "tool-failed",
            name: "Fetch Url",
            text: "Request timed out after 30s.",
            status: "failed",
          },
          {
            type: "text",
            text: "Done. I found two action items and added them to the recap above.",
            status: "complete",
          },
        ]),
      ],
    },
    {
      label: ERROR_SECTION_LABEL,
      description:
        "A surfaced error renders as a failed tool row named “Error”.",
      turns: [
        assistantTurn("error", [
          {
            type: "tool",
            id: "error",
            name: "Error",
            text: "The agent process exited unexpectedly (code 1).",
            status: "failed",
          },
        ]),
      ],
    },
    {
      label: CREDITS_SECTION_LABEL,
      description:
        "A turn that died on a billing failure renders as a notice card with a top-up action instead of the raw provider error.",
      turns: [
        assistantTurn("credits", [
          {
            type: "notice",
            kind: "credits",
            text: "Error: Error code: 402 - {'data': None, 'success': False, 'error_code': 4301, 'message': 'insufficient_credits'}",
          },
        ]),
      ],
    },
    {
      label: "Context compacted",
      description:
        "System summary inserted when earlier turns are compacted. Collapsed to one quiet line; hover swaps the glyph for +/−, expand reveals the summary. Two body variants (LLM summary / deterministic fallback).",
      turns: [
        {
          id: "gallery:context-normal",
          role: "system",
          createdAt: BASE,
          status: "complete",
          parts: [
            {
              type: "context",
              preview: "Earlier turns were compacted into a reference summary.",
              text: "[CONTEXT SUMMARY]: The user is restyling the dictation page. Decisions so far: keep sentence-case labels, reuse tokens.css, defer the delete-transcriptions flow.",
              status: "complete",
            },
          ],
        },
        {
          id: "gallery:context-fallback",
          role: "system",
          createdAt: BASE,
          status: "complete",
          parts: [
            {
              type: "context",
              preview:
                "Earlier turns were compacted; fallback summary generated without the LLM summarizer.",
              text: "[CONTEXT COMPACTION - deterministic fallback]: Summarizer unavailable; kept the most recent turns verbatim.",
              status: "complete",
            },
          ],
        },
      ],
    },
    {
      label: "Approval: pending",
      description:
        "Approval request awaiting a choice. Buttons: Explain first / Approve once / This session / Always / Deny.",
      turns: [
        assistantTurn("approval-pending", [
          {
            type: "approval",
            id: "approval-pending",
            command: "rm -rf ./build && npm run build",
            description: "The agent wants to run a shell command.",
            allowPermanent: true,
            status: "pending",
          },
        ]),
      ],
    },
    {
      label: "Approval: pending (no “Always”)",
      description:
        "When allowPermanent is false the “Always” button is hidden.",
      turns: [
        assistantTurn("approval-no-permanent", [
          {
            type: "approval",
            id: "approval-no-permanent",
            command: "curl https://api.example.com/charge",
            description: "Network request that can't be permanently allowed.",
            allowPermanent: false,
            status: "pending",
          },
        ]),
      ],
    },
    {
      label: "Approval: resolved",
      description:
        "Each resolved outcome: approved once / session / always / denied.",
      turns: [
        assistantTurn("approval-once", [
          {
            type: "approval",
            id: "approval-once",
            command: "git status",
            description: "Approved once.",
            allowPermanent: true,
            choice: "once",
            status: "resolved",
          },
        ]),
        assistantTurn("approval-session", [
          {
            type: "approval",
            id: "approval-session",
            command: "ls -la",
            description: "Approved for this session.",
            allowPermanent: true,
            choice: "session",
            status: "resolved",
          },
        ]),
        assistantTurn("approval-always", [
          {
            type: "approval",
            id: "approval-always",
            command: "cat package.json",
            description: "Always approved.",
            allowPermanent: true,
            choice: "always",
            status: "resolved",
          },
        ]),
        assistantTurn("approval-deny", [
          {
            type: "approval",
            id: "approval-deny",
            command: "rm -rf /",
            description: "Denied.",
            allowPermanent: true,
            choice: "deny",
            status: "resolved",
          },
        ]),
      ],
    },
    {
      label: "Clarify: pending (choices)",
      description:
        "Question with multiple-choice answers plus an “Other” escape hatch.",
      turns: [
        assistantTurn("clarify-choices", [
          {
            type: "clarify",
            id: "clarify-choices",
            question: "Which format should the recap use?",
            choices: ["Bulleted list", "Numbered steps", "Short paragraph"],
            status: "pending",
          },
        ]),
      ],
    },
    {
      label: "Clarify: pending (free-form)",
      description:
        "No preset choices. Renders the free-form textarea directly.",
      turns: [
        assistantTurn("clarify-freeform", [
          {
            type: "clarify",
            id: "clarify-freeform",
            question: "What should I name the exported file?",
            choices: [],
            status: "pending",
          },
        ]),
      ],
    },
    {
      label: "Clarify: answered",
      description: "Resolved clarify showing the chosen answer.",
      turns: [
        assistantTurn("clarify-answered", [
          {
            type: "clarify",
            id: "clarify-answered",
            question: "Which format should the recap use?",
            choices: ["Bulleted list", "Numbered steps", "Short paragraph"],
            answer: "Bulleted list",
            status: "resolved",
          },
        ]),
      ],
    },
    {
      label: "Clarify: skipped",
      description:
        "Resolved clarify where the person skipped without answering.",
      turns: [
        assistantTurn("clarify-skipped", [
          {
            type: "clarify",
            id: "clarify-skipped",
            question: "Any constraints on the file name?",
            choices: [],
            answer: "",
            status: "resolved",
          },
        ]),
      ],
    },
    {
      label: "Sudo: pending (unrestricted)",
      description:
        "Privilege-escalation prompt. Explicit approve/deny, with the execution mode shown so the blast radius is clear.",
      turns: [
        assistantTurn("sudo-pending", [
          {
            type: "sudo",
            id: "sudo-pending",
            command: "apt-get install ripgrep",
            reason: "ripgrep is required to search the dependency tree",
            mode: "unrestricted",
            status: "pending",
          },
        ]),
      ],
    },
    {
      label: "Sudo: approved",
      description: "Resolved sudo request showing the granted decision.",
      turns: [
        assistantTurn("sudo-approved", [
          {
            type: "sudo",
            id: "sudo-approved",
            command: "chmod +x ./scripts/build.sh",
            reason: "Make the build script executable",
            mode: "sandboxed",
            approved: true,
            status: "resolved",
          },
        ]),
      ],
    },
    {
      label: "Secret: pending",
      description:
        "Secret request with a secure (masked) input. The value is never persisted, logged, or echoed. Only the key name (redacted when sensitive) and reason show.",
      turns: [
        assistantTurn("secret-pending", [
          {
            type: "secret",
            id: "secret-pending",
            keyName: "OPENAI_API_KEY",
            reason: "Needed to call the OpenAI API on your behalf",
            status: "pending",
          },
        ]),
      ],
    },
    {
      label: "Secret: provided",
      description: "Resolved secret request. No value is ever shown.",
      turns: [
        assistantTurn("secret-provided", [
          {
            type: "secret",
            id: "secret-provided",
            keyName: "DATABASE_PASSWORD",
            reason: "Needed to connect to your database",
            status: "resolved",
          },
        ]),
      ],
    },
    {
      label: "Empty: thinking placeholder",
      description:
        "An assistant turn with no parts yet shows the shimmering “Thinking…” fallback.",
      turns: [assistantTurn("empty", [], "running")],
    },
  ];
}

// The error-focused gallery (window.__agentErrors) is the full catalog
// filtered to its failure surfaces — one source of truth for the samples. The
// chrome-level error states (the error banner and the composer busy notice)
// aren't turns, so the workspace forces those alongside these sections.
const ERROR_SECTION_LABELS = new Set([
  ERROR_SECTION_LABEL,
  CREDITS_SECTION_LABEL,
]);

export function buildAgentErrorGallery(): AgentChatGallerySection[] {
  return buildAgentChatGallery().filter((section) =>
    ERROR_SECTION_LABELS.has(section.label),
  );
}
