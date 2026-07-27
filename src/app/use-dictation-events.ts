import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import {
  markAgentNewSessionPending,
  type AgentNewSessionDetail,
} from "../components/agent/session-persistence";
import { recordDictationFinished } from "../lib/referral-nudge";
import { AGENT_NEW_SESSION_EVENT, dispatchAgentSessionStatus } from "../lib/agent-events";
import { nextDictationWorkflowActive, parseDictationHelperEvent } from "../lib/dictation-events";
import { titleFromPrompt } from "../lib/session-title";
import { stringPayloadValue } from "./app-helpers";
import type { UseDictationEventsDependencies } from "./use-dictation-events-types";

export function useDictationEvents(dependencies: UseDictationEventsDependencies) {
  const { dictationWorkflowActiveRef, setAccessibilityStatus, setActiveView, setMicrophoneStatus } =
    dependencies;

  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | undefined;
    void listen<string>("dictation-event", (event) => {
      const helperEvent = parseDictationHelperEvent(event.payload);
      if (!helperEvent) return;
      dictationWorkflowActiveRef.current = nextDictationWorkflowActive(
        dictationWorkflowActiveRef.current,
        helperEvent.type,
      );
      if (helperEvent.type === "final_transcript") {
        // T3 of the referral delight nudge: a dictation landed (often while
        // June is backgrounded; the card waits to be found).
        recordDictationFinished();
        return;
      }
      if (helperEvent.type === "agent_session_prompt") {
        const prompt = stringPayloadValue(helperEvent.payload?.prompt) ?? "";
        dispatchAgentSessionStatus({
          prompt,
          title: titleFromPrompt(prompt),
          status: "received",
          summary: "June is starting.",
        });
        markAgentNewSessionPending(prompt);
        setActiveView("agent");
        window.setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent<AgentNewSessionDetail>(AGENT_NEW_SESSION_EVENT, {
              detail: { prompt },
            }),
          );
        }, 0);
        return;
      }
      if (
        helperEvent.type !== "permission_status" &&
        helperEvent.type !== "dictation_diagnostics"
      ) {
        return;
      }
      const microphone = stringPayloadValue(helperEvent.payload?.microphone);
      const accessibility = stringPayloadValue(helperEvent.payload?.accessibility);
      if (microphone) setMicrophoneStatus(microphone);
      if (accessibility) setAccessibilityStatus(accessibility);
    }).then((cleanup) => {
      if (aborted) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      aborted = true;
      unlisten?.();
    };
  }, []);
}
