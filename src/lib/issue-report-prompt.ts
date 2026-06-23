/**
 * Legacy report prompt display helpers. Older saved sessions may contain a
 * wrapped report prompt; transcripts should still show only what the user
 * typed.
 */

const USER_REPORT_START = "---USER REPORT---";
const USER_REPORT_END = "---END USER REPORT---";

/** What a user message should look like in the transcript: a wrapped report
 * renders as just the report the user typed. Both markers must be present and
 * ordered, so ordinary messages, even ones discussing the markers, pass
 * through untouched. */
export function displayedUserMessageText(content: string): string {
  const start = content.indexOf(USER_REPORT_START);
  if (start === -1) return content;
  const end = content.lastIndexOf(USER_REPORT_END);
  if (end <= start) return content;
  const report = content.slice(start + USER_REPORT_START.length, end).trim();
  return report || content;
}
