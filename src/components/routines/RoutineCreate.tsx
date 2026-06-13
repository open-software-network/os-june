import { useState } from "react";
import {
  draftFromSchedule,
  scheduleFromDraft,
  type ScheduleDraft,
} from "../../lib/routine-schedule";
import { BreadcrumbBar } from "../ui/BreadcrumbBar";
import { GrowingTextarea } from "./GrowingTextarea";
import { RoutineModePicker } from "./RoutineModePicker";
import { SchedulePicker } from "./SchedulePicker";
import type { RoutineTemplate } from "./routine-templates";

export type RoutineCreateInput = {
  prompt: string;
  schedule: string;
  name?: string;
  unrestricted: boolean;
};

type RoutineCreateProps = {
  /** Prefills the editor; the user still reviews and saves explicitly. */
  template?: RoutineTemplate;
  creating: boolean;
  error: string | null;
  onBack: () => void;
  onCreate: (input: RoutineCreateInput) => void;
};

export function RoutineCreate({
  template,
  creating,
  error,
  onBack,
  onCreate,
}: RoutineCreateProps) {
  const [name, setName] = useState(template?.name ?? "");
  const [draft, setDraft] = useState<ScheduleDraft>(() =>
    template
      ? draftFromSchedule(template.schedule)
      : { kind: "daily", time: "09:00" },
  );
  const [prompt, setPrompt] = useState(template?.prompt ?? "");
  const [unrestricted, setUnrestricted] = useState(
    template?.unrestricted ?? false,
  );

  function submit() {
    if (!prompt.trim()) return;
    onCreate({
      prompt: prompt.trim(),
      schedule: scheduleFromDraft(draft),
      name: name.trim() || undefined,
      unrestricted,
    });
  }

  return (
    <section className="routine-detail" aria-label="New routine">
      <BreadcrumbBar
        backLabel="Back to routines"
        onBack={onBack}
        items={[
          { label: "Routines", onClick: onBack },
          { label: name.trim() || "New routine" },
        ]}
        actions={
          <div className="routine-detail-actions">
            <button type="button" className="btn btn-ghost" onClick={onBack}>
              Cancel
            </button>
            <button
              type="button"
              className="primary-action primary-solid"
              disabled={!prompt.trim() || creating}
              onClick={submit}
            >
              {creating ? "Creating…" : "Create"}
            </button>
          </div>
        }
      />

      <div className="routine-detail-content">
        <input
          className="routine-detail-name"
          value={name}
          placeholder="Routine name"
          aria-label="Routine name"
          onChange={(event) => setName(event.currentTarget.value)}
        />

        {error ? <p className="error-banner">{error}</p> : null}

        <div className="routine-detail-body">
          <section
            className="settings-group"
            aria-labelledby="routine-schedule"
          >
            <h2 id="routine-schedule" className="settings-group-heading">
              Schedule
            </h2>
            <div className="settings-card">
              <SchedulePicker draft={draft} onChange={setDraft} />
            </div>
          </section>

          <section
            className="settings-group"
            aria-labelledby="routine-instructions"
          >
            <h2 id="routine-instructions" className="settings-group-heading">
              Instructions
            </h2>
            <GrowingTextarea
              className="routine-detail-instructions"
              value={prompt}
              aria-label="Instructions"
              placeholder="Summarize my unread notes and list anything that needs a reply…"
              onChange={(event) => setPrompt(event.currentTarget.value)}
            />
          </section>

          <section className="settings-group" aria-labelledby="routine-access">
            <h2 id="routine-access" className="settings-group-heading">
              Access
            </h2>
            <div className="settings-card">
              <RoutineModePicker
                unrestricted={unrestricted}
                onChange={setUnrestricted}
              />
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}
