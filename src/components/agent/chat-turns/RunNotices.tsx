import type { AgentChatPart } from "../../../lib/agent-chat-runtime";

export function ContextOverflowNoticePart() {
  return (
    <div className="agent-system-notice">
      This conversation is too large for the selected model.
    </div>
  );
}

export function CreditsNoticePart({ onTopUp }: { onTopUp?: () => void; [key: string]: unknown }) {
  return (
    <div className="agent-system-notice">
      You need more credits to continue.
      {onTopUp ? (
        <button type="button" onClick={onTopUp}>
          Add credits
        </button>
      ) : null}
    </div>
  );
}

export function UpstreamProviderFailureNoticePart({
  onRetry,
}: {
  onRetry?: () => void;
  [key: string]: unknown;
}) {
  return (
    <div className="agent-system-notice">
      The model provider could not complete this request.
      {onRetry ? (
        <button type="button" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function SteeringPart({ part }: { part: Extract<AgentChatPart, { type: "steering" }> }) {
  return <div className="agent-system-notice">{part.text}</div>;
}
