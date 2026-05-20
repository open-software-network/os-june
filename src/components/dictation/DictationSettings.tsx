import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { useEffect, useRef, useState } from "react";

const MICROPHONE_OPTIONS = [
  "Auto-detect",
  "MacBook Pro Microphone",
  "AirPods Pro",
  "External USB Mic",
] as const;

type MicrophoneOption = (typeof MICROPHONE_OPTIONS)[number];

const MODIFIER_KEYS = new Set([
  "Meta",
  "Shift",
  "Alt",
  "Control",
  "OS",
  "ContextMenu",
]);

export function DictationSettings() {
  const [shortcut, setShortcut] = useState<string[]>(["⇧", "T"]);
  const [capturing, setCapturing] = useState(false);
  const [microphone, setMicrophone] =
    useState<MicrophoneOption>("Auto-detect");
  const [micOpen, setMicOpen] = useState(false);
  const micWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!micOpen) return;
    function onPointer(event: MouseEvent) {
      if (!micWrapRef.current?.contains(event.target as Node)) {
        setMicOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setMicOpen(false);
    }
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [micOpen]);

  useEffect(() => {
    if (!capturing) return;
    function onKey(event: KeyboardEvent) {
      event.preventDefault();
      if (event.key === "Escape") {
        setCapturing(false);
        return;
      }
      // Ignore standalone modifier presses — wait for the trailing key.
      if (MODIFIER_KEYS.has(event.key)) return;

      const parts: string[] = [];
      if (event.metaKey) parts.push("⌘");
      if (event.ctrlKey) parts.push("⌃");
      if (event.altKey) parts.push("⌥");
      if (event.shiftKey) parts.push("⇧");
      parts.push(formatKey(event));
      setShortcut(parts);
      setCapturing(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [capturing]);

  return (
    <div className="settings-page">
      <header className="settings-header">
        <h1 className="settings-title">Dictation</h1>
        <p className="settings-description">
          Dictate from anywhere on your Mac. Scribe drops the transcript
          wherever your cursor is.
        </p>
      </header>

      <section className="settings-group" aria-labelledby="shortcuts-heading">
        <h2 id="shortcuts-heading" className="settings-group-heading">
          Shortcuts
        </h2>
        <div className="settings-card">
          <div className="settings-rows">
            <div className="settings-row">
              <div className="settings-row-info">
                <h3 className="settings-row-title">Dictate anywhere</h3>
                <p className="settings-row-description">
                  Hold this combination from anywhere on your Mac to start
                  dictating.
                </p>
              </div>
              <div className="settings-row-control">
                <KeycapShortcut keys={shortcut} capturing={capturing} />
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setCapturing((value) => !value)}
                >
                  {capturing ? "Cancel" : "Change"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-group" aria-labelledby="audio-heading">
        <h2 id="audio-heading" className="settings-group-heading">
          Audio
        </h2>
        <div className="settings-card">
          <div className="settings-rows">
            <div className="settings-row">
              <div className="settings-row-info">
                <h3 className="settings-row-title">Microphone</h3>
                <p className="settings-row-description">
                  Input device used when dictating and recording notes.
                </p>
              </div>
              <div className="settings-row-control" ref={micWrapRef}>
                <button
                  type="button"
                  className="select-trigger"
                  aria-haspopup="listbox"
                  aria-expanded={micOpen}
                  onClick={() => setMicOpen((value) => !value)}
                >
                  <span>{microphone}</span>
                  <IconChevronDownSmall size={14} />
                </button>
                {micOpen ? (
                  <ul
                    className="select-popover"
                    role="listbox"
                    style={{
                      // Slide so the selected item's top sits at the
                      // trigger top, accounting for the popover's 4px
                      // (sp-1) inset padding.
                      top: -(
                        4 +
                        Math.max(0, MICROPHONE_OPTIONS.indexOf(microphone)) *
                          28
                      ),
                    }}
                  >
                    {MICROPHONE_OPTIONS.map((option) => {
                      const selected = option === microphone;
                      return (
                        <li key={option}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={selected}
                            data-selected={selected}
                            onClick={() => {
                              setMicrophone(option);
                              setMicOpen(false);
                            }}
                          >
                            <span>{option}</span>
                            <span className="select-check" aria-hidden>
                              {selected ? (
                                <IconCheckmark1Small size={14} />
                              ) : null}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function KeycapShortcut({
  keys,
  capturing,
}: {
  keys: string[];
  capturing: boolean;
}) {
  if (capturing) {
    return (
      <span className="keycap-frame keycap-frame-capturing">
        Press shortcut…
      </span>
    );
  }
  return (
    <span
      className="keycap-frame"
      aria-label={`Shortcut ${keys.join(" ")}`}
    >
      {keys.map((key, idx) => (
        <kbd key={`${key}-${idx}`} className="keycap">
          {key}
        </kbd>
      ))}
    </span>
  );
}

function formatKey(event: KeyboardEvent): string {
  // Prefer event.code so Shift+T renders as "T", Option+T as "T" (not "†"),
  // etc. Only fall back to event.key for non-letter/number keys.
  const code = event.code;
  if (code.startsWith("Key") && code.length === 4) return code.slice(3);
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5);

  const key = event.key;
  if (key === " " || code === "Space") return "Space";
  if (key === "ArrowUp") return "↑";
  if (key === "ArrowDown") return "↓";
  if (key === "ArrowLeft") return "←";
  if (key === "ArrowRight") return "→";
  if (key === "Enter") return "↩";
  if (key === "Tab") return "⇥";
  if (key === "Escape") return "⎋";
  if (key === "Backspace") return "⌫";
  if (key.length === 1) return key.toUpperCase();
  return key;
}
