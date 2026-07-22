import { stripProjectContext } from "./agent-project-context";
import { displayedComposerUserMessageText, textFromHermesContent } from "./agent-chat-runtime";
import { stripScheduledRunPreamble } from "./hermes-adapter";
import type { SanitizedTraceBundle } from "./hermes-trace-buffer";
import type { HermesSessionMessage } from "./tauri";

const TRANSCRIPT_MAX_CHARS = 8_000;
const TRACE_MAX_CHARS = 8_000;
// June API accepts 20,000 description characters. Leave a little headroom for
// Unicode/counting differences across the TypeScript and Rust boundary.
const REPORT_DESCRIPTION_SAFE_MAX_CHARS = 19_500;

function truncateStart(value: string, maxChars: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxChars) return value;
  const marker = "[Earlier context omitted]\n";
  const markerCharacters = Array.from(marker);
  if (maxChars <= markerCharacters.length) {
    return characters.slice(-maxChars).join("");
  }
  return `${marker}${characters.slice(-(maxChars - markerCharacters.length)).join("")}`;
}

function visibleMessageText(message: HermesSessionMessage): string {
  const text = textFromHermesContent(message.content) ?? textFromHermesContent(message.text) ?? "";
  const withoutProjectContext = stripProjectContext(text);
  const withoutWarnings = withoutProjectContext.replace(/\n*--- Context Warnings ---[\s\S]*$/m, "");
  const attachedContextMarker = withoutWarnings.search(/\n*--- Attached Context ---/m);
  const visible =
    attachedContextMarker >= 0 ? withoutWarnings.slice(0, attachedContextMarker) : withoutWarnings;
  return displayedComposerUserMessageText(stripScheduledRunPreamble(visible.trim())).trim();
}

function visibleTranscript(messages: HermesSessionMessage[]): string | undefined {
  const turns = messages.flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const text = visibleMessageText(message);
    if (!text) return [];
    return [`${message.role === "user" ? "User" : "June"}: ${text}`];
  });
  if (!turns.length) return undefined;
  return truncateStart(turns.join("\n\n"), TRANSCRIPT_MAX_CHARS);
}

function sanitizedTrace(trace: SanitizedTraceBundle): string | undefined {
  const entries = trace.entries.map((entry) => {
    const details = [
      entry.rawType ? `type=${entry.rawType}` : undefined,
      entry.normalizedKind ? `kind=${entry.normalizedKind}` : undefined,
      entry.method ? `method=${entry.method}` : undefined,
      entry.message ? `message=${entry.message}` : undefined,
      entry.payloadKeys.length ? `keys=${entry.payloadKeys.join(",")}` : undefined,
      entry.payloadPreview ? `payload=${entry.payloadPreview}` : undefined,
    ].filter(Boolean);
    return `${entry.observedAt} ${entry.direction}${details.length ? ` ${details.join(" ")}` : ""}`;
  });
  if (!entries.length) return undefined;
  return truncateStart(entries.join("\n"), TRACE_MAX_CHARS);
}

export function buildIssueReportSessionContext(input: {
  title?: string;
  messages: HermesSessionMessage[];
  trace: SanitizedTraceBundle;
}): string | undefined {
  const transcript = visibleTranscript(input.messages);
  const trace = sanitizedTrace(input.trace);
  if (!transcript && !trace) return undefined;

  const sections = [`Session title: ${input.title?.trim() || "Untitled session"}`];
  if (transcript) sections.push(`Visible conversation:\n\n${transcript}`);
  if (trace) sections.push(`Sanitized runtime trace:\n\n${trace}`);
  return sections.join("\n\n");
}

export function appendIssueReportSessionContext(
  description: string,
  sessionContext?: string,
): string {
  const trimmedDescription = description.trim();
  const trimmedContext = sessionContext?.trim();
  if (!trimmedContext) return trimmedDescription;
  const separator = "\n\n## Related session context\n\n";
  const remaining =
    REPORT_DESCRIPTION_SAFE_MAX_CHARS -
    Array.from(trimmedDescription).length -
    Array.from(separator).length;
  if (remaining <= 0) return trimmedDescription;
  // The trace is the final context section and is itself ordered oldest to
  // newest. Keep the tail so a long user description cannot discard the
  // unsupported event that prompted the report.
  const boundedContext = truncateStart(trimmedContext, remaining);
  return `${trimmedDescription}${separator}${boundedContext}`;
}
