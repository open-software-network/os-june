import { useEffect, useState } from "react";
import type { FolderDto } from "../../lib/tauri";
import { Dialog, DialogField } from "../ui/Dialog";

type EditFolderDialogProps = {
  open: boolean;
  onClose: () => void;
  folder: FolderDto;
  onSave: (name: string, description?: string) => Promise<unknown> | void;
};

export function EditFolderDialog({
  open,
  onClose,
  folder,
  onSave,
}: EditFolderDialogProps) {
  const [name, setName] = useState(folder.name);
  const [description, setDescription] = useState(folder.description ?? "");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(folder.name);
    setDescription(folder.description ?? "");
    setSubmitting(false);
  }, [open, folder.name, folder.description]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await onSave(
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
      title="Edit folder"
      description="Update the folder’s name or description."
      initialFocusSelector='input[name="edit-folder-name"]'
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
            form="edit-folder-form"
            className="primary-action primary-solid"
            disabled={submitting || name.trim().length === 0}
          >
            {submitting ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <form
        id="edit-folder-form"
        className="dialog-body"
        onSubmit={handleSubmit}
      >
        <DialogField label="Name" htmlFor="edit-folder-name">
          <input
            id="edit-folder-name"
            name="edit-folder-name"
            className="dialog-input"
            autoComplete="off"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            maxLength={120}
          />
        </DialogField>
        <DialogField label="Description" htmlFor="edit-folder-description">
          <textarea
            id="edit-folder-description"
            name="edit-folder-description"
            className="dialog-textarea"
            placeholder="What kind of notes belong here?"
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
