import type { FolderDto } from "../../lib/tauri";

type FolderPickerProps = {
  folders: FolderDto[];
  folderIds: string[];
  onAssign: (folderId: string) => void;
  onRemove: (folderId: string) => void;
};

export function FolderPicker({
  folders,
  folderIds,
  onAssign,
  onRemove,
}: FolderPickerProps) {
  return (
    <div className="folder-picker">
      {folders.map((folder) => {
        const assigned = folderIds.includes(folder.id);
        return (
          <label key={folder.id}>
            <input
              type="checkbox"
              checked={assigned}
              onChange={() =>
                assigned ? onRemove(folder.id) : onAssign(folder.id)
              }
            />
            {folder.name}
          </label>
        );
      })}
    </div>
  );
}
