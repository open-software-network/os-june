import { useId } from "react";
import { DialogField } from "../../components/ui/Dialog";

/** A canonical / deviation status chip shown above each specimen. */
function Flag({ kind }: { kind: "canonical" | "deviation" }) {
  return (
    <span className={kind === "canonical" ? "sg-flag sg-flag-ok" : "sg-flag sg-flag-no"}>
      {kind === "canonical"
        ? "closest to canon"
        : "deviation, pending shared field treatment (pass 2)"}
    </span>
  );
}

export function Inputs() {
  const dialogId = useId();
  const secretId = useId();
  const mcpId = useId();

  return (
    <div className="sg-section">
      <h1 className="sg-section-heading">Inputs</h1>
      <p className="sg-section-intro">
        The honest state of text fields. `dialog-input` in a `DialogField` is the closest thing to
        canon; the rest are bespoke classes scattered across surfaces, pending a shared field
        component in pass 2.
      </p>

      <h2 className="sg-subheading">Closest to canon</h2>
      <div className="sg-card">
        <Flag kind="canonical" />
        <div className="sg-token-meta" style={{ margin: "var(--sp-3) 0 var(--sp-5)" }}>
          <span className="sg-token-name">DialogField + dialog-input</span>
        </div>
        <DialogField label="Folder name" htmlFor={dialogId} hint="Shown in the sidebar.">
          <input
            id={dialogId}
            type="text"
            className="dialog-input"
            defaultValue="Q3 planning"
            placeholder="Untitled folder"
          />
        </DialogField>
      </div>

      <h2 className="sg-subheading">Deviations</h2>
      <p className="sg-note">
        Rendered as-is, outside their home contexts, so the visual drift is visible.
      </p>
      <div className="sg-stack" style={{ marginTop: "var(--sp-5)" }}>
        <div className="sg-card">
          <Flag kind="deviation" />
          <div className="sg-token-meta" style={{ margin: "var(--sp-3) 0 var(--sp-5)" }}>
            <span className="sg-token-name">settings-secret-input</span>
          </div>
          <label
            htmlFor={secretId}
            className="dialog-field-label"
            style={{ display: "block", marginBottom: "var(--sp-2)" }}
          >
            API key
          </label>
          <input
            id={secretId}
            type="password"
            className="settings-secret-input"
            placeholder="sk-..."
            defaultValue="secret-value"
          />
        </div>

        <div className="sg-card">
          <Flag kind="deviation" />
          <div className="sg-token-meta" style={{ margin: "var(--sp-3) 0 var(--sp-5)" }}>
            <span className="sg-token-name">mcp-add-input</span>
          </div>
          <label
            htmlFor={mcpId}
            className="dialog-field-label"
            style={{ display: "block", marginBottom: "var(--sp-2)" }}
          >
            Server URL
          </label>
          <input
            id={mcpId}
            type="text"
            className="mcp-add-input"
            placeholder="https://mcp.example.com"
          />
        </div>

        <div className="sg-card">
          <Flag kind="deviation" />
          <div className="sg-token-meta" style={{ margin: "var(--sp-3) 0 var(--sp-4)" }}>
            <span className="sg-token-name">model-picker-search-input</span>
          </div>
          <p className="sg-note" style={{ marginTop: 0 }}>
            No standalone specimen: this class is `border: 0; background: transparent`, styled to
            sit inside the model picker's search chrome (`.model-picker-search`). Rendered bare it
            has no visible box, so it would read as a broken specimen. It is a deviation pending the
            shared field treatment like the others.
          </p>
        </div>
      </div>
    </div>
  );
}
