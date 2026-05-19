import type { RecoverableRecordingDto } from "../../lib/tauri";

type RecoveryBannerProps = {
  recoveries: RecoverableRecordingDto[];
  onValidate: (sessionId: string) => void;
  onDiscard: (sessionId: string) => void;
};

export function RecoveryBanner({
  recoveries,
  onValidate,
  onDiscard,
}: RecoveryBannerProps) {
  if (recoveries.length === 0) return null;
  const recovery = recoveries[0];

  return (
    <section className="recovery-banner">
      <div>
        <strong>Recoverable recording found</strong>
        <p>
          {recovery.bytesFound} bytes are available from an interrupted
          recording.
        </p>
      </div>
      <div className="recovery-actions">
        <button type="button" onClick={() => onValidate(recovery.sessionId)}>
          Validate
        </button>
        <button type="button" onClick={() => onDiscard(recovery.sessionId)}>
          Discard
        </button>
      </div>
    </section>
  );
}
