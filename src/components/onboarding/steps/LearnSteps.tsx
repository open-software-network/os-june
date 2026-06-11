import { useEffect, useState } from "react";
import { LANGUAGE_OPTIONS } from "../../../lib/dictation-languages";
import { setDictationLanguage, setDictationShortcut } from "../../../lib/tauri";
import { StepActions, StepHeading } from "../StepChrome";

// The product default: bare fn, mirroring DictationShortcutSetting::bare_fn()
// on the Rust side.
const FN_SHORTCUT = {
  code: "Fn",
  modifiers: {
    command: false,
    control: false,
    option: false,
    shift: false,
    function: true,
  },
  label: "Fn",
  pressCount: 1 as const,
};

/**
 * Live dictation rep inside a fake chat card. The dictation pipeline types
 * into whichever field has focus — during onboarding that's our own
 * textarea, so the practice run exercises the real hotkey, mic, and paste
 * path end to end. Success is simply "words arrived".
 *
 * This step also owns dictation setup: it applies the fn default on mount
 * (idempotent; rebind later in Settings) and offers the language picker in
 * a quiet row under the card, so setup never needs a screen of its own.
 */
export function DictationPracticeStep({
  name,
  shortcutLabel,
  onShortcutLabelChange,
  language,
  onLanguageChange,
  onContinue,
}: {
  name?: string;
  shortcutLabel: string;
  onShortcutLabelChange: (label: string) => void;
  language: string;
  onLanguageChange: (language: string) => void;
  onContinue: () => void;
}) {
  const [value, setValue] = useState("");
  const succeeded = value.trim().length >= 4;

  useEffect(() => {
    setDictationShortcut("push_to_talk", FN_SHORTCUT)
      .then(() => onShortcutLabelChange(FN_SHORTCUT.label))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="onboarding-step">
      <StepHeading
        title="Now say something"
        subtitle={
          <>
            Click the message box, hold{" "}
            <kbd className="onboarding-kbd">{shortcutLabel}</kbd>, talk, then
            let go.
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
            That's it. Dictation works like this in every app.
          </p>
        ) : null}
      </div>
      <div className="onboarding-language-row">
        <label htmlFor="onboarding-language">
          June understands 20+ languages
        </label>
        <select
          id="onboarding-language"
          className="onboarding-select"
          value={language}
          onChange={(event) => {
            const next = event.target.value;
            onLanguageChange(next);
            void setDictationLanguage(next || undefined).catch(() => undefined);
          }}
        >
          {LANGUAGE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
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
        subtitle="June listens to your meetings and writes the notes."
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
        Notes stay on your Mac. macOS asks for system audio the first time you
        record.
      </p>
      <StepActions onContinue={onContinue} />
    </section>
  );
}

// One line per honest thing. The full reasoning lives in the docs; the
// screen's job is the gist plus the acknowledgment.
const AGENT_TRUTHS = [
  "It can make mistakes, so glance over its work before it ships.",
  "It asks first. Edits, sends, and purchases all wait for your yes.",
  "Private inference protects your data. What the agent does, you approve.",
];

/**
 * Meet-the-agent screen: the approval card shows how the agent works
 * (it proposes, you decide) and the acknowledgment gates the agent on the
 * one distinction that matters — a seatbelt moment, not a EULA.
 */
export function AgentStep({
  onAcknowledged,
  onContinue,
}: {
  onAcknowledged: () => void;
  onContinue: () => void;
}) {
  const [checked, setChecked] = useState(false);

  return (
    <section className="onboarding-step">
      <StepHeading
        title="Meet the agent"
        subtitle="Hand June real work. It does the task on your Mac and asks before anything irreversible."
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
      <ol className="onboarding-truths">
        {AGENT_TRUTHS.map((truth) => (
          <li key={truth}>{truth}</li>
        ))}
      </ol>
      <label className="onboarding-ack">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => setChecked(event.target.checked)}
        />
        <span>
          The agent can make mistakes, and I stay in control of what it does.
        </span>
      </label>
      <StepActions
        continueDisabled={!checked}
        onContinue={() => {
          onAcknowledged();
          onContinue();
        }}
      />
    </section>
  );
}
