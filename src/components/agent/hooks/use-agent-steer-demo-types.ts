import { type AgentChatTurn } from "../../../lib/agent-chat-runtime";
import { type QueuedAttachmentFollowUp } from "../composer/follow-up-queue";
import type * as React from "react";

export type useAgentSteerDemoDependencies = {
  imageTurnsBySession: Record<string, AgentChatTurn[]>;
  selectedHermesSessionId: string | undefined;
  selectedHermesSessionIsProvisional: boolean;
  setImageTurnsBySession: React.Dispatch<React.SetStateAction<Record<string, AgentChatTurn[]>>>;
  setSteerCardsBySessionId: React.Dispatch<
    React.SetStateAction<Record<string, { id: string; text: string }[]>>
  >;
  setUpNextDemoFollowUpsBySessionId: React.Dispatch<
    React.SetStateAction<Record<string, QueuedAttachmentFollowUp[]>>
  >;
  steerCardSeqRef: React.MutableRefObject<number>;
};
