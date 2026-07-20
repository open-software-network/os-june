import { IconCloudySun } from "central-icons/IconCloudySun";
import { useEffect, useState } from "react";
import { createRoutine, listRoutines } from "../../../lib/hermes-routines";
import { humanizeSchedule } from "../../../lib/routine-schedule";
import { ROUTINE_TEMPLATES } from "../../routines/routine-templates";
import { p3aRecord } from "../../../lib/tauri";
import { StepActions, StepCard } from "../StepChrome";

/** The one starter routine whose prompt is fully self-contained (no
 * [placeholder] the user must fill in), which is what makes a one-click
 * opt-in honest: what you enable is exactly what will run. */
const template = ROUTINE_TEMPLATES.find((candidate) => candidate.id === "morning-brief");

/**
 * Last onboarding screen: a one-click daily reason to come back. June's
 * pillars are all pull-based (the user must remember to record, dictate, or
 * ask), so a fresh install otherwise ends with nothing scheduled and no
 * future touchpoint. Opting in creates the sandboxed "Morning brief" routine
 * through the normal Routines machinery; declining is a first-class quiet
 * path, not a dark pattern.
 */
export function MorningBriefStep({ onContinue }: { onContinue: () => void }) {
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(false);
  const [error, setError] = useState<string>();

  // Template lookup is static; a missing entry is a programming error but
  // must not strand the user inside onboarding. Advance from an effect, not
  // during render.
  useEffect(() => {
    if (!template) onContinue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!template) return null;

  async function enable() {
    if (!template || creating || created) return;
    setCreating(true);
    setError(undefined);
    try {
      // Wizard replays (ONBOARDING_VERSION bumps) walk existing users
      // through this step again; enabling must not stack a second copy of
      // the routine. Best-effort: if the lookup itself fails, creation
      // proceeds (a duplicate is recoverable under Routines, a hard block
      // here is not).
      const existing = await listRoutines().catch(() => []);
      const alreadySetUp = existing.some((routine) => routine.name === template.name);
      if (!alreadySetUp) {
        await createRoutine({
          prompt: template.prompt,
          schedule: template.schedule,
          name: template.name,
        });
      }
      setCreated(true);
      void p3aRecord("onboarding.morning-brief.enabled");
      onContinue();
    } catch {
      setError("Could not set it up right now. You can add it later under Routines.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <StepCard
      title="Start tomorrow with a brief"
      subtitle="June can prepare a short morning brief on weekdays: open loops, todos, and anything new that matters."
      wide
    >
      <div className="onboarding-brief-card">
        <span className="onboarding-brief-icon" aria-hidden>
          <IconCloudySun size={18} />
        </span>
        <span className="onboarding-brief-body">
          <span className="onboarding-brief-name">{template.name}</span>
          <span className="onboarding-brief-meta">
            {humanizeSchedule(template.schedule)}. You can edit or remove it any time under
            Routines.
          </span>
        </span>
      </div>
      {error ? <p className="welcome-status">{error}</p> : null}
      <StepActions
        continueLabel={creating ? "Setting up..." : "Enable morning brief"}
        continueDisabled={creating}
        onContinue={() => void enable()}
        onSkip={onContinue}
        skipLabel="Not now"
      />
    </StepCard>
  );
}
