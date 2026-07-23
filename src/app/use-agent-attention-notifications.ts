import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import {
  AGENT_RUN_SETTLED_EVENT,
  AGENT_SESSION_STATUS_EVENT,
  type AgentRunSettledDetail,
  type AgentSessionStatusDetail,
} from "../lib/agent-events";
import {
  notifyAgentRunSettled,
  notifyAgentSessionStatus,
  type AgentAttentionContext,
} from "../lib/agent-notifications";
import { getAgentSoundsEnabled } from "../lib/agent-sound-settings";
import type { UseAgentAttentionNotificationsDependencies } from "./use-agent-attention-notifications-types";

export function useAgentAttentionNotifications(
  dependencies: UseAgentAttentionNotificationsDependencies,
) {
  const {
    activeAgentSessionIdRef,
    activeViewRef,
    agentHudEnabledRef,
    dictationWorkflowActiveRef,
    noteChatOpenRef,
    noteChatSessionIdRef,
    recordingStatusRef,
  } = dependencies;

  useEffect(() => {
    async function attentionContextFor(sessionId?: string): Promise<AgentAttentionContext> {
      let windowFocused = document.hasFocus();
      try {
        const appWindow = getCurrentWindow();
        if (typeof appWindow.isFocused === "function") {
          windowFocused = await appWindow.isFocused();
        }
      } catch {
        // Browser previews do not expose a Tauri window; document focus is enough.
      }
      const away = document.visibilityState !== "visible" || !windowFocused;
      const recordingState = recordingStatusRef.current?.state;
      const recordingCaptureActive =
        recordingState === "recording" ||
        recordingState === "paused" ||
        recordingState === "finalizing" ||
        recordingState === "validating";
      return {
        away,
        agentHudEnabled: agentHudEnabledRef.current,
        viewingSession:
          !away &&
          ((activeViewRef.current === "agent" &&
            (!sessionId || sessionId === activeAgentSessionIdRef.current)) ||
            (activeViewRef.current === "meetings" &&
              noteChatOpenRef.current &&
              !!sessionId &&
              sessionId === noteChatSessionIdRef.current)),
        captureActive: recordingCaptureActive || dictationWorkflowActiveRef.current,
        soundsEnabled: getAgentSoundsEnabled(),
      };
    }

    const handleAgentStatus = (event: Event) => {
      const detail = (event as CustomEvent<AgentSessionStatusDetail>).detail;
      if (!detail || (detail.status !== "waitingForUser" && detail.status !== "failed")) return;
      void attentionContextFor(detail.sessionId).then((context) =>
        notifyAgentSessionStatus(detail, context),
      );
    };
    const handleAgentRunSettled = (event: Event) => {
      const detail = (event as CustomEvent<AgentRunSettledDetail>).detail;
      if (!detail) return;
      void attentionContextFor(detail.sessionId).then((context) =>
        notifyAgentRunSettled(detail, context),
      );
    };
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, handleAgentStatus);
    window.addEventListener(AGENT_RUN_SETTLED_EVENT, handleAgentRunSettled);
    return () => {
      window.removeEventListener(AGENT_SESSION_STATUS_EVENT, handleAgentStatus);
      window.removeEventListener(AGENT_RUN_SETTLED_EVENT, handleAgentRunSettled);
    };
  }, []);
}
