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
  kind = "upstream-provider",
}: {
  onRetry?: () => void;
  kind?: "upstream-provider" | "tool" | "runtime";
  [key: string]: unknown;
}) {
  const message =
    kind === "tool"
      ? "A tool Clovy used could not finish this request."
      : kind === "runtime"
        ? "Clovy stopped unexpectedly."
        : "The model service could not finish this request.";
  return (
    <div className="agent-system-notice">
      {message}
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
