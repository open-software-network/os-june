import type { FolderDto } from "../../lib/tauri";

type Props = {
  folder?: FolderDto;
  noteTitle: string;
  onBackToFolders: () => void;
  onBackToFolder: (folderId: string) => void;
};

/**
 * Sticky breadcrumb rendered above the note editor when the user
 * landed on the note from a folder. Mirrors the folder-detail crumb
 * bar so the in-folder context stays visible while the editor itself
 * is the unchanged main-notes editor.
 */
export function NoteFromFolderCrumb({
  folder,
  noteTitle,
  onBackToFolders,
  onBackToFolder,
}: Props) {
  return (
    <div className="crumb-bar" data-tauri-drag-region>
      <button type="button" className="crumb-link" onClick={onBackToFolders}>
        Folders
      </button>
      {folder ? (
        <>
          <span className="crumb-sep" aria-hidden>
            /
          </span>
          <button
            type="button"
            className="crumb-link"
            onClick={() => onBackToFolder(folder.id)}
          >
            {folder.name}
          </button>
        </>
      ) : null}
      <span className="crumb-sep" aria-hidden>
        /
      </span>
      <span className="crumb-current">{noteTitle}</span>
    </div>
  );
}
