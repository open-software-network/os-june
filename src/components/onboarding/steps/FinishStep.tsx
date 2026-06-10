import { StepActions, StepHeading } from "../StepChrome";

export function FinishStep({
  shortcutLabel,
  onComplete,
}: {
  shortcutLabel: string;
  onComplete: () => void;
}) {
  return (
    <section className="onboarding-step">
      <StepHeading
        title="You're all set"
        subtitle="Three ways to put June to work right now."
      />
      <ul className="onboarding-feature-list">
        <li>
          <strong>Dictate anywhere</strong>: hold{" "}
          <kbd className="onboarding-kbd">{shortcutLabel}</kbd> in any app and
          speak.
        </li>
        <li>
          <strong>Take meeting notes</strong>: start a recording from the
          sidebar when your next meeting begins.
        </li>
        <li>
          <strong>Hand off a task</strong>: open the agent and ask it to
          summarize a folder or research a topic.
        </li>
      </ul>
      <StepActions continueLabel="Start using June" onContinue={onComplete} />
    </section>
  );
}
