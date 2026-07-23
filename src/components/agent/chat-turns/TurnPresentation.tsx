import type { AgentChatPart, AgentChatTurn } from "../../../lib/agent-chat-runtime";

export const TURN_ACTION_TIP_DELAY_MS = 450;

export function turnIsConcreteResponse(turn: AgentChatTurn): boolean {
  return turn.parts.some((part) =>
    part.type === "text" ? Boolean(part.text.trim()) : part.type !== "reasoning",
  );
}

export function SudoPart({
  part,
}: {
  part: Extract<AgentChatPart, { type: "sudo" }>;
  [key: string]: unknown;
}) {
  return <div className="agent-system-notice">{part.reason || "Approval required"}</div>;
}

export function SecretPart({
  part,
}: {
  part: Extract<AgentChatPart, { type: "secret" }>;
  [key: string]: unknown;
}) {
  return <div className="agent-system-notice">{part.reason || "A secret is required"}</div>;
}
