import { describe, expect, it } from "vitest";
import {
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
});
