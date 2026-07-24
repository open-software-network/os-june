import {
  markAgentNewSessionPending,
  type AgentNewSessionDetail,
} from "../components/agent/session-persistence";
import { AGENT_NEW_SESSION_EVENT } from "../lib/agent-events";
import type { ReportCategory } from "../components/agent/composer/reportCategory";
import {
  assignNoteToFolder,
  assignSessionToFolder,
  deleteFolder,
  removeNoteFromFolder,
  removeSessionFromFolder,
  setSessionCompleted,
} from "../lib/tauri";
import { messageFromError } from "../lib/errors";
import { getCurrentDataPartitionName } from "../lib/data-partition";
import type { CreateAppDomainActionsDependencies } from "./app-domain-actions-types";

export function createAppDomainActions(dependencies: CreateAppDomainActionsDependencies) {
  const {
    agentSessions,
    completedSessions,
    dispatch,
    noteSaveController,
    pendingSessionProjectRef,
    sessionCompletionTouchedRef,
    sessionCompletionWritesRef,
    sessionFolders,
    setActiveAgentSession,
    setActiveView,
    setAgentOrigin,
    setCompletedSessions,
    setError,
    setSessionFolders,
    state,
  } = dependencies;

  async function handleDeleteFolder(folderId: string) {
    try {
      // Deleting a project strips its association from any notes and agent
      // sessions but never deletes them — they stay in your library.
      await deleteFolder(folderId, false);
      dispatch({ type: "folderDeleted", folderId });
      setSessionFolders((prev) => {
        const next: Record<string, string[]> = {};
        for (const [sessionId, folderIds] of Object.entries(prev)) {
          const remaining = folderIds.filter((id) => id !== folderId);
          if (remaining.length > 0) next[sessionId] = remaining;
        }
        return next;
      });
    } catch (err) {
      setError(messageFromError(err));
      throw err;
    }
  }

  async function handleRemoveNoteFromFolder(
    noteId: string,
    folderId: string,
    options?: { rethrow?: boolean },
  ) {
    try {
      await noteSaveController.flush(noteId);
      const note = await removeNoteFromFolder(noteId, folderId);
      dispatch({ type: "noteUpdated", note });
    } catch (err) {
      setError(messageFromError(err));
      if (options?.rethrow) throw err;
    }
  }

  // Single-folder semantics: a note belongs to at most one folder. Strip any
  // existing folder assignments before adding the target. Legacy notes with
  // multiple folders get normalized on the next move.
  async function handleSetNoteFolder(
    noteId: string,
    folderId: string,
    options?: { rethrow?: boolean },
  ) {
    const note = state.notes.find((n) => n.id === noteId);
    if (!note) return;
    if (note.folderIds.length === 1 && note.folderIds[0] === folderId) return;
    try {
      await noteSaveController.flush(noteId);
      for (const existing of note.folderIds) {
        if (existing === folderId) continue;
        const updated = await removeNoteFromFolder(noteId, existing);
        dispatch({ type: "noteUpdated", note: updated });
      }
      if (!note.folderIds.includes(folderId)) {
        const updated = await assignNoteToFolder(noteId, folderId);
        dispatch({ type: "noteUpdated", note: updated });
      }
    } catch (err) {
      setError(messageFromError(err));
      if (options?.rethrow) throw err;
    }
  }

  // Single-project semantics for agent sessions, mirroring notes: a session
  // belongs to at most one project, so any existing assignment is stripped
  // before adding the target.
  async function handleSetSessionFolder(
    sessionId: string,
    folderId: string,
    options?: { rethrow?: boolean },
  ) {
    const current = sessionFolders[sessionId] ?? [];
    if (current.length === 1 && current[0] === folderId) return;
    try {
      for (const existing of current) {
        if (existing === folderId) continue;
        await removeSessionFromFolder(sessionId, existing);
      }
      if (!current.includes(folderId)) {
        await assignSessionToFolder(sessionId, folderId);
      }
      setSessionFolders((prev) => ({ ...prev, [sessionId]: [folderId] }));
    } catch (err) {
      setError(messageFromError(err));
      if (options?.rethrow) throw err;
    }
  }

  async function handleToggleSessionCompleted(sessionId: string, completed: boolean) {
    // A local toggle outranks the initial load's pre-toggle snapshot for this id.
    sessionCompletionTouchedRef.current.add(sessionId);
    // The exact prior value for this one session, so a failed write can be rolled
    // back precisely (restoring the original completed_at on a failed unmark)
    // without touching any other session's optimistic state.
    const priorValue = completedSessions[sessionId];
    setCompletedSessions((prev) => {
      const next = { ...prev };
      if (completed) next[sessionId] = new Date().toISOString();
      else delete next[sessionId];
      return next;
    });
    // Serialize writes per session. Toggling complete -> active faster than the
    // first write resolves would otherwise let two commands reach the SQLite
    // pool concurrently and land out of order (the DELETE before the INSERT),
    // leaving the row completed while the UI shows active. Chaining keeps the
    // persisted state matching the last user action (JUN-203 review).
    const pending = sessionCompletionWritesRef.current;
    const write = (pending.get(sessionId) ?? Promise.resolve())
      .catch(() => {})
      .then(() => setSessionCompleted(sessionId, completed));
    const chained = write.catch(() => {});
    pending.set(sessionId, chained);
    try {
      await write;
    } catch (err: unknown) {
      // Roll back only this session to its captured prior value, and only if no
      // newer toggle for it has queued behind us (that newer write now owns the
      // session). Reverting just this id leaves every other session's optimistic
      // and in-flight state intact, and surfacing the error keeps a failed
      // context-menu action from looking like it silently did nothing.
      if (pending.get(sessionId) === chained) {
        // Un-track only when the rollback leaves the session with no local
        // completion: then a still-in-flight boot snapshot restoring its true
        // state is exactly what we want. If the rollback restores an earlier
        // successful completion, keep it tracked — a pre-toggle snapshot that
        // predates that completion would otherwise wipe the row from the UI
        // while SQLite still has it completed.
        if (priorValue === undefined) sessionCompletionTouchedRef.current.delete(sessionId);
        setCompletedSessions((prev) => {
          const next = { ...prev };
          if (priorValue === undefined) delete next[sessionId];
          else next[sessionId] = priorValue;
          return next;
        });
      }
      setError(messageFromError(err));
    } finally {
      // Drop the chain only when no newer toggle queued behind this one.
      if (pending.get(sessionId) === chained) pending.delete(sessionId);
    }
  }

  async function handleRemoveSessionFromFolder(
    sessionId: string,
    folderId: string,
    options?: { rethrow?: boolean },
  ) {
    try {
      await removeSessionFromFolder(sessionId, folderId);
      setSessionFolders((prev) => {
        const next = { ...prev };
        const remaining = (next[sessionId] ?? []).filter((id) => id !== folderId);
        if (remaining.length > 0) next[sessionId] = remaining;
        else delete next[sessionId];
        return next;
      });
    } catch (err) {
      setError(messageFromError(err));
      if (options?.rethrow) throw err;
    }
  }

  // "Report an issue": navigate to Agent and open the direct report dialog.
  // It submits through June API without a model turn, so there is nothing to
  // charge; June API creates the team-facing diagnosis.
  function handleReportIssue(category: ReportCategory = "bug") {
    pendingSessionProjectRef.current = null;
    setAgentOrigin(undefined);
    markAgentNewSessionPending(undefined, { category });
    setActiveAgentSession(undefined);
    setActiveView("agent");
    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent<AgentNewSessionDetail>(AGENT_NEW_SESSION_EVENT, {
          detail: { category },
        }),
      );
    }, 0);
  }

  // Escalates a note chat into the full agent view. An existing stored session
  // opens in place, while a chat that never started falls back to the seeded
  // new-session flow.
  function handleOpenNoteChatInAgent(noteRef: { id: string; title: string }, sessionId?: string) {
    if (!sessionId) {
      handleAskJuneAboutNote(noteRef);
      return;
    }
    pendingSessionProjectRef.current = null;
    setAgentOrigin(undefined);
    setActiveAgentSession(agentSessions.find((session) => session.id === sessionId));
    setActiveView("agent");
  }

  function handleAskJuneAboutNote(noteRef: { id: string; title: string }) {
    pendingSessionProjectRef.current = null;
    setAgentOrigin(undefined);
    markAgentNewSessionPending(undefined, { noteRef });
    setActiveAgentSession(undefined);
    setActiveView("agent");
    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent<AgentNewSessionDetail>(AGENT_NEW_SESSION_EVENT, {
          detail: { noteRef },
        }),
      );
    }, 0);
  }

  // "Start chat with this bundle" from the Bundles settings tab: the same
  // fresh-chat handshake the dictation prompt path uses, auto-submitting the
  // bundle's slash command so June loads its skills.
  function handleStartBundleChat(prompt: string) {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    pendingSessionProjectRef.current = null;
    setAgentOrigin(undefined);
    markAgentNewSessionPending(trimmed);
    setActiveAgentSession(undefined);
    setActiveView("agent");
    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent<AgentNewSessionDetail>(AGENT_NEW_SESSION_EVENT, {
          detail: { prompt: trimmed },
        }),
      );
    }, 0);
  }

  // "New session" from inside a project uses the same fresh-chat handshake.
  // The session is filed into the project once June persists its id.
  function handleNewAgentSessionInProject(folderId: string) {
    pendingSessionProjectRef.current = {
      folderId,
      knownSessionIds: new Set(agentSessions.map((session) => session.id)),
      partition: getCurrentDataPartitionName(),
    };
    setAgentOrigin({ kind: "project", folderId });
    markAgentNewSessionPending();
    setActiveAgentSession(undefined);
    setActiveView("agent");
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent<AgentNewSessionDetail>(AGENT_NEW_SESSION_EVENT));
    }, 0);
  }

  return {
    handleDeleteFolder,
    handleRemoveNoteFromFolder,
    handleSetNoteFolder,
    handleSetSessionFolder,
    handleToggleSessionCompleted,
    handleRemoveSessionFromFolder,
    handleReportIssue,
    handleOpenNoteChatInAgent,
    handleAskJuneAboutNote,
    handleStartBundleChat,
    handleNewAgentSessionInProject,
  };
}
