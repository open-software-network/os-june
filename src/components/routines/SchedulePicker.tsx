import {
  humanizeSchedule,
  scheduleFromDraft,
  type ScheduleDraft,
} from "../../lib/routine-schedule";
import { Select } from "../ui/Select";

const KIND_OPTIONS = [
  { value: "daily", label: "Daily" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
  { value: "interval", label: "Interval" },
  { value: "custom", label: "Custom" },
];

type ScheduleKind = ScheduleDraft["kind"];

const DAY_OPTIONS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
].map((label, day) => ({ value: String(day), label }));

const UNIT_OPTIONS = [
  { value: "minutes", label: "minutes" },
  { value: "hours", label: "hours" },
];

/** Structured schedule editing for routines: one row where the cadence
 * select swaps its companion controls inline. Presets cover the schedules
 * people actually set (a clock time daily, on weekdays, or weekly, plus
 * simple intervals); Custom accepts anything Hermes parses and is where
 * un-presentable existing schedules land untouched. */
export function SchedulePicker({
  draft,
  onChange,
}: {
  draft: ScheduleDraft;
  onChange: (draft: ScheduleDraft) => void;
}) {
  // Carry the clock time across the day-based kinds so flipping
  // Daily → Weekdays keeps the chosen time.
  const heldTime = "time" in draft ? draft.time : "09:00";

  function switchKind(kind: ScheduleKind) {
    if (kind === draft.kind) return;
    switch (kind) {
      case "daily":
        onChange({ kind, time: heldTime });
        break;
      case "weekdays":
        onChange({ kind, time: heldTime });
        break;
      case "weekly":
        onChange({ kind, day: 1, time: heldTime });
        break;
      case "interval":
        onChange({ kind, minutes: 60 });
        break;
      case "custom":
        // Seed with the equivalent of the current draft, so Custom doubles
        // as "show me the cron for what I just picked".
        onChange({ kind, expression: scheduleFromDraft(draft) });
        break;
    }
  }

  const intervalUnit =
    draft.kind === "interval" && draft.minutes % 60 === 0 ? "hours" : "minutes";
  const intervalAmount =
    draft.kind === "interval"
      ? intervalUnit === "hours"
        ? draft.minutes / 60
        : draft.minutes
      : 1;

  const preview =
    draft.kind === "custom"
      ? humanizeSchedule(draft.expression.trim())
      : humanizeSchedule(scheduleFromDraft(draft));
  const showPreview =
    draft.kind === "custom"
      ? draft.expression.trim().length > 0 &&
        preview !== draft.expression.trim()
      : true;

  return (
    <div className="schedule-picker">
      <div className="schedule-picker-controls">
        <Select
          value={draft.kind}
          options={KIND_OPTIONS}
          placeholder="Schedule"
          ariaLabel="Schedule type"
          onChange={(kind) => switchKind(kind as ScheduleKind)}
        />

        {draft.kind === "weekly" ? (
          <Select
            value={String(draft.day)}
            options={DAY_OPTIONS}
            placeholder="Day"
            ariaLabel="Day of week"
            onChange={(day) => onChange({ ...draft, day: Number(day) })}
          />
        ) : null}

        {draft.kind === "daily" ||
        draft.kind === "weekdays" ||
        draft.kind === "weekly" ? (
          <input
            type="time"
            value={draft.time}
            aria-label="Time"
            onChange={(event) =>
              onChange({ ...draft, time: event.currentTarget.value })
            }
          />
        ) : null}

        {draft.kind === "interval" ? (
          <>
            <input
              type="number"
              min={1}
              value={intervalAmount}
              aria-label="Repeat every"
              onChange={(event) => {
                const amount = Math.max(
                  1,
                  Math.floor(Number(event.currentTarget.value) || 1),
                );
                onChange({
                  kind: "interval",
                  minutes: intervalUnit === "hours" ? amount * 60 : amount,
                });
              }}
            />
            <Select
              value={intervalUnit}
              options={UNIT_OPTIONS}
              placeholder="Unit"
              ariaLabel="Interval unit"
              onChange={(unit) =>
                onChange({
                  kind: "interval",
                  minutes:
                    unit === "hours" ? intervalAmount * 60 : intervalAmount,
                })
              }
            />
          </>
        ) : null}

        {draft.kind === "custom" ? (
          <input
            className="schedule-picker-custom"
            type="text"
            value={draft.expression}
            aria-label="Custom schedule"
            placeholder="0 9 * * 1-5 or every 30m"
            onChange={(event) =>
              onChange({
                kind: "custom",
                expression: event.currentTarget.value,
              })
            }
          />
        ) : null}
      </div>

      {showPreview ? (
        <p className="schedule-picker-preview">{preview}</p>
      ) : draft.kind === "custom" ? (
        <p className="schedule-picker-preview">
          A cron expression, an interval like "every 30m", or a date for a
          one-time run.
        </p>
      ) : null}
    </div>
  );
}
