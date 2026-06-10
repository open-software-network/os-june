import { StepActions, StepHeading } from "../StepChrome";

export function WelcomeStep({
  name,
  onContinue,
}: {
  name?: string;
  onContinue: () => void;
}) {
  return (
    <section className="onboarding-step">
      <StepHeading
        title={name ? `Welcome, ${name}!` : "Welcome to June"}
        subtitle="June is your private AI assistant: dictate into any app, never take meeting notes again, and hand off real work to an agent that runs on your Mac."
      />
      <ul className="onboarding-feature-list">
        <li>
          <strong>Talk, don't type</strong> — hold a key and speak; June types
          at your cursor in whatever app has focus.
        </li>
        <li>
          <strong>Never take notes again</strong> — decisions, action items, and
          who said what, written for you.
        </li>
        <li>
          <strong>Hand off real work</strong> — give June a task, not just a
          question. It comes back with it done.
        </li>
      </ul>
      <StepActions
        continueLabel="Let's get you set up"
        onContinue={onContinue}
      />
    </section>
  );
}
