import { describe, expect, it } from "vitest";
import {
  categoryPrompt,
  displayedUserMessageText,
  issueReportPrompt,
} from "../lib/issue-report-prompt";

describe("issue report prompt display", () => {
  it("shows only the user's report for a wrapped prompt", () => {
    const report =
      "I want to report an issue with June.\n\nWhat happened: the recorder crashes";
    const wrapped = issueReportPrompt(report);
    expect(wrapped).toContain("in-app reporting flow");
    expect(displayedUserMessageText(wrapped)).toBe(report);
  });

  it("passes ordinary messages through untouched", () => {
    expect(displayedUserMessageText("just a normal question")).toBe(
      "just a normal question",
    );
  });

  it("does not mask a message that merely mentions one marker", () => {
    const tricky = "what does ---END USER REPORT--- mean in the logs?";
    expect(displayedUserMessageText(tricky)).toBe(tricky);
  });

  it("falls back to the full content when the wrapper is empty", () => {
    const wrapped = issueReportPrompt("   ");
    expect(displayedUserMessageText(wrapped)).toBe(wrapped);
  });

  it("frames each category with its own preamble but the same markers", () => {
    const report = "the sidebar feels cramped";
    const bug = categoryPrompt("bug", report);
    const feedback = categoryPrompt("feedback", report);
    const feature = categoryPrompt("feature", report);

    expect(bug).toContain("bug report");
    expect(feedback).toContain("sharing feedback");
    expect(feature).toContain("requesting a feature");

    // All three wrap the user's words identically, so the transcript strips
    // them back to exactly what was typed.
    for (const wrapped of [bug, feedback, feature]) {
      expect(wrapped).toContain("---USER REPORT---");
      expect(displayedUserMessageText(wrapped)).toBe(report);
    }
  });

  it("keeps issueReportPrompt as the bug-category wrapper", () => {
    expect(issueReportPrompt("x")).toBe(categoryPrompt("bug", "x"));
  });
});
