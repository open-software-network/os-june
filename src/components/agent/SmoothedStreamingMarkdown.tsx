import { useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { MarkdownContent } from "./MarkdownContent";

// Keep the reveal comfortably above the threshold where individual updates
// read as discrete provider chunks, without making markdown parsing compete
// with every display refresh.
const STREAM_REVEAL_INTERVAL_MS = 32;
const STREAM_CATCH_UP_STEPS = 4;

/**
 * Smooths append-only assistant text for presentation. The authoritative text
 * remains the raw stream in AgentWorkspace; this component only trails it by a
 * few frames so irregular provider chunks read as one continuous response.
 */
export function SmoothedStreamingMarkdown({
  markdown,
  running,
  repairProse = false,
}: {
  markdown: string;
  running: boolean;
  repairProse?: boolean;
}) {
  const reducedMotion = useReducedMotion() ?? false;
  const [visibleMarkdown, setVisibleMarkdown] = useState(markdown);
  const visibleRef = useRef(markdown);
  const targetRef = useRef(markdown);
  const timerRef = useRef<number | null>(null);

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
    const tick = () => {
      timerRef.current = null;
      const current = visibleRef.current;
      const target = targetRef.current;
      if (current === target) return;

      // Completion reconciliation can replace streamed text rather than append
      // to it. Never animate through content the model has corrected.
      if (!target.startsWith(current)) {
        reveal(target);
        return;
      }

      const remaining = target.length - current.length;
      const step = Math.max(1, Math.ceil(remaining / STREAM_CATCH_UP_STEPS));
      const end = safeTextSliceEnd(target, Math.min(target.length, current.length + step));
      reveal(target.slice(0, end));
      if (end < target.length) {
        timerRef.current = window.setTimeout(tick, STREAM_REVEAL_INTERVAL_MS);
      }
    };
    timerRef.current = window.setTimeout(tick, STREAM_REVEAL_INTERVAL_MS);
  }, [reveal]);

  useLayoutEffect(() => {
    targetRef.current = markdown;
    if (!running || reducedMotion || !markdown.startsWith(visibleRef.current)) {
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

  // Raw chunks still re-render the parent. Reuse the parsed markdown element
  // until the presentation string advances so smoothing does not add duplicate
  // markdown work on those intermediate renders.
  return useMemo(
    () => <MarkdownContent markdown={visibleMarkdown} repairProse={repairProse} />,
    [repairProse, visibleMarkdown],
  );
}

function safeTextSliceEnd(text: string, proposedEnd: number) {
  if (proposedEnd <= 0 || proposedEnd >= text.length) return proposedEnd;
  const previous = text.charCodeAt(proposedEnd - 1);
  return previous >= 0xd800 && previous <= 0xdbff ? proposedEnd + 1 : proposedEnd;
}
