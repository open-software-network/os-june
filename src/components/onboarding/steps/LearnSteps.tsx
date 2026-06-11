import { useState } from "react";
import { StepActions, StepHeading } from "../StepChrome";

/**
 * Live dictation rep inside a fake chat card. The dictation pipeline types
 * into whichever field has focus — during onboarding that's our own
 * textarea, so the practice run exercises the real hotkey, mic, and paste
 * path end to end. Success is simply "words arrived".
 */
export function DictationPracticeStep({
  name,
  shortcutLabel,
  onContinue,
}: {
  name?: string;
  shortcutLabel: string;
  onContinue: () => void;
}) {
  const [value, setValue] = useState("");
  const succeeded = value.trim().length >= 4;

  return (
    <section className="onboarding-step">
      <StepHeading
        title="Try it: reply by voice"
        subtitle={
          <>
            Click into the message box, hold{" "}
            <kbd className="onboarding-kbd">{shortcutLabel}</kbd>, say
            something, then release.
          </>
        }
      />
      <div className="onboarding-practice-card">
        <div className="onboarding-practice-header">Messages</div>
        <div className="onboarding-practice-bubble">
          <span className="onboarding-practice-sender">Tobias</span>
          <span>Hey{name ? ` ${name}` : ""}, what's up?</span>
        </div>
        <textarea
          className="onboarding-practice-input"
          rows={3}
          value={value}
          placeholder={`Hold ${shortcutLabel}, speak, release.`}
          onChange={(event) => setValue(event.target.value)}
        />
        {succeeded ? (
          <p className="onboarding-practice-success" role="status">
            Good work! That's all dictation is, anywhere on your Mac.
          </p>
        ) : null}
      </div>
      <StepActions
        onContinue={onContinue}
        continueDisabled={!succeeded}
        onSkip={onContinue}
      />
    </section>
  );
}

const MEETING_DEMO_ROWS = [
  { kind: "Decision", text: "Launch readout confirmed for Thursday" },
  { kind: "Action", text: "Mara to summarize open risks for the board" },
  { kind: "Action", text: "Queue approval before anything sends" },
];

export function MeetingNotesStep({ onContinue }: { onContinue: () => void }) {
  return (
    <section className="onboarding-step">
      <StepHeading
        title="Never take notes again"
        subtitle="June listens to your meetings and writes the notes: decisions, action items, your side and theirs."
      />
      <div className="onboarding-practice-card">
        <div className="onboarding-practice-header">Meeting notes</div>
        <ul className="onboarding-demo-notes">
          {MEETING_DEMO_ROWS.map((row) => (
            <li key={row.text}>
              <span className="onboarding-demo-kind">{row.kind}</span>
              <span>{row.text}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="onboarding-footnote">
        Transcripts and notes stay on your Mac. The first time you record a
        meeting, macOS will ask for system audio. That's the permission we
        mentioned earlier.
      </p>
      <StepActions onContinue={onContinue} />
    </section>
  );
}

export function AgentIntroStep({ onContinue }: { onContinue: () => void }) {
  return (
    <section className="onboarding-step">
      <StepHeading
        title="Hand off real work"
        subtitle="Give June a task, not just a question. Draft the doc, dig through the files, pull the research together. The agent works on your Mac and comes back with it done."
      />
      <div className="onboarding-practice-card">
        <div className="onboarding-practice-header">
          Browser: waiting for you
        </div>
        <p className="onboarding-approval-body">
          June found the file and prepared the edit. Nothing changes until you
          say yes.
        </p>
        <div className="onboarding-approval-actions" aria-hidden>
          <span className="onboarding-approval-button" data-variant="approve">
            Approve
          </span>
          <span className="onboarding-approval-button">Decline</span>
        </div>
      </div>
      <p className="onboarding-footnote">
        That approval card is how the agent works: it proposes, you decide.
      </p>
      <StepActions onContinue={onContinue} />
    </section>
  );
}

/**
 * The honesty screen. Gates the agent on an explicit acknowledgment — a
 * seatbelt moment, not a EULA. Copy encodes the load-bearing distinction:
 * inference privacy is a property of June (always on); action risk is a
 * property of what the user authorizes (scoped, approved, logged).
 */
export function AgentHonestyStep({
  onAcknowledged,
  onContinue,
}: {
  onAcknowledged: () => void;
  onContinue: () => void;
}) {
  const [checked, setChecked] = useState(false);

  return (
    <section className="onboarding-step">
      <StepHeading title="Before you meet the agent, three honest things" />
      <ol className="onboarding-honesty-list">
        <li>
          <h2>The agent can make mistakes.</h2>
          <p>
            It's powerful, and that means it can misread a file, take a wrong
            step, or sound confident while being wrong. Treat its work like a
            sharp new hire's: useful, fast, and worth a glance before it ships.
          </p>
        </li>
        <li>
          <h2>So June keeps it on a short leash.</h2>
          <p>
            By default the agent works inside a sandbox that blocks writes
            outside its own workspace, and it asks before running anything
            risky. Every session has a full activity log, and you can stop it
            at any moment.
          </p>
        </li>
        <li>
          <h2>
            Private inference protects your data. It doesn't approve the
            agent's actions.
          </h2>
          <p>
            When June thinks, your prompts go to zero-retention models: nothing
            stored, nothing trained on. That's the default for every model June
            suggests. When the agent acts
            (visits a site, calls a tool, sends an email you approved), the
            other side sees what it shares, exactly as if you'd done it
            yourself. June
            keeps your data private; it can't make the rest of the internet
            private. That's why you're the approval step.
          </p>
        </li>
      </ol>
      <label className="onboarding-ack">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => setChecked(event.target.checked)}
        />
        <span>
          I understand the agent can make mistakes, and I stay in control of
          what it does.
        </span>
      </label>
      <StepActions
        continueLabel="Meet the agent"
        continueDisabled={!checked}
        onContinue={() => {
          onAcknowledged();
          onContinue();
        }}
      />
    </section>
  );
}
