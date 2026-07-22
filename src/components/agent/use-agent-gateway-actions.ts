import { useCallback } from "react";
import { HermesGatewayClient } from "../../lib/hermes-gateway";
import { createHermesMethods } from "../../lib/hermes-control-plane";
import { parseSessionUsage, type SessionUsage } from "../../lib/hermes-session-usage";
import {
  parseCompressSessionResult,
  type CompressSessionResult,
} from "../../lib/hermes-session-compress";
import { messageFromError } from "../../lib/errors";
import { hermesConnectionForMode } from "../../lib/hermes-connection";
import { sessionUnrestricted } from "../../lib/agent-session-modes";
import { COMPACTED_CONTEXT_SIGNATURE } from "../../lib/agent-project-context";
import { isSessionGoneError } from "./agent-workspace-errors";
import { type HermesRuntimeSessionResponse } from "./agent-session-continuity";
import type { UseAgentGatewayActionsDependencies } from "./use-agent-gateway-actions-types";

export function useAgentGatewayActions(dependencies: UseAgentGatewayActionsDependencies) {
  const {
    bridge,
    gatewayCloseHandlerRef,
    gatewaysRef,
    projectContextSignaturesBySessionId,
    runtimeSessionIdsRef,
    setRuntimeSessionIds,
    startBridge,
  } = dependencies;

  async function ensureHermesGateway(fullMode = false) {
    let connection = hermesConnectionForMode(bridge.running ? bridge : undefined, fullMode);
    if (!connection) {
      const next = await startBridge(fullMode);
      connection = hermesConnectionForMode(next, fullMode);
    }
    const wsUrl = connection?.wsUrl;
    if (!wsUrl) throw new Error("Hermes bridge did not return a gateway URL.");
    let gateway = gatewaysRef.current.get(fullMode);
    if (!gateway) {
      gateway = new HermesGatewayClient();
      gatewaysRef.current.set(fullMode, gateway);
      // Fires only on unexpected drops — the unmount close() detaches the
      // socket first, and a superseded socket never notifies.
      gateway.onClose(() => gatewayCloseHandlerRef.current(fullMode));
    }
    await gateway.connect(wsUrl);
    return gateway;
  }

  // Fetches normalized usage/cost for one session (feature 09). Routes through
  // the gateway matching the session's recorded write-access mode, calls the
  // typed session.usage wrapper, and parses the raw result defensively. The
  // panel injects this so it stays decoupled from the gateway and reusable by
  // feature 11's activity drawer.
  const fetchSessionUsage = useCallback(
    async (storedSessionId: string): Promise<SessionUsage> => {
      const gateway = await ensureHermesGateway(sessionUnrestricted(storedSessionId));
      const methods = createHermesMethods(gateway);
      const usageFor = async (runtimeId: string) =>
        parseSessionUsage(storedSessionId, await methods.getSessionUsage({ sessionId: runtimeId }));
      // session.usage reads the LIVE runtime, keyed by the runtime id — not the
      // stored id the panel passes. Use the cached runtime if it is still alive;
      // if it has been torn down between turns ("session not found"), resume the
      // session to spin up a fresh runtime and retry once. Mirrors the send
      // flow's cached-or-resume resolution (see submit()).
      const cached = runtimeSessionIdsRef.current[storedSessionId];
      if (cached) {
        try {
          return await usageFor(cached);
        } catch (err) {
          if (!isSessionGoneError(messageFromError(err))) throw err;
        }
      }
      const resumed = await gateway.request<HermesRuntimeSessionResponse>("session.resume", {
        session_id: storedSessionId,
        cols: 96,
      });
      const runtimeSessionId = resumed.session_id;
      if (!runtimeSessionId) {
        throw new Error("Hermes did not resume the session.");
      }
      setRuntimeSessionIds((current) => ({
        ...current,
        [storedSessionId]: runtimeSessionId,
      }));
      return usageFor(runtimeSessionId);
    },
    // Stable closure over refs and imported helpers; deps intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Compacts one session's context (feature 08). Routes through the gateway
  // matching the session's recorded write-access mode, calls the typed
  // session.compress wrapper, and parses the raw result defensively so the
  // dialog can show token savings when reported. The dialog injects this so it
  // stays decoupled from the gateway, mirroring fetchSessionUsage.
  const compressSessionContext = useCallback(
    async (sessionId: string): Promise<CompressSessionResult> => {
      const gateway = await ensureHermesGateway(sessionUnrestricted(sessionId));
      const raw = await createHermesMethods(gateway).compressSession({
        sessionId,
      });
      const result = parseCompressSessionResult(sessionId, raw);
      // Compaction replaces the working context with a summary that may still
      // contain the old project block. Mark the session compacted rather than
      // deleting the entry: the sentinel differs from every real project
      // signature (so a still-filed session reinjects on its next prompt) yet
      // is not "no block ever" (so if the user then removes the session from
      // its project, prepareProjectPrompt still emits the clearing block
      // instead of silently leaving stale instructions in the summary).
      projectContextSignaturesBySessionId.set(sessionId, COMPACTED_CONTEXT_SIGNATURE);
      return result;
    },
    // Same stable-closure rationale as fetchSessionUsage above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return {
    ensureHermesGateway,
    fetchSessionUsage,
    compressSessionContext,
  };
}
