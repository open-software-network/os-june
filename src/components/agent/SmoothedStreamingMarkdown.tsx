import { useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { createInlineMarkdownPattern, MarkdownContent } from "./MarkdownContent";

// Deltas gather for one beat, then the whole backlog mounts in a single
// commit — every word in the batch shares one fade timeline, so a chunk
// surfaces as a unit instead of a mask sweeping left to right. The interval
// is the batch width: long enough that a fast token stream groups into
// visible chunks (and markdown parsing stays off the display refresh), short
// enough that the response never feels laggy.
const STREAM_REVEAL_INTERVAL_MS = 80;

// Longest unclosed inline tail we will stall the reveal on. Past this an open
// `*` or `[` is literal prose (a bullet used as a word, math, a bracket
// citation), not a construct still streaming its closing token — revealing it
// beats freezing the stream on text that will never close.
const HOLDBACK_MAX_CHARS = 160;

// Completed inline constructs, mirroring MarkdownContent's inline grammar
// exactly. We strip these to locate where the still-open tail begins.
const INLINE_PATTERN = createInlineMarkdownPattern();
const TABLE_SEPARATOR_PATTERN = /^\|(\s*:?-+:?\s*\|)+$/;
const POSSIBLE_TABLE_SEPARATOR_PATTERN = /^\|[\s:|-]*$/;

function lineStartIndex(segment: string, at: number): number {
  const newline = segment.lastIndexOf("\n", at - 1);
  return newline < 0 ? 0 : newline + 1;
}

// A `*` opening a list item (`* item`) or sitting on a thematic-break line
// (`***`) is not an inline emphasis opener, so it must not stall the reveal.
function isBlockLevelStar(segment: string, at: number): boolean {
  const start = lineStartIndex(segment, at);
  let end = segment.indexOf("\n", at);
  if (end < 0) end = segment.length;
  const line = segment.slice(start, end).trim();
  if (/^([-*_])\1{2,}$/.test(line)) return true;
  const before = segment.slice(start, at);
  const next = segment[at + 1];
  return before.trim() === "" && next !== undefined && /\s/.test(next);
}

// Earliest index in `segment` where an inline construct opens but has not yet
// completed within the text, or -1 if the tail is safe to reveal. Completed
// constructs are opaque only when the scan reaches their own opener: a later
// complete code span must not hide an earlier still-open emphasis marker.
function firstOpenOpener(segment: string): number {
  const completedEnds = new Map<number, number>();
  INLINE_PATTERN.lastIndex = 0;
  for (
    let match = INLINE_PATTERN.exec(segment);
    match !== null;
    match = INLINE_PATTERN.exec(segment)
  ) {
    completedEnds.set(match.index, INLINE_PATTERN.lastIndex);
  }

  for (let at = 0; at < segment.length; at += 1) {
    const completedEnd = completedEnds.get(at);
    if (completedEnd !== undefined) {
      at = completedEnd - 1;
      continue;
    }
    const ch = segment[at];
    // A backtick with no closing backtick remaining opens a code span.
    if (ch === "`") return at;
    // `~~` opens strikethrough; a lone `~` is literal.
    if (ch === "~") {
      if (segment[at + 1] === "~") return at;
      // A trailing `~` may become the first half of `~~` in the next chunk.
      // Hold it until another character proves that it is literal.
      if (segment[at + 1] === undefined) return at;
      continue;
    }
    // `*` / `**` open emphasis unless it is a bullet, thematic break, or a
    // literal star followed by whitespace (`2 * 3`, `use * as a wildcard`).
    if (ch === "*") {
      if (isBlockLevelStar(segment, at)) continue;
      const markerLength = segment[at + 1] === "*" ? 2 : 1;
      const next = segment[at + markerLength];
      if (next !== undefined && /\s/.test(next)) {
        at += markerLength - 1;
        continue;
      }
      return at;
    }
    // `[` opens a link only while the remainder still looks like the
    // renderer's incomplete-link shapes; a `]` followed by anything but `(`
    // means it is a plain bracket, not a link.
    if (ch === "[") {
      const tail = segment.slice(at);
      if (
        /^\[[^\]]*$/.test(tail) ||
        /^\[[^\]]+\]$/.test(tail) ||
        /^\[[^\]]+\]\([^)\s]*$/.test(tail)
      ) {
        return at;
      }
    }
  }
  return -1;
}

