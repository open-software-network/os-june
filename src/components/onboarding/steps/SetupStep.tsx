import { useEffect } from "react";
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

export function SetupStep({
  shortcutLabel,
  onShortcutLabelChange,
  language,
  onLanguageChange,
  onContinue,
}: {
  shortcutLabel: string;
  onShortcutLabelChange: (label: string) => void;
  language: string;
  onLanguageChange: (language: string) => void;
  onContinue: () => void;
}) {
  // June's dictation key is fn. Apply it when the screen shows so the rest
  // of onboarding (and the app) teaches the real binding; idempotent when
  // fn is already set. Power users can rebind later in Settings.
  useEffect(() => {
    setDictationShortcut("push_to_talk", FN_SHORTCUT)
      .then(() => onShortcutLabelChange(FN_SHORTCUT.label))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="onboarding-step">
      <StepHeading
        title="Set up dictation"
        subtitle="Two things and you're ready to talk."
      />
      <div className="onboarding-setting-card">
        <div className="onboarding-setting-copy">
          <h2>Your dictation key</h2>
          <p>
            June starts listening when you hold{" "}
            <kbd className="onboarding-kbd">{shortcutLabel}</kbd> and types what
            you said when you let go. Change it anytime in Settings.
          </p>
        </div>
      </div>
      <div className="onboarding-setting-card">
        <div className="onboarding-setting-copy">
          <h2 id="onboarding-language-label">Language</h2>
          <p>June understands you in 20+ languages.</p>
        </div>
        <select
          className="onboarding-select"
          aria-labelledby="onboarding-language-label"
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
      <StepActions onContinue={onContinue} />
    </section>
  );
}
