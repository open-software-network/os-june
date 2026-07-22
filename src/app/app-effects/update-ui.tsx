import { IconChevronRightSmall } from "central-icons/IconChevronRightSmall";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import type { AgentSessionStatusDetail } from "../../lib/agent-events";
import type { JuneUpdate } from "../../lib/updater";
import { JuneMark } from "../../components/account/AccountGate";
import { Spinner } from "../../components/ui/Spinner";
import type { UpdateInstallProgress, UpdatePromptPayload } from "../update-decision";

export function updateMenuBarSessionStatus(
  sessionId: string,
  status: AgentSessionStatusDetail["status"],
  sessions: { working: Set<string>; waiting: Set<string> },
) {
  if (status === "waitingForUser") {
    sessions.working.delete(sessionId);
    sessions.waiting.add(sessionId);
    return;
  }
  if (status === "starting" || status === "running") {
    sessions.waiting.delete(sessionId);
    sessions.working.add(sessionId);
    return;
  }
  if (status === "completed" || status === "failed" || status === "cancelled") {
    sessions.working.delete(sessionId);
    sessions.waiting.delete(sessionId);
  }
}

export function UpdateHub({
  readyUpdate,
  status,
  failed,
  statusLeaving,
  checking,
  preparing,
  relaunching,
  progress,
  onDismissStatus,
  onRelaunch,
}: {
  readyUpdate: UpdatePromptPayload<JuneUpdate> | null;
  status: string | null;
  failed: boolean;
  statusLeaving: boolean;
  checking: boolean;
  preparing: boolean;
  relaunching: boolean;
  progress: UpdateInstallProgress | null;
  onDismissStatus: () => void;
  onRelaunch: () => void;
}) {
  if (readyUpdate) {
    return (
      <UpdateRelaunchCard
        payload={readyUpdate}
        status={status}
        failed={failed}
        relaunching={relaunching}
        onRelaunch={onRelaunch}
      />
    );
  }

  if (!status) return null;
  return (
    <UpdateStatusCard
      status={status}
      failed={failed}
      leaving={statusLeaving}
      checking={checking}
      preparing={preparing}
      progress={progress}
      onDismiss={onDismissStatus}
    />
  );
}

function UpdateRelaunchCard({
  payload,
  status,
  failed,
  relaunching,
  onRelaunch,
}: {
  payload: UpdatePromptPayload<JuneUpdate>;
  status: string | null;
  failed: boolean;
  relaunching: boolean;
  onRelaunch: () => void;
}) {
  const meta = status ?? updateVersionLabel(payload.version);

  return (
    <aside className="update-popover" role={failed ? "alert" : "status"} aria-live="polite">
      <button
        type="button"
        className="update-relaunch-card"
        disabled={relaunching}
        aria-label={`Relaunch to update to June ${payload.version}`}
        onClick={onRelaunch}
      >
        {/* One motion cue per card: while relaunching the mark slot swaps to the
         * dot spinner (no title shimmer) and the title stays plain text. */}
        <span className="update-relaunch-mark" aria-hidden>
          {relaunching ? <Spinner size="sm" aria-hidden /> : <JuneMark />}
        </span>
        <span className="update-relaunch-copy">
          <span className="update-relaunch-title">
            {relaunching ? "Relaunching..." : "Relaunch to update"}
          </span>
          <span className={status ? "update-relaunch-status" : undefined}>{meta}</span>
        </span>
        {!relaunching && (
          <IconChevronRightSmall className="update-relaunch-arrow" size={16} aria-hidden />
        )}
      </button>
    </aside>
  );
}

function UpdateStatusCard({
  status,
  failed,
  leaving,
  checking,
  preparing,
  progress,
  onDismiss,
}: {
  status: string;
  failed: boolean;
  leaving: boolean;
  checking: boolean;
  preparing: boolean;
  progress: UpdateInstallProgress | null;
  onDismiss: () => void;
}) {
  const percent = updateProgressPercent(progress);
  const progressWidth =
    progress?.state === "installing" && percent === undefined ? "100%" : `${percent ?? 0}%`;
  // Explicit flags, never string-sniffed: checking covers the manual
  // "Checking for updates..." round-trip, preparing covers download + install.
  // The spinner is decorative; the status text announces the state to AT.
  const busy = checking || preparing;

  return (
    <aside
      className="update-popover update-status-card"
      data-leaving={leaving || undefined}
      role={failed ? "alert" : "status"}
      aria-live="polite"
    >
      <div className="update-status-row">
        <span className="update-status-mark" aria-hidden>
          {busy ? <Spinner size="sm" aria-hidden /> : <JuneMark />}
        </span>
        <span
          className={failed ? "update-status-text update-status-text-failed" : "update-status-text"}
        >
          {status}
        </span>
        <button
          type="button"
          className="update-status-close"
          aria-label={preparing ? "Hide update progress" : "Dismiss update status"}
          onClick={onDismiss}
        >
          <IconCrossSmall size={12} aria-hidden />
        </button>
      </div>
      {progress ? (
        <div className="update-progress" aria-hidden>
          <div className="update-progress-track">
            <div className="update-progress-fill" style={{ width: progressWidth }} />
          </div>
          {percent !== undefined ? (
            <span className="update-progress-percent update-digit-group">
              {/* Each digit keyed by position+character: only a digit whose
               * character changed remounts and replays the pop-in, so the ones
               * digit ticks each percent while the tens digit only rolls over.
               * The % sign stays static. */}
              {String(percent)
                .split("")
                .map((char, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the position-plus-character key is the mechanism — a changed digit remounts to replay the pop-in.
                  <span key={`${i}-${char}`} className="update-digit">
                    {char}
                  </span>
                ))}
              <span>%</span>
            </span>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

function updateProgressPercent(progress: UpdateInstallProgress | null) {
  if (!progress?.contentLength || progress.contentLength <= 0) return undefined;
  return Math.min(
    100,
    Math.round(((progress.downloadedBytes ?? 0) / progress.contentLength) * 100),
  );
}

function updateVersionLabel(version: string) {
  return version.startsWith("v") ? version : `v${version}`;
}

// Sidebar toggle icon. One static panel with a single divider that animates:
// expanded it's a full-height line at x=9, collapsed it slides left to x=7 and
// shrinks to a short centered bar — the same glyph the two central-icons draw,
// but tweened via a transform on the divider so it visibly moves between states.
