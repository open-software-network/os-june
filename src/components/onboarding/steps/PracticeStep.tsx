import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { useEffect, useRef, useState } from "react";
import { discoverySource, setDiscoverySource } from "../../../lib/onboarding";
import { JuneMark } from "../../account/AccountGate";
import { KeycapShortcut } from "../../shortcuts/KeycapShortcut";
import { useShortcutCapture } from "../../shortcuts/use-shortcut-capture";
import { Select } from "../../ui/Select";
import { StepActions, StepCard } from "../StepChrome";

// June "types" for a beat before its greeting lands — the small theater that
// makes the demo read as a live session rather than a printed screenshot.
const TYPING_MS = 1100;

const DISCOVERY_QUESTION = "Where did you hear about June?";

const DISCOVERY_OPTIONS = [
  { value: "friend", label: "Friend or coworker" },
  { value: "x-twitter", label: "X (Twitter)" },
  { value: "youtube", label: "YouTube" },
  { value: "instagram-tiktok", label: "Instagram or TikTok" },
  { value: "podcast-newsletter", label: "Podcast or newsletter" },
  { value: "ai-chat", label: "ChatGPT or another AI" },
  { value: "search", label: "Search engine" },
  { value: "other", label: "Other" },
];

/**
 * First contact with June, and the dictation rep in one: a session card where
 * June greets the user and asks for work, and the reply box is a real
 * textarea — the dictation pipeline types into whichever field has focus, so
 * answering by voice exercises the real hotkey, mic, and paste path end to
 * end. Success is simply "words arrived".
 *
 * "Change key" rebinds right here (fn doesn't exist on most non-Mac
 * keyboards), writing through the same setting Settings edits — so dictation
 * setup never needs a screen of its own.
 */
export function DictationPracticeStep({
  shortcutLabel,
  onShortcutLabelChange,
  onContinue,
}: {
  shortcutLabel: string;
  onShortcutLabelChange: (label: string) => void;
  onContinue: () => void;
}) {
  const [value, setValue] = useState("");
  const [greeted, setGreeted] = useState(false);
  const succeeded = value.trim().length >= 4;

  // One last question, Mobbin's end-of-flow attribution slot. Asked only if
  // it has never been answered — a version-bump replay must not survey the
  // same user twice — and it never gates Continue.
  const [discovered, setDiscovered] = useState<string | null>(discoverySource);
  const askDiscovery = useRef(discoverySource() === null).current;

  const capture = useShortcutCapture({
    kind: "push_to_talk",
    onSaved: (saved, captured) =>
      onShortcutLabelChange(saved?.pushToTalkShortcut?.label ?? captured.label),
  });

  useEffect(() => {
    const timer = window.setTimeout(() => setGreeted(true), TYPING_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <StepCard title="Talk to June" subtitle="Say what you want done." wide>
      <div className="onboarding-practice-stack">
        <div className="onboarding-shortcut-row">
          <span className="onboarding-shortcut-label">
            {capture.capturing ? (
              <KeycapShortcut label="" capturing />
            ) : (
              <>
                Hold <KeycapShortcut label={shortcutLabel} /> to dictate
              </>
            )}
          </span>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() =>
              void (capture.capturing ? capture.cancel() : capture.start())
            }
          >
            {capture.capturing ? "Cancel" : "Change key"}
          </button>
        </div>
        <div className="onboarding-practice-card">
          <div className="onboarding-practice-thread">
            <div className="onboarding-practice-avatar" aria-hidden>
              <JuneMark />
            </div>
            <div className="onboarding-practice-message">
              <span className="onboarding-practice-sender">June</span>
              {greeted ? (
                <span className="onboarding-practice-text">
                  What should we work on first?
                </span>
              ) : (
                <span className="onboarding-typing" aria-label="June is typing">
                  <span />
                  <span />
                  <span />
                </span>
              )}
            </div>
          </div>
          <div className="onboarding-practice-composer">
            <textarea
              className="onboarding-practice-input"
              rows={2}
              value={value}
              placeholder="Tell June what to do..."
              onChange={(event) => setValue(event.target.value)}
            />
            <div className="onboarding-practice-toolbar">
              <span className="onboarding-practice-hint" aria-hidden>
                <KeycapShortcut label={shortcutLabel} />
              </span>
              {succeeded ? (
                <span
                  className="onboarding-practice-success"
                  role="status"
                  aria-label="Dictation is working"
                >
                  <IconCheckmark1Small size={15} aria-hidden />
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </div>
      {capture.error ? <p className="welcome-status">{capture.error}</p> : null}
      {askDiscovery ? (
        <div className="onboarding-discovery">
          <div className="onboarding-discovery-head">
            <h2>{DISCOVERY_QUESTION}</h2>
            <span className="onboarding-discovery-optional">Optional</span>
          </div>
          <Select
            ariaLabel={DISCOVERY_QUESTION}
            value={discovered}
            options={DISCOVERY_OPTIONS}
            placeholder="Choose one"
            onChange={(source) => {
              setDiscovered(source);
              setDiscoverySource(source);
            }}
          />
        </div>
      ) : null}
      <StepActions
        continueLabel="Start using June"
        onContinue={onContinue}
        continueDisabled={!succeeded}
        onSkip={onContinue}
      />
    </StepCard>
  );
}
