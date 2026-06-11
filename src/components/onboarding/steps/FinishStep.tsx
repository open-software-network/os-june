import { IconRocket } from "central-icons-filled/IconRocket";
import { StepActions, StepHeading, StepSpot } from "../StepChrome";

export function FinishStep({
  shortcutLabel,
  onComplete,
}: {
  shortcutLabel: string;
  onComplete: () => void;
}) {
  return (
    <section className="onboarding-step onboarding-step-hero">
      <StepHeading
        art={
          <StepSpot>
            <IconRocket size={26} aria-hidden />
          </StepSpot>
        }
        title="You're all set"
        subtitle={
          <>
            Hold <kbd className="onboarding-kbd">{shortcutLabel}</kbd> in any
            app and start talking.
          </>
        }
      />
      <StepActions continueLabel="Start using June" onContinue={onComplete} />
    </section>
  );
}
