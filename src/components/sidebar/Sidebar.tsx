import type { FolderDto } from "../../lib/tauri";

type SidebarProps = {
  folders: FolderDto[];
  selectedFolderId?: string;
  onCreateFolder: () => void;
  onSelectAll: () => void;
  onSelectFolder: (folderId: string) => void;
};

export function Sidebar({
  folders,
  selectedFolderId,
  onCreateFolder,
  onSelectAll,
  onSelectFolder,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <h1>OS Notetaker</h1>
      <button type="button" onClick={onCreateFolder}>
        + New Folder
      </button>
      <button
        type="button"
        className={!selectedFolderId ? "active" : undefined}
        onClick={onSelectAll}
      >
        All Notes
      </button>
      <nav className="folder-nav" aria-label="Folders">
        {folders.map((folder) => (
          <button
            key={folder.id}
            type="button"
            className={selectedFolderId === folder.id ? "active" : undefined}
            onClick={() => onSelectFolder(folder.id)}
          >
            {folder.name}
          </button>
        ))}
      </nav>
    </aside>
  );
}
