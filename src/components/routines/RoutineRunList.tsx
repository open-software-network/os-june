import { IconZap } from "central-icons/IconZap";
import { sessionTimestamp } from "../../lib/hermes-adapter";
import type { HermesSessionInfo } from "../../lib/tauri";

/** Past runs of one or all routines: each row is a cron-sourced session,
 * opened in the agent view on click so the whole conversation is readable. */
export function RoutineRunList({
  runs,
  label,
  onOpen,
}: {
  runs: HermesSessionInfo[];
  label: (run: HermesSessionInfo) => string;
  onOpen: (run: HermesSessionInfo) => void;
}) {
  return (
    <ul className="routines-list routines-runs-list" role="list">
      {runs.map((run) => (
        <RunRow
          key={run.id}
          run={run}
          label={label(run)}
          onOpen={() => onOpen(run)}
        />
      ))}
    </ul>
  );
}

function RunRow({
  run,
  label,
  onOpen,
}: {
  run: HermesSessionInfo;
  label: string;
  onOpen: () => void;
}) {
  const preview = run.preview?.trim();
  return (
    <li className="routines-run">
      <button type="button" className="routines-run-button" onClick={onOpen}>
        <span className="routines-item-icon" aria-hidden>
          <IconZap size={14} />
        </span>
        <span className="routines-run-body">
          <span className="routines-run-name">{label}</span>
          {preview ? (
            <span className="routines-run-preview">{preview}</span>
          ) : null}
        </span>
        <span className="routines-run-time">
          {formatRunTime(sessionTimestamp(run))}
        </span>
      </button>
    </li>
  );
}

export function formatRunTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const now = new Date();
  const time = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (isSameDate(date, now)) return `today ${time}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (isSameDate(date, tomorrow)) return `tomorrow ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDate(date, yesterday)) return `yesterday ${time}`;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function isSameDate(left: Date, right: Date) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}
