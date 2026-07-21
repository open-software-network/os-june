import { useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { MarkdownContent } from "./MarkdownContent";

// Deltas gather for one beat, then the whole backlog mounts in a single
// commit — every word in the batch shares one fade timeline, so a chunk
// surfaces as a unit instead of a mask sweeping left to right. The interval
// is the batch width: long enough that a fast token stream groups into
// visible chunks (and markdown parsing stays off the display refresh), short
// enough that the response never feels laggy.
const STREAM_REVEAL_INTERVAL_MS = 80;

// How long the word-fade spans stay mounted after the turn completes. Must
// cover the agent-stream-word-in duration in app.css so the trailing ink
// gradient finishes settling naturally; unwrapping at completion would snap
// the last ~1.5s of words to full ink.
const STREAM_WORD_FADE_SETTLE_MS = 1700;

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
  // True from the moment a streaming turn completes until its trailing word
  // fades have had time to finish — the spans stay mounted through it.
  const [settling, setSettling] = useState(false);
  const wasRunningRef = useRef(running);
  const [visibleMarkdown, setVisibleMarkdown] = useState(markdown);
  const visibleRef = useRef(markdown);
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
      if (visibleRef.current !== targetRef.current) {
        reveal(targetRef.current);
      }
    }, STREAM_REVEAL_INTERVAL_MS);
  }, [reveal]);

  useLayoutEffect(() => {
    targetRef.current = markdown;
    if (
      !running ||
      reducedMotion ||
      document.hidden ||
      visibleRef.current.length === 0 ||
      !markdown.startsWith(visibleRef.current)
    ) {
      stopTimer();
      reveal(markdown);
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

  // Completion keeps the spans through a settle window rather than unwrapping
  // immediately, so the trailing gradient finishes fading on its own clock.
  // A turn rendered from history was never running here and gets plain text.
  useEffect(() => {
    if (running) {
      wasRunningRef.current = true;
      setSettling(false);
      return;
    }
    if (!wasRunningRef.current) return;
    wasRunningRef.current = false;
    setSettling(true);
    const timer = window.setTimeout(() => setSettling(false), STREAM_WORD_FADE_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [running]);

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
      />
    ),
    [animateWords, repairProse, visibleMarkdown],
  );
}
