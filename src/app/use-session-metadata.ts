import { useEffect } from "react";
import { listCompletedSessions, listSessionFolders } from "../lib/tauri";
import { messageFromError } from "../lib/errors";
import type { UseSessionMetadataDependencies } from "./use-session-metadata-types";

export function useSessionMetadata(dependencies: UseSessionMetadataDependencies) {
  const {
    appBlocked,
    bootstrapped,
    sessionCompletionTouchedRef,
    setCompletedSessions,
    setError,
    setSessionFolders,
  } = dependencies;

  useEffect(() => {
    if (appBlocked || !bootstrapped) return;
    let cancelled = false;
    void listSessionFolders()
      .then((assignments) => {
        if (cancelled) return;
        const next: Record<string, string[]> = {};
        for (const assignment of assignments) {
          next[assignment.sessionId] ??= [];
          next[assignment.sessionId].push(assignment.folderId);
        }
        setSessionFolders(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(messageFromError(err));
      });
    void listCompletedSessions()
      .then((rows) => {
        if (cancelled) return;
        // The session list can be interactive before this settles on a cold
        // launch. Merge rather than replace: this snapshot predates any toggle
        // the user already made, so locally toggled ids keep their local value
        // (applying the snapshot over them would show a completed session as
        // active while the database has it completed, until restart). Every
        // other row still applies, so the rest of the persisted completed
        // sessions are not lost (JUN-203 review).
        setCompletedSessions((prev) => {
          const next: Record<string, string> = {};
          for (const row of rows) next[row.sessionId] = row.completedAt;
          for (const touchedId of sessionCompletionTouchedRef.current) {
            const local = prev[touchedId];
            if (local === undefined) delete next[touchedId];
            else next[touchedId] = local;
          }
          return next;
        });
      })
      .catch((err: unknown) => {
        // Surface it like the sibling loads: a silent failure would present
        // previously completed sessions as active with no indication their
        // persisted state was unavailable (JUN-203 review).
        if (!cancelled) setError(messageFromError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [appBlocked, bootstrapped]);
}
