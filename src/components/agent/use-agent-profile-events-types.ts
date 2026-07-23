import { type AgentNewSessionDetail } from "./session-persistence";
import type * as React from "react";

export type useAgentProfileEventsDependencies = {
  windowEventHandlersRef: React.MutableRefObject<{
    applyManualHermesSessionTitleLocally: (sessionId: string, title: string) => string | null;
    startNewTask: (
      request?: AgentNewSessionDetail,
      options?: { deferSeed?: boolean },
    ) => Promise<void>;
    removeHermesSessionLocally: (sessionId: string, selectNext?: boolean) => void;
  }>;
};
