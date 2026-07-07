import { useState } from "react";
import { Select } from "../../components/ui/Select";
import { Switch } from "../../components/ui/Switch";

/** Small mono caption naming the structural class alongside a specimen row. */
function Caption({ children }: { children: string }) {
  return <span className="sg-caption">{children}</span>;
}

const THEME_OPTIONS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function SettingsPattern() {
  const [notify, setNotify] = useState(true);
  const [theme, setTheme] = useState<string | null>("system");

  return (
    <div className="sg-section">
      <h1 className="sg-section-heading">Settings surface</h1>
      <p className="sg-section-intro">
        The canonical settings markup contract, hand-written with dummy content. A `settings-group`
        holds a muted heading and description above one or more `settings-card`s; each card wraps
        `settings-rows` of title/description/control rows. Class names are captioned in mono
        alongside each structural piece.
      </p>

      {/* .settings-page owns the reading width + vertical rhythm the rows assume. */}
      <div className="settings-page">
        <div className="settings-group">
          <Caption>settings-group</Caption>
          <div className="settings-group-header">
            <h2 className="settings-group-heading">
              General <Caption>settings-group-heading</Caption>
            </h2>
          </div>
          <p className="settings-group-description">
            Preferences that apply across June. <Caption>settings-group-description</Caption>
          </p>

          <div className="settings-card">
            <Caption>settings-card</Caption>
            <div className="settings-rows" style={{ marginTop: "var(--sp-3)" }}>
              {/* Row with title + description + Switch control */}
              <div className="settings-row">
                <div className="settings-row-info">
                  <h3 className="settings-row-title">Notifications</h3>
                  <p className="settings-row-description">
                    Show a system notification when a recording finishes processing.
                  </p>
                  <Caption>
                    settings-row / settings-row-info / settings-row-title / -description
                  </Caption>
                </div>
                <div className="settings-row-control">
                  <Switch checked={notify} onCheckedChange={setNotify} aria-label="Notifications" />
                </div>
              </div>

              {/* Row with title + Select control */}
              <div className="settings-row">
                <div className="settings-row-info">
                  <h3 className="settings-row-title">Appearance</h3>
                  <Caption>settings-row-control (Select)</Caption>
                </div>
                <div className="settings-row-control">
                  <Select
                    value={theme}
                    options={THEME_OPTIONS}
                    placeholder="Theme"
                    onChange={setTheme}
                    ariaLabel="Appearance"
                  />
                </div>
              </div>

              {/* Dense compact row */}
              <div className="settings-row settings-row-compact">
                <div className="settings-row-info">
                  <h3 className="settings-row-title">Launch at login</h3>
                  <Caption>settings-row settings-row-compact</Caption>
                </div>
                <div className="settings-row-control">
                  <Switch checked={false} onCheckedChange={() => {}} aria-label="Launch at login" />
                </div>
              </div>

              {/* Row followed by an error line */}
              <div className="settings-row">
                <div className="settings-row-info">
                  <h3 className="settings-row-title">Sync</h3>
                  <p className="settings-row-description">Keep your notes backed up.</p>
                </div>
                <div className="settings-row-control">
                  <Switch checked={false} onCheckedChange={() => {}} aria-label="Sync" />
                </div>
              </div>
              <p className="settings-row-error">
                Couldn't reach the sync service. <Caption>settings-row-error</Caption>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
