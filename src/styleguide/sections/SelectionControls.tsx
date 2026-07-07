import { useState } from "react";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { Select } from "../../components/ui/Select";
import { Switch } from "../../components/ui/Switch";

const LANGUAGE_OPTIONS = [
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "ja", label: "Japanese" },
];

const ACCENT_OPTIONS = [
  { value: "clay", label: "Clay", color: "#c08457" },
  { value: "sage", label: "Sage", color: "#7c8a6a" },
  { value: "slate", label: "Slate", color: "#6b7480" },
  { value: "plum", label: "Plum", color: "#8a6a80" },
];

const DENSITY_OPTIONS = [
  { value: "compact", label: "Compact" },
  { value: "cozy", label: "Cozy" },
  { value: "roomy", label: "Roomy" },
] as const;

export function SelectionControls() {
  const [switchOn, setSwitchOn] = useState(false);
  const [switchOn2, setSwitchOn2] = useState(true);
  const [language, setLanguage] = useState<string | null>("en");
  const [accent, setAccent] = useState<string | null>("clay");
  const [density, setDensity] = useState<(typeof DENSITY_OPTIONS)[number]["value"]>("cozy");

  return (
    <div className="sg-section">
      <h1 className="sg-section-heading">Selection controls</h1>
      <p className="sg-section-intro">
        The canonical toggle, picker, and exclusive-option controls. All wired to local state here
        so they respond.
      </p>

      <h2 className="sg-subheading">Switch</h2>
      <div className="sg-row">
        <div className="sg-card">
          <div className="sg-token-meta" style={{ marginBottom: "var(--sp-4)" }}>
            <span className="sg-token-name">Switch (off)</span>
          </div>
          <Switch checked={switchOn} onCheckedChange={setSwitchOn} aria-label="Toggle example" />
        </div>
        <div className="sg-card">
          <div className="sg-token-meta" style={{ marginBottom: "var(--sp-4)" }}>
            <span className="sg-token-name">Switch (on)</span>
          </div>
          <Switch
            checked={switchOn2}
            onCheckedChange={setSwitchOn2}
            aria-label="Toggle example on"
          />
        </div>
        <div className="sg-card">
          <div className="sg-token-meta" style={{ marginBottom: "var(--sp-4)" }}>
            <span className="sg-token-name">Switch (disabled)</span>
          </div>
          <Switch
            checked={false}
            onCheckedChange={() => {}}
            disabled
            aria-label="Disabled toggle"
          />
        </div>
      </div>

      <h2 className="sg-subheading">Select</h2>
      <div className="sg-row">
        <div className="sg-card">
          <div className="sg-token-meta" style={{ marginBottom: "var(--sp-4)" }}>
            <span className="sg-token-name">Select (text)</span>
          </div>
          <Select
            value={language}
            options={LANGUAGE_OPTIONS}
            placeholder="Choose a language"
            onChange={setLanguage}
            ariaLabel="Language"
          />
        </div>
        <div className="sg-card">
          <div className="sg-token-meta" style={{ marginBottom: "var(--sp-4)" }}>
            <span className="sg-token-name">Select (color swatches)</span>
          </div>
          <Select
            value={accent}
            options={ACCENT_OPTIONS}
            placeholder="Choose an accent"
            onChange={setAccent}
            ariaLabel="Accent color"
          />
        </div>
      </div>

      <h2 className="sg-subheading">SegmentedControl</h2>
      <div className="sg-row">
        <div className="sg-card">
          <div className="sg-token-meta" style={{ marginBottom: "var(--sp-4)" }}>
            <span className="sg-token-name">SegmentedControl</span>
          </div>
          <SegmentedControl
            value={density}
            onValueChange={setDensity}
            options={DENSITY_OPTIONS}
            aria-label="Density"
          />
        </div>
      </div>
    </div>
  );
}