function fenceState(text: string): { open: boolean; afterLastClosed: number } {
  let open = false;
  let afterLastClosed = 0;
  let offset = 0;
  const lines = text.split("\n");

  for (const [index, line] of lines.entries()) {
    const afterLine = offset + line.length + (index < lines.length - 1 ? 1 : 0);
    if (line.trim().startsWith("```")) {
      open = !open;
      if (!open) afterLastClosed = afterLine;
    }
    offset = afterLine;
  }

  return { open, afterLastClosed };
}

// A pipe row cannot be known to be a table header until the following
// separator arrives. Keep a still-possible header offscreen so it appears once
// as <th> content instead of first fading as a paragraph, remounting, and
// fading again when the separator changes its block parse.
function pendingTableHeaderStart(segment: string): number {
  const tableLine = (line: string) => {
    let content = line.trim();
    let quoteDepth = 0;
    while (content.startsWith(">")) {
      quoteDepth += 1;
      content = content.slice(1).trimStart();
    }
    return { content, quoteDepth };
  };
  const lines = segment.split("\n");
  let lineStart = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const { content: trimmed, quoteDepth } = tableLine(line);
    if (!trimmed.startsWith("|")) {
      lineStart += line.length + 1;
      continue;
    }

    const nextLine = lines[index + 1];
    if (nextLine === undefined) return lineStart;

    const completeHeader = trimmed.endsWith("|") && trimmed.length > 1;
    const { content: next, quoteDepth: nextQuoteDepth } = tableLine(nextLine);
    if (completeHeader && next === "" && index + 1 === lines.length - 1) return lineStart;
    if (quoteDepth !== nextQuoteDepth) {
      lineStart += line.length + 1;
      continue;
    }
    if (completeHeader && TABLE_SEPARATOR_PATTERN.test(next)) {
      // This table's structure is established. Skip its separator and body;
      // a later candidate in the same paragraph can still be considered.
      index += 1;
      lineStart += line.length + 1 + nextLine.length + 1;
      while (index + 1 < lines.length) {
        const body = lines[index + 1];
        const { content: bodyTrimmed, quoteDepth: bodyQuoteDepth } = tableLine(body);
        if (
          bodyQuoteDepth !== quoteDepth ||
          !(bodyTrimmed.startsWith("|") && bodyTrimmed.endsWith("|"))
        ) {
          break;
        }
        index += 1;
        lineStart += body.length + 1;
      }
      continue;
    }
    if (completeHeader && POSSIBLE_TABLE_SEPARATOR_PATTERN.test(next)) return lineStart;

    lineStart += line.length + 1;
  }
  return -1;
}

/**
 * Index up to which streamed markdown is safe to reveal without a visible word
 * later jumping parse branches. Append-only text can turn literal prose into
 * emphasis / a link once its closing token arrives (`**important` becomes a
 * `<strong>`), which moves the word into a different parent element, remounts
 * its `.agent-stream-word` span at opacity 0, and re-fades it for 1.5s — a word
 * blinking out. We withhold an incomplete trailing inline construct until it
 * closes (or runs long enough to be literal). Exported for tests.
 */
export function holdbackSafeEnd(text: string): number {
  // Fence bodies render unanimated and must keep streaming. Once a fence
  // closes, scan only prose after it so its delimiter backticks can never be
  // mistaken for inline-code openers.
  const fences = fenceState(text);
  if (fences.open) return text.length;

  // Only the tail after the last blank line can still be open — earlier
  // paragraphs are already flushed and parsed. A completed fence is also a
  // hard block boundary, even when following prose starts on the next line.
  const lastBreak = text.lastIndexOf("\n\n");
  const segmentStart = Math.max(lastBreak < 0 ? 0 : lastBreak + 2, fences.afterLastClosed);
  const segment = text.slice(segmentStart);

  const tableAt = pendingTableHeaderStart(segment);
  if (tableAt >= 0) {
    const holdIndex = segmentStart + tableAt;
    return text.length - holdIndex > HOLDBACK_MAX_CHARS ? text.length : holdIndex;
  }

  const openAt = firstOpenOpener(segment);
  if (openAt < 0) return text.length;

  const holdIndex = segmentStart + openAt;
  // An unclosed `*`/`[` that runs long is literal usage — never stall on it.
  if (text.length - holdIndex > HOLDBACK_MAX_CHARS) return text.length;
  return holdIndex;
}

/**
 * Presents append-only assistant text as chunk-batched reveals: deltas are
 * held for one short beat and released together, so each batch fades in as a
 * unit (see agent-stream-word-in). The authoritative text remains the raw
 * stream in AgentWorkspace; this component only trails it by at most one
 * batch interval.
 */
