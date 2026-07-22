import { describe, expect, it } from "vitest";

import {
  appendIssueReportSessionContext,
  buildIssueReportSessionContext,
} from "../lib/issue-report-session-context";

describe("issue report session context", () => {
  it("includes only visible user and assistant conversation plus the sanitized trace", () => {
    const context = buildIssueReportSessionContext({
      title: "Chat greeting",
      messages: [
        { id: "system", role: "system", content: "hidden system prompt" },
        { id: "user", role: "user", content: "hey june whats up" },
        { id: "tool", role: "tool", content: "hidden tool output" },
        {
          id: "assistant",
          role: "assistant",
          content: "Hey! I’m here and ready to help.",
          reasoning: "hidden chain of thought",
        },
      ],
      trace: {
        sessionId: "session-1",
        exportedAt: "2026-07-22T18:00:00.000Z",
        entries: [
          {
            id: 1,
            direction: "inbound",
            observedAt: "2026-07-22T18:00:00.000Z",
            sessionId: "session-1",
            rawType: "future.event",
            normalizedKind: "unsupported",
            payloadKeys: ["token", "status"],
            payloadPreview: '{"token":"[REDACTED]","status":"waiting"}',
          },
        ],
      },
    });

    expect(context).toContain("Session title: Chat greeting");
    expect(context).toContain("User: hey june whats up");
    expect(context).toContain("June: Hey! I’m here and ready to help.");
    expect(context).toContain("type=future.event kind=unsupported");
    expect(context).toContain('payload={"token":"[REDACTED]"');
    expect(context).not.toContain("hidden system prompt");
    expect(context).not.toContain("hidden tool output");
    expect(context).not.toContain("hidden chain of thought");
  });

  it("appends related context after the user's description", () => {
    expect(appendIssueReportSessionContext("The session showed an error.", "Session trace")).toBe(
      "The session showed an error.\n\n## Related session context\n\nSession trace",
    );
  });

  it("bounds added context below the server description limit", () => {
    const description = "d".repeat(10_000);
    const newestDiagnostic = "type=future.event kind=unsupported newest=true";
    const result = appendIssueReportSessionContext(
      description,
      `${"older-context\n".repeat(1_500)}${newestDiagnostic}`,
    );

    expect(Array.from(result)).toHaveLength(19_500);
    expect(result).toContain("## Related session context");
    expect(result).toContain("[Earlier context omitted]");
    expect(result.endsWith(newestDiagnostic)).toBe(true);
  });
});
