import { useEffect } from "react";
import type { JuneHermesEvent } from "./hermes-control-plane";
import {
  finishStreamedVoiceTurn,
  initVoicePlayback,
  queueStreamedVoiceChunk,
  rekeyStreamedVoiceTurn,
  stopVoicePlayback,
  streamingVoicePlaybackEnabled,
} from "./voice-playback";
import { StreamingVoiceText } from "./voice-playback-text";

const FAILURE_LIFECYCLE_STATUS = /fail|error|cancel|timeout|abort|interrupt/i;

type StreamTracker = {
  sessionKey: string;
  turnId: string;
  text: string;
  splitter: StreamingVoiceText;
};

let activeSessionKey: string | undefined;
let activeStream: StreamTracker | undefined;

export function resetAgentVoicePlaybackStream() {
  activeStream = undefined;
}

export function useAgentVoicePlayback(sessionKey: string | undefined) {
  useEffect(() => {
    void initVoicePlayback();
  }, []);

  useEffect(() => {
    activeSessionKey = sessionKey;
    activeStream = undefined;
    return () => {
      if (activeSessionKey === sessionKey) activeSessionKey = undefined;
      resetAgentVoicePlaybackStream();
      void stopVoicePlayback();
    };
  }, [sessionKey]);
}

/** Consume events before the UI's bounded event list can discard older deltas.
 * Transcript events drive speech; terminal lifecycle and error events close it. */
export function acceptAgentVoicePlaybackEvent(sessionKey: string, event: JuneHermesEvent) {
  if (sessionKey !== activeSessionKey) return;

  if (event.kind === "error") {
    stopFailedVoiceStream(sessionKey);
    return;
  }

  if (event.kind === "lifecycle") {
    if (event.flavor !== "terminal") return;
    if (FAILURE_LIFECYCLE_STATUS.test(event.status)) {
      stopFailedVoiceStream(sessionKey);
    } else {
      finishActiveVoiceStream(sessionKey);
    }
    return;
  }

  if (event.kind !== "transcript") return;
  if (event.role === "user" || event.role === "system") return;

  const tracker = activeStream;
  if (tracker?.sessionKey === sessionKey && event.messageId && event.messageId !== tracker.turnId) {
    const previousId = tracker.turnId;
    tracker.turnId = event.messageId;
    void rekeyStreamedVoiceTurn(previousId, tracker.turnId);
  }

  if (event.complete && event.failed) {
    stopFailedVoiceStream(sessionKey);
    return;
  }

  if (event.complete) {
    finishActiveVoiceStream(sessionKey, event.delta);
    return;
  }

  if (!streamingVoicePlaybackEnabled()) return;

  if (!activeStream) {
    activeStream = {
      sessionKey,
      turnId: event.messageId ?? `voice-stream:${sessionKey}`,
      text: "",
      splitter: new StreamingVoiceText(),
    };
  }

  const currentTracker = activeStream;
  if (currentTracker.sessionKey !== sessionKey) return;

  if (!event.delta) return;
  currentTracker.text += event.delta;
  for (const chunk of currentTracker.splitter.push(currentTracker.text)) {
    void queueStreamedVoiceChunk(currentTracker.turnId, chunk);
  }
}

function finishActiveVoiceStream(sessionKey: string, completeText?: string) {
  const tracker = activeStream;
  if (!tracker || tracker.sessionKey !== sessionKey) return;
  activeStream = undefined;
  for (const chunk of tracker.splitter.flush(completeText ?? tracker.text)) {
    void queueStreamedVoiceChunk(tracker.turnId, chunk);
  }
  void finishStreamedVoiceTurn(tracker.turnId);
}

function stopFailedVoiceStream(sessionKey: string) {
  if (activeSessionKey !== sessionKey) return;
  if (activeStream?.sessionKey === sessionKey) activeStream = undefined;
  void stopVoicePlayback().catch(() => undefined);
}
