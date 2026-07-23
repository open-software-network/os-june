import { cancelAgentTask, computerUseStop, retryAgentTask } from "../../lib/tauri";
import { dispatchAgentSessionStatus } from "../../lib/agent-events";
import { createHermesMethods } from "../../lib/hermes-control-plane";
import { messageFromError } from "../../lib/errors";
import { sessionUnrestricted } from "../../lib/agent-session-modes";
import type { createTaskControlActionsDependencies } from "./task-control-actions-types";

export function createTaskControlActions(dependencies: createTaskControlActionsDependencies) {
  const {
    cancelAgentRunSettlement,
    clearSessionActivity,
    clearSubmittedSteers,
    computerUseRunLeasesRef,
    ensureHermesGateway,
    hermesSessionItems,
    refreshHermesSession,
    runtimeSessionIds,
    sessionGatewayUnlistenRef,
    setError,
    setStoppingSessionIds,
    stoppingSessionIds,
    upsertTask,
  } = dependencies;

  async function cancelTask(taskId: string) {
    try {
      upsertTask(await cancelAgentTask(taskId));
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  // Stops a running June turn: interrupts the runtime session over the
  // gateway, then records a terminal activity-store level regardless — the
  // user asked for it to stop, so the UI must not stay "thinking" even when
  // the RPC fails (gateway drop, runtime session already gone).
  async function stopHermesSession(sessionId: string) {
    if (stoppingSessionIds.has(sessionId)) return;
    // Revoke the native broker before waiting for the Hermes interrupt. This
    // cancels pending approvals, kills the helper, clears captures, and makes
    // Stop sticky until a later visible chat turn opens a fresh lease.
    const computerUseStopRequest = computerUseStop().catch(() => undefined);
    computerUseRunLeasesRef.current.clear();
    cancelAgentRunSettlement(sessionId);
    setStoppingSessionIds((current) => new Set(current).add(sessionId));

    // Stop the UI FIRST, synchronously, before the interrupt RPC. Stopping
    // must feel instant: the moment the user clicks, the session reads as
    // stopped (the Stop control gives way to Send) rather than staying
    // "working" until the gateway round-trip acks. Tearing down the
    // per-session listener here also means a straggler "running" event
    // arriving while the interrupt is in flight can't flip the session back
    // to working (and on a gateway drop no terminal event ever comes to do
    // it). The interrupt then fires below to actually halt the runtime agent.
    sessionGatewayUnlistenRef.current.get(sessionId)?.();
    // Interrupting tears the listener down before any cancelled terminal event
    // reaches the terminal handler, so clear the delivery-guarantee steers here
    // too -- otherwise a steer typed-then-stopped lingers and could auto-submit
    // as a follow-up after a later run in the same session.
    clearSubmittedSteers(sessionId);
    const activityCounts = clearSessionActivity(sessionId, "cancelled");
    dispatchAgentSessionStatus({
      sessionId,
      title:
        hermesSessionItems.find((session) => session.id === sessionId)?.title ?? "Agent session",
      status: "cancelled",
      summary: "Stopped.",
      ...activityCounts,
    });

    try {
      await computerUseStopRequest;
      const runtimeSessionId = runtimeSessionIds[sessionId];
      if (runtimeSessionId) {
        const gateway = await ensureHermesGateway(sessionUnrestricted(sessionId));
        await gateway.request("session.interrupt", {
          session_id: runtimeSessionId,
        });
      }
    } catch {
      // The UI already reflects stopped; a failed interrupt (gateway down)
      // must not leave the session reading as working.
    } finally {
      setStoppingSessionIds((current) => {
        const next = new Set(current);
        next.delete(sessionId);
        return next;
      });
      // Pull whatever the agent managed to persist before the interrupt so
      // the transcript reflects the partial turn.
      void refreshHermesSession(sessionId);
    }
  }

  // Feature 13: interrupt ONE background subagent from the activity drawer. The
  // drawer already vetted the target (active subagent, trustworthy id/handle,
  // confirmed when mid file/tool work) and owns the optimistic "stopping"
  // overlay, so this just routes the call to the gateway that owns the parent
  // session. `subagentId` is the trustworthy Hermes id/handle; the RPC's
  // session id is the runtime id (as the whole-session interrupt uses). The
  // promise is returned so the drawer can reconcile: a rejection (the subagent
  // already finished) drops the overlay and the row settles from the event
  // stream rather than showing a noisy failure.
  async function stopHermesSubagent({
    sessionId,
    subagentId,
  }: {
    sessionId: string;
    subagentId: string;
  }): Promise<unknown> {
    const runtimeSessionId = runtimeSessionIds[sessionId] ?? sessionId;
    const gateway = await ensureHermesGateway(sessionUnrestricted(sessionId));
    return createHermesMethods(gateway).interruptSubagent({
      sessionId: runtimeSessionId,
      subagentId,
    });
  }

  async function retryTask(taskId: string) {
    try {
      upsertTask(await retryAgentTask(taskId));
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  return {
    cancelTask,
    stopHermesSession,
    stopHermesSubagent,
    retryTask,
  };
}
