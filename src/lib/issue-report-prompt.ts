/**
 * The report investigation prompts. When a composer message carries a category
 * tag (bug / feedback / feature), the user's text is wrapped in an instruction
 * preamble for June, and the wrapped whole becomes the session's first user
 * message — the runtime needs it verbatim. The transcript, on the other hand,
 * must show only what the user actually typed: the preamble is plumbing, not
 * conversation (see `displayedUserMessageText`).
 */

import type { ReportCategory } from "../components/agent/composer/reportCategory";

const USER_REPORT_START = "---USER REPORT---";
const USER_REPORT_END = "---END USER REPORT---";

const PREAMBLES: Record<ReportCategory, string[]> = {
  bug: [
    "The user is filing a bug report about the June desktop app. This conversation is part of the in-app reporting flow: your reply will be attached to the report and sent to the June development team, so write it for them.",
    "",
    "Do not try to fix the issue or walk the user through troubleshooting. Instead:",
    "1. Read the report below and inspect any attached files or screenshots closely. Describe exactly what they show, including any visible error text.",
    "2. Give your assessment of what is going wrong and which part of the app is likely involved.",
    "3. If the report contains multiple distinct bugs, requests, or product questions, separate them into numbered sections titled exactly `Issue 1: <short title>`, `Issue 2: <short title>`, and so on.",
    "4. Note anything else the team should look at.",
    "",
    "Keep it concise and factual. Close by thanking the user and letting them know the report and your assessment are being sent to the June team.",
  ],
  feedback: [
    "The user is sharing feedback about the June desktop app. This conversation is part of the in-app feedback flow: your reply will be attached to the feedback and sent to the June development team, so write it for them.",
    "",
    "Do not treat this as a task to act on. Instead:",
    "1. Read the feedback below and inspect any attached files or screenshots closely. Describe what they show.",
    "2. Reflect back what you heard in a sentence or two, and note which part of the app it concerns.",
    "3. If the feedback contains multiple distinct bugs, requests, or product questions, separate them into numbered sections titled exactly `Issue 1: <short title>`, `Issue 2: <short title>`, and so on.",
    "4. Note anything else the team should weigh.",
    "",
    "Keep it concise and warm. Close by thanking the user and letting them know their feedback and your summary are being sent to the June team.",
  ],
  feature: [
    "The user is requesting a feature for the June desktop app. This conversation is part of the in-app request flow: your reply will be attached to the request and sent to the June development team, so write it for them.",
    "",
    "Do not try to build or prototype the feature. Instead:",
    "1. Read the request below and inspect any attached files or screenshots closely. Describe what they show.",
    "2. Summarize the request and the underlying need or problem it would solve, and note which part of the app it touches.",
    "3. If the request contains multiple distinct bugs, requests, or product questions, separate them into numbered sections titled exactly `Issue 1: <short title>`, `Issue 2: <short title>`, and so on.",
    "4. Note anything else the team should consider.",
    "",
    "Keep it concise and constructive. Close by thanking the user and letting them know their request and your summary are being sent to the June team.",
  ],
};

/** Frames the user's report for June based on its category: investigate and
 * write something for the team rather than treating it as a normal request. */
export function categoryPrompt(category: ReportCategory, report: string) {
  return [
    ...PREAMBLES[category],
    "",
    USER_REPORT_START,
    report,
    USER_REPORT_END,
  ].join("\n");
}

/** Bug-category wrapper, kept as a named export for the original report flow. */
export function issueReportPrompt(report: string) {
  return categoryPrompt("bug", report);
}

/** What a user message should look like in the transcript: a wrapped report
 * renders as just the report the user typed. Both markers must be present and
 * ordered, so ordinary messages — even ones discussing the markers — pass
 * through untouched. */
export function displayedUserMessageText(content: string): string {
  const start = content.indexOf(USER_REPORT_START);
  if (start === -1) return content;
  const end = content.lastIndexOf(USER_REPORT_END);
  if (end <= start) return content;
  const report = content.slice(start + USER_REPORT_START.length, end).trim();
  return report || content;
}