export function SmoothedStreamingMarkdown({
  markdown,
  running,
  repairProse = false,
  onVisibleMarkdownChange,
}: {
  markdown: string;
  running: boolean;
  repairProse?: boolean;
  onVisibleMarkdownChange?: (visibleMarkdown: string) => void;
}) {
  const reducedMotion = useReducedMotion() ?? false;
  const initialVisible =
    !running || reducedMotion || document.hidden
      ? markdown
      : markdown.slice(0, holdbackSafeEnd(markdown));
  // True from the moment a streaming turn completes until its trailing word
  // fades have had time to finish — the spans stay mounted through it.
  const [settling, setSettling] = useState(false);
  const [prevRunning, setPrevRunning] = useState(running);
  const [visibleMarkdown, setVisibleMarkdown] = useState(initialVisible);
  const visibleRef = useRef(initialVisible);
  const targetRef = useRef(markdown);
  const timerRef = useRef<number | null>(null);
  const visibleMarkdownMountedRef = useRef(false);

  const reveal = useCallback((next: string) => {
    visibleRef.current = next;
    setVisibleMarkdown(next);
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const scheduleReveal = useCallback(() => {
    if (timerRef.current !== null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      // Everything that arrived during the batch interval mounts at once, in
      // one commit, so the whole batch starts its fade on the same frame.
      // Reveal only up to the safe holdback so an incomplete trailing
      // construct does not surface and then re-parse under the next delta.
      const safe = targetRef.current.slice(0, holdbackSafeEnd(targetRef.current));
      if (safe !== visibleRef.current) {
        reveal(safe);
      }
    }, STREAM_REVEAL_INTERVAL_MS);
  }, [reveal]);

  useLayoutEffect(() => {
    targetRef.current = markdown;
    // Completion, reduced motion, and a hidden document all reveal the full
    // text unchanged — no fade to protect, so no reason to withhold a tail.
    if (!running || reducedMotion || document.hidden) {
      stopTimer();
      reveal(markdown);
      return;
    }
    // First chunk, or a reconciled (non-prefix) replacement: reveal instantly
    // rather than waiting a beat, but still only up to the safe holdback.
    if (visibleRef.current.length === 0 || !markdown.startsWith(visibleRef.current)) {
      stopTimer();
      const safe = markdown.slice(0, holdbackSafeEnd(markdown));
      if (safe !== visibleRef.current) reveal(safe);
      return;
    }
    scheduleReveal();
  }, [markdown, reducedMotion, reveal, running, scheduleReveal, stopTimer]);

  useEffect(() => {
    const flushWhileHidden = () => {
      if (document.hidden) {
        stopTimer();
        reveal(targetRef.current);
      }
    };
    document.addEventListener("visibilitychange", flushWhileHidden);
    return () => {
      document.removeEventListener("visibilitychange", flushWhileHidden);
      stopTimer();
    };
  }, [reveal, stopTimer]);

  useLayoutEffect(() => {
    if (!visibleMarkdownMountedRef.current) {
      visibleMarkdownMountedRef.current = true;
      return;
    }
    onVisibleMarkdownChange?.(visibleMarkdown);
  }, [onVisibleMarkdownChange, visibleMarkdown]);

  // Adjust state during render (React's "you can update state while
  // rendering" pattern): begin settling on the very commit that carries
  // running=false, and cancel it if the turn resumes. Detecting the
  // transition in a passive effect instead would paint one frame with
  // animateWords already false — every .agent-stream-word span would unwrap,
  // then the effect's re-render would re-wrap and remount them, restarting
  // every fade from 0.
  if (running !== prevRunning) {
    setPrevRunning(running);
    setSettling(!running && !reducedMotion);
  }
  if (settling && reducedMotion) setSettling(false);

  // Raw chunks still re-render the parent. Reuse the parsed markdown element
  // until the presentation string advances so smoothing does not add duplicate
  // markdown work on those intermediate renders.
  //
  // Word fade-in only exists while the turn streams (plus the settle window):
  // afterwards the turn re-renders as plain text, so the spans never
  // accumulate in the transcript DOM.
  const animateWords = (running || settling) && !reducedMotion;
  return useMemo(
    () => (
      <MarkdownContent
        markdown={visibleMarkdown}
        repairProse={repairProse}
        animateWords={animateWords}
        settlingWords={settling}
        onWordsSettled={() => setSettling(false)}
      />
    ),
    [animateWords, repairProse, settling, visibleMarkdown],
  );
}
