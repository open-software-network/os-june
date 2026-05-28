import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { useState } from "react";

export type FailureKind = "balance_low" | "generic";

type Props = {
  errorMessage?: string;
  audioPreserved: boolean;
  onRetry: () => void | Promise<void>;
  onTopUp: () => void;
};

// String match is intentional and a known weakness — the backend currently
// persists only the error message on the note, not the structured code (see
// commands.rs::finish_recording where set_note_status is called with
// Some(error.message)). When we start storing the code we can switch to a
// strict equality check on the backend billing error code.
export function classifyFailure(message?: string): FailureKind {
  if (!message) return "generic";
  return /out of credits|insufficient credits|insufficient_credits|balance is too low/i.test(
    message,
  )
    ? "balance_low"
    : "generic";
}

export function NoteFailureBanner({
  errorMessage,
  audioPreserved,
  onRetry,
  onTopUp,
}: Props) {
  const kind = classifyFailure(errorMessage);
  const isBalanceIssue = kind === "balance_low";
  // Local busy flag so a fast double-click can't fire onRetry twice. The
  // banner unmounts when the note transitions out of `failed` status, so we
  // don't need to reset this state ourselves; the catch covers the case
  // where onRetry rejects and the note stays in `failed`.
  const [retrying, setRetrying] = useState(false);

  async function handleRetry() {
    if (retrying) return;
    setRetrying(true);
    try {
      await onRetry();
    } catch {
      // Parent already surfaces errors; release the gate so the user can try
      // again rather than getting stuck in a frozen spinner.
      setRetrying(false);
    }
  }

  return (
    <aside className="note-failure-banner" role="alert" data-kind={kind}>
      <div className="note-failure-copy">
        <h3 className="note-failure-title">
          {isBalanceIssue
            ? "Add funds to finish this note"
            : "Transcription failed"}
        </h3>
        <p className="note-failure-message">
          {isBalanceIssue
            ? audioPreserved
              ? "Your recording is saved locally. Add funds and retry to transcribe."
              : "Your balance is too low. Add funds to continue."
            : (errorMessage ?? "Scribe couldn't finish processing this note.")}
          {!isBalanceIssue && audioPreserved
            ? " Your recording is saved locally — you can retry."
            : null}
        </p>
      </div>
      <div className="note-failure-actions">
        {isBalanceIssue ? (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onTopUp}
            disabled={retrying}
          >
            Add funds
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void handleRetry()}
          disabled={!audioPreserved || retrying}
          aria-busy={retrying || undefined}
        >
          <IconArrowRotateClockwise
            size={14}
            data-spinning={retrying ? "true" : undefined}
          />
          {retrying ? "Retrying…" : "Retry transcription"}
        </button>
      </div>
    </aside>
  );
}
