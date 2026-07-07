import { useId, useState } from "react";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { Dialog, DialogField } from "../../components/ui/Dialog";

export function Overlays() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const nameId = useId();

  return (
    <div className="sg-section">
      <h1 className="sg-section-heading">Overlays</h1>
      <p className="sg-section-intro">
        The modal primitives. Both portal to `document.body` and trap focus, so they open behind a
        trigger rather than rendering permanently. Drawers are a separate bespoke treatment (see
        below).
      </p>

      <h2 className="sg-subheading">Dialog</h2>
      <div className="sg-card">
        <div className="sg-token-meta" style={{ marginBottom: "var(--sp-4)" }}>
          <span className="sg-token-name">Dialog</span>
        </div>
        <button type="button" className="primary-action" onClick={() => setDialogOpen(true)}>
          Open dialog...
        </button>
      </div>

      <h2 className="sg-subheading">ConfirmDialog</h2>
      <div className="sg-card">
        <div className="sg-token-meta" style={{ marginBottom: "var(--sp-4)" }}>
          <span className="sg-token-name">ConfirmDialog (destructive)</span>
        </div>
        <button type="button" className="primary-action" onClick={() => setConfirmOpen(true)}>
          Open confirm...
        </button>
      </div>

      <div className="sg-card" style={{ marginTop: "var(--sp-8)" }}>
        <div className="sg-eyebrow">Drawers</div>
        <p className="sg-note" style={{ marginTop: 0 }}>
          The agent activity and skills hub drawers are bespoke slide-ins, not built on `Dialog`.
          They are fine as-is and not systematized here; no live specimen.
        </p>
      </div>

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title="Rename folder"
        description="Give this folder a new name. It updates everywhere it appears."
        footer={
          <>
            <button type="button" className="primary-action" onClick={() => setDialogOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="primary-action primary-solid"
              onClick={() => setDialogOpen(false)}
            >
              Save
            </button>
          </>
        }
      >
        <DialogField label="Folder name" htmlFor={nameId} hint="Shown in the sidebar.">
          <input id={nameId} type="text" className="dialog-input" defaultValue="Q3 planning" />
        </DialogField>
      </Dialog>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => setConfirmOpen(false)}
        title="Delete this note?"
        description="This permanently removes the note and its transcript. This can't be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        destructive
      />
    </div>
  );
}
