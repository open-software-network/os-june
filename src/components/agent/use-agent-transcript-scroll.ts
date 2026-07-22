import { useCallback, useEffect, useRef } from "react";
import { isAgentTranscriptNearBottom } from "./chat-turns/TranscriptViews";
import type { UseAgentTranscriptScrollDependencies } from "./use-agent-transcript-scroll-types";

export function useAgentTranscriptScroll(dependencies: UseAgentTranscriptScrollDependencies) {
  const {
    agentScrollRef,
    composerClearance,
    hermesSessionMessages,
    hermesSessionsHydrated,
    hermesSessionsLoading,
    heroMode,
    listRef,
    renderedTurnsSignature,
    selectedHermesSessionId,
    selectedTask,
    selectedTaskId,
    taskHistoryLoadedIdsRef,
  } = dependencies;

  const settledScrollSelectionRef = useRef<string>();
  const transcriptShouldStickToBottomRef = useRef(true);
  const transcriptProgrammaticScrollRef = useRef(false);
  const transcriptProgrammaticScrollTimeoutRef = useRef<number | undefined>();
  const transcriptLastScrollTopRef = useRef(0);

  const pinTranscriptAfterVisibleReveal = useCallback(() => {
    if (!transcriptShouldStickToBottomRef.current) return;
    const scroller = agentScrollRef.current;
    if (!scroller || typeof scroller.scrollTo !== "function") return;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "auto" });
    transcriptLastScrollTopRef.current = scroller.scrollTop;
  }, []);

  // History for the selected conversation has landed: a session gets an entry
  // in hermesSessionMessages (even an empty one) once its fetch resolves;
  // tasks either arrive with their turns inline or get recorded when the lazy
  // hydration resolves. Settling keys off this rather than rendered turns so
  // a genuinely empty conversation still settles, and its first turn glides.
  const selectedHistoryLoaded = selectedHermesSessionId
    ? hermesSessionMessages[selectedHermesSessionId] !== undefined
    : selectedTask
      ? selectedTask.messages.length > 0 ||
        selectedTask.toolEvents.length > 0 ||
        taskHistoryLoadedIdsRef.current.has(selectedTask.id)
      : false;
  const startupSessionHydrationPending = hermesSessionsLoading && !hermesSessionsHydrated;

  useEffect(() => {
    if (heroMode) return;
    const scroller = agentScrollRef.current;
    if (!scroller) return;
    const clearProgrammaticScroll = () => {
      transcriptProgrammaticScrollRef.current = false;
      if (transcriptProgrammaticScrollTimeoutRef.current !== undefined) {
        window.clearTimeout(transcriptProgrammaticScrollTimeoutRef.current);
        transcriptProgrammaticScrollTimeoutRef.current = undefined;
      }
    };
    const updateStickiness = () => {
      const previousScrollTop = transcriptLastScrollTopRef.current;
      transcriptLastScrollTopRef.current = scroller.scrollTop;
      if (transcriptProgrammaticScrollRef.current) {
        if (scroller.scrollTop < previousScrollTop) {
          clearProgrammaticScroll();
          transcriptShouldStickToBottomRef.current = isAgentTranscriptNearBottom(scroller);
          return;
        }
        transcriptShouldStickToBottomRef.current = true;
        if (isAgentTranscriptNearBottom(scroller)) clearProgrammaticScroll();
        return;
      }
      transcriptShouldStickToBottomRef.current = isAgentTranscriptNearBottom(scroller);
    };
    const updateFromUserScroll = () => {
      clearProgrammaticScroll();
      window.requestAnimationFrame(updateStickiness);
    };
    updateStickiness();
    scroller.addEventListener("scroll", updateStickiness, { passive: true });
    scroller.addEventListener("wheel", updateFromUserScroll, {
      passive: true,
    });
    scroller.addEventListener("touchmove", updateFromUserScroll, {
      passive: true,
    });
    return () => {
      scroller.removeEventListener("scroll", updateStickiness);
      scroller.removeEventListener("wheel", updateFromUserScroll);
      scroller.removeEventListener("touchmove", updateFromUserScroll);
      clearProgrammaticScroll();
    };
  }, [heroMode, selectedHermesSessionId, selectedTaskId]);

  useEffect(() => {
    // The conversation scrolls in .agent-scroll, which sits below the sticky
    // breadcrumb so the scrollbar can't ride up over the bar — drive that
    // scroller to the bottom as turns arrive.
    const scroller = listRef.current?.closest(".agent-scroll");
    if (!(scroller instanceof HTMLElement)) return;
    const selectionKey = `${selectedHermesSessionId ?? ""}:${selectedTaskId ?? ""}`;
    const settled = settledScrollSelectionRef.current === selectionKey;
    if (!settled) {
      transcriptShouldStickToBottomRef.current = true;
    }
    if (selectedHistoryLoaded || renderedTurnsSignature > 0) {
      // The settling run itself still scrolls with the pre-write snapshot, so
      // the history fill after a switch lands instantly; everything after it
      // (including the first streamed turn of an empty conversation) glides.
      settledScrollSelectionRef.current = selectionKey;
    } else if (!settled) {
      // Mid-load switch: forget the previous conversation so flipping back
      // before this one settles re-lands instantly instead of gliding.
      settledScrollSelectionRef.current = undefined;
    }
    if (settled && !transcriptShouldStickToBottomRef.current) return;
    if (typeof scroller.scrollTo !== "function") return; // jsdom has no scrollTo
    if (settled) {
      transcriptLastScrollTopRef.current = scroller.scrollTop;
      transcriptProgrammaticScrollRef.current = true;
      if (transcriptProgrammaticScrollTimeoutRef.current !== undefined) {
        window.clearTimeout(transcriptProgrammaticScrollTimeoutRef.current);
      }
      transcriptProgrammaticScrollTimeoutRef.current = window.setTimeout(() => {
        transcriptProgrammaticScrollRef.current = false;
        transcriptShouldStickToBottomRef.current = isAgentTranscriptNearBottom(scroller);
        transcriptProgrammaticScrollTimeoutRef.current = undefined;
      }, 800);
    } else {
      transcriptProgrammaticScrollRef.current = false;
    }
    scroller.scrollTo({
      top: scroller.scrollHeight,
      behavior: settled ? "smooth" : "auto",
    });
    transcriptShouldStickToBottomRef.current = true;
  }, [
    composerClearance,
    renderedTurnsSignature,
    selectedHermesSessionId,
    selectedHistoryLoaded,
    selectedTaskId,
  ]);

  // Jump back to the live edge from the floating pill. Glide the same way the
  // auto-scroll effect does — arm the programmatic-scroll ref + timeout so the
  // scroll handler reads the glide as ours, not a user scroll that would
  // release follow mode.
  const scrollTranscriptToLatest = useCallback(() => {
    const scroller = agentScrollRef.current;
    if (!scroller) return;
    if (typeof scroller.scrollTo !== "function") return; // jsdom has no scrollTo
    transcriptShouldStickToBottomRef.current = true;
    transcriptLastScrollTopRef.current = scroller.scrollTop;
    transcriptProgrammaticScrollRef.current = true;
    if (transcriptProgrammaticScrollTimeoutRef.current !== undefined) {
      window.clearTimeout(transcriptProgrammaticScrollTimeoutRef.current);
    }
    transcriptProgrammaticScrollTimeoutRef.current = window.setTimeout(() => {
      transcriptProgrammaticScrollRef.current = false;
      transcriptShouldStickToBottomRef.current = isAgentTranscriptNearBottom(scroller);
      transcriptProgrammaticScrollTimeoutRef.current = undefined;
    }, 800);
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scroller.scrollTo({
      top: scroller.scrollHeight,
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, []);

  return {
    pinTranscriptAfterVisibleReveal,
    selectedHistoryLoaded,
    startupSessionHydrationPending,
    scrollTranscriptToLatest,
  };
}
