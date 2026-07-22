import type { AgentSessionContinuity } from "./agent-session-continuity";

export type UseAgentRuntimeStateDependencies = {
  continuity: AgentSessionContinuity | null;
  selectedHermesSessionId: string | undefined;
};
