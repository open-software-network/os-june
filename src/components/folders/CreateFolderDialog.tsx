import { useEffect, useState } from "react";
import { Dialog, DialogField } from "../ui/Dialog";

type CreateFolderDialogProps = {
  open: boolean;
  onClose: () => void;
  /** Optional seed name (e.g. when "Create new" is triggered from a search). */
  defaultName?: string;
  onCreate: (name: string, description?: string) => Promise<unknown> | void;
};

export function CreateFolderDialog({
  open,
  onClose,
  defaultName,
  onCreate,
}: CreateFolderDialogProps) {
  const [name, setName] = useState(defaultName ?? "");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(defaultName ?? "");
    setDescription("");
    setSubmitting(false);
  }, [open, defaultName]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await onCreate(
        trimmed,
        description.trim() ? description.trim() : undefined,
      );
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (submitting) return;
        onClose();
      }}
      title="Create project"
      description="Group meeting notes and agent sessions by project, client, or topic."
      initialFocusSelector='input[name="folder-name"]'
      footer={
        <>
          <button
            type="button"
            className="primary-action"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="create-folder-form"
            className="primary-action primary-solid"
            disabled={submitting || name.trim().length === 0}
          >
            {submitting ? "Creating…" : "Create project"}
          </button>
        </>
      }
    >
      <form
        id="create-folder-form"
        className="dialog-body"
        onSubmit={handleSubmit}
      >
        <DialogField label="Name" htmlFor="folder-name">
          <input
            id="folder-name"
            name="folder-name"
            className="dialog-input"
            placeholder="e.g. Customer interviews"
            autoComplete="off"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            maxLength={120}
          />
        </DialogField>
        <DialogField label="Description" htmlFor="folder-description">
          <textarea
            id="folder-description"
            name="folder-description"
            className="dialog-textarea"
            placeholder="What belongs in this project?"
            value={description}
            onChange={(event) => setDescription(event.currentTarget.value)}
            rows={3}
            maxLength={400}
          />
        </DialogField>
      </form>
    </Dialog>
  );
}
