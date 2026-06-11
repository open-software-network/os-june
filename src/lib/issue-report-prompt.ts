/**
 * The issue-report investigation prompt. The user's report is wrapped in an
 * instruction preamble for June, and the wrapped whole becomes the session's
 * first user message — the runtime needs it verbatim. The transcript, on the
 * other hand, must show only what the user actually typed: the preamble is
 * plumbing, not conversation (see `displayedUserMessageText`).
 */

const USER_REPORT_START = "---USER REPORT---";
const USER_REPORT_END = "---END USER REPORT---";

export function issueReportPrompt(report: string) {
  return [
    "The user is filing a bug report about the June desktop app. This conversation is part of the in-app reporting flow: your reply will be attached to the report and sent to the June development team, so write it for them.",
    "",
    "Do not try to fix the issue or walk the user through troubleshooting. Instead:",
    "1. Read the report below and inspect any attached files or screenshots closely. Describe exactly what they show, including any visible error text.",
    "2. Give your assessment of what is going wrong and which part of the app is likely involved.",
    "3. Note anything else the team should look at.",
    "",
    "Keep it concise and factual. Close by thanking the user and letting them know the report and your assessment are being sent to the June team.",
    "",
    USER_REPORT_START,
    report,
    USER_REPORT_END,
  ].join("\n");
}

/** What a user message should look like in the transcript: an issue-report
 * wrapper renders as just the report the user typed. Both markers must be
 * present and ordered, so ordinary messages — even ones discussing the
 * markers — pass through untouched. */
export function displayedUserMessageText(content: string): string {
  const start = content.indexOf(USER_REPORT_START);
  if (start === -1) return content;
  const end = content.lastIndexOf(USER_REPORT_END);
  if (end <= start) return content;
  const report = content.slice(start + USER_REPORT_START.length, end).trim();
  return report || content;
}
