import { IconBrain } from "central-icons/IconBrain";
import { IconChevronRightSmall } from "central-icons/IconChevronRightSmall";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconPencilLine } from "central-icons/IconPencilLine";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconProjects } from "central-icons/IconProjects";
import { IconTrashCanSimple } from "central-icons/IconTrashCanSimple";
import type { FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import { useProjectMemoryDemo } from "../../lib/project-memory-demo";
import {
  createMemory,
  deleteMemory,
  listMemories,
  memorySettings,
  setMemoryEnabled,
  updateMemory,
  type FolderDto,
  type MemoryDto,
} from "../../lib/tauri";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Dialog, DialogField } from "../ui/Dialog";
import { EmptyState } from "../ui/EmptyState";
import { Select } from "../ui/Select";
import { Switch } from "../ui/Switch";
import { SettingsPageHeader } from "./AppSettings";

const MEMORY_MAX_CHARS = 4_000;
// Filter sentinel for memories that aren't tied to any project.
const SCOPE_ALL = "__all__";
const SCOPE_GENERAL = "__general__";

export function MemorySettingsSection({
  folders,
  initialFolderFilter,
  onOpenProject,
}: {
  folders: FolderDto[];
  /** When deep-linked from a project, pre-filter the manager to it. */
  initialFolderFilter?: string;
  /** Drill from a memory's project tag into that project. */
  onOpenProject?: (folderId: string) => void;
}) {
  const [memories, setMemories] = useState<MemoryDto[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<string>(initialFolderFilter ?? SCOPE_ALL);

  // __projectMemoryDemo() (dev console): populate the manager with sample
  // memories, spread across real projects, to design the list at scale.
  const demo = useProjectMemoryDemo();
  const allMemories = useMemo(
    () => (demo ? decorateDemoMemories(demo, folders) : memories),
    [demo, folders, memories],
  );

  useEffect(() => {
    void refresh();
  }, []);

  // Follow the deep-link: opening Memory from a project scopes to it; opening
  // it from the settings nav (filter cleared upstream) resets to all.
  useEffect(() => {
    setScope(initialFolderFilter ?? SCOPE_ALL);
  }, [initialFolderFilter]);

  async function refresh() {
    try {
      // Every memory — global and per-project — so this page is the one place
      // to browse and prune all of them.
      const [nextMemories, settings] = await Promise.all([
        listMemories(undefined, true),
        memorySettings(),
      ]);
      setMemories(sortNewestFirst(nextMemories));
      setEnabled(settings.enabled);
      setError(undefined);
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setLoaded(true);
    }
  }

  async function toggleEnabled(next: boolean) {
    try {
      const settings = await setMemoryEnabled(next);
      setEnabled(settings.enabled);
      setError(undefined);
    } catch (caught) {
      setError(messageFromError(caught));
    }
  }

  async function addMemory(content: string, folderId?: string) {
    const created = await createMemory({ content, folderId, source: "user" });
    setMemories((current) => sortNewestFirst([created, ...current]));
  }

  async function editMemory(id: string, content: string) {
    const updated = await updateMemory(id, content);
    setMemories((current) =>
      sortNewestFirst(current.map((memory) => (memory.id === updated.id ? updated : memory))),
    );
  }

  async function removeMemory(id: string) {
    try {
      await deleteMemory(id);
      setMemories((current) => current.filter((memory) => memory.id !== id));
      setError(undefined);
    } catch (caught) {
      setError(messageFromError(caught));
      throw caught;
    }
  }

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      allMemories.filter((memory) => {
        if (scope === SCOPE_GENERAL && memory.folderId) return false;
        if (scope !== SCOPE_ALL && scope !== SCOPE_GENERAL && memory.folderId !== scope) {
          return false;
        }
        if (normalizedQuery && !memory.content.toLowerCase().includes(normalizedQuery)) {
          return false;
        }
        return true;
      }),
    [allMemories, scope, normalizedQuery],
  );

  const scopeOptions = useMemo(
    () => [
      { value: SCOPE_ALL, label: "All projects", count: allMemories.length },
      {
        value: SCOPE_GENERAL,
        label: "General",
        count: allMemories.filter((memory) => !memory.folderId).length,
      },
      ...[...folders]
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
        .map((folder) => ({
          value: folder.id,
          label: folder.name,
          count: allMemories.filter((memory) => memory.folderId === folder.id).length,
        })),
    ],
    [folders, allMemories],
  );

  const addDefaultFolderId = scope !== SCOPE_ALL && scope !== SCOPE_GENERAL ? scope : undefined;
  const addMemoryButton = (
    <button
      type="button"
      className="primary-action primary-solid memory-add"
      disabled={!enabled || !loaded}
      onClick={() => setAddOpen(true)}
    >
      <IconPlusMedium size={14} />
      Add memory
    </button>
  );

  return (
    <section className="settings-group memory-settings" aria-labelledby="memory-heading">
      <SettingsPageHeader
        id="memory-heading"
        title="Memory"
        blurb="Everything June remembers, across every project. Memories stay on this Mac."
      />

      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-info">
            <h3 className="settings-row-title">Let June remember things</h3>
            <p className="settings-row-description">
              June can save useful details across sessions and use them when they are relevant.
            </p>
          </div>
          <div className="settings-row-control">
            <Switch
              checked={enabled}
              disabled={!loaded}
              aria-label="Let June remember things"
              onCheckedChange={(next) => void toggleEnabled(next)}
            />
          </div>
        </div>
      </div>

      {!enabled && loaded ? (
        <p className="memory-settings-hint">
          Memory is off. Saved memories remain visible, but June cannot add or update them.
        </p>
      ) : null}

      {loaded && allMemories.length === 0 ? (
        <EmptyState
          className="memory-empty-state"
          label="Saved memories"
          icon={<IconBrain size={28} />}
          title="Nothing remembered yet"
          description="June saves useful details as you work together and brings them back when they're relevant. What it remembers shows up here."
          action={addMemoryButton}
        />
      ) : (
        <>
          <h2 className="settings-group-heading memory-manager-heading">
            Saved memories
            {loaded ? (
              <span className="status-pill memory-manager-heading-count">{allMemories.length}</span>
            ) : null}
          </h2>
          <p className="settings-group-description">
            Everything June has remembered, across every project. Search, filter by project, edit,
            or delete.
          </p>
          <div className="settings-card memory-manager-card">
            <div className="memory-manager-toolbar">
              <div className="settings-search memory-search">
                <IconMagnifyingGlass
                  size={15}
                  ariaHidden
                  className="settings-search-icon memory-search-icon"
                />
                <input
                  type="search"
                  aria-label="Search memories"
                  placeholder="Search memories"
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                />
              </div>
              <Select
                className="memory-scope-select"
                value={scope}
                options={scopeOptions}
                placeholder="All projects"
                ariaLabel="Filter memories by project"
                onChange={setScope}
                popoverWidth="trigger"
              />
              {addMemoryButton}
            </div>
            {filtered.length > 0 ? (
              <MemoryRows
                memories={filtered}
                folders={folders}
                editable={enabled}
                onUpdate={editMemory}
                onDelete={removeMemory}
                onOpenProject={onOpenProject}
              />
            ) : (
              <p className="memory-manager-noresults">No memories match your search.</p>
            )}
          </div>
        </>
      )}
      {error ? (
        <p className="settings-row-error" role="alert">
          {error}
        </p>
      ) : null}

      <MemoryDialog
        open={addOpen}
        title="Add memory"
        submitLabel="Add memory"
        folders={folders}
        defaultFolderId={addDefaultFolderId}
        onClose={() => setAddOpen(false)}
        onSubmit={async (content, folderId) => {
          await addMemory(content, folderId);
          setAddOpen(false);
        }}
      />
    </section>
  );
}

export function MemoryRows({
  memories,
  folders,
  editable,
  onUpdate,
  onDelete,
  onOpenProject,
}: {
  memories: MemoryDto[];
  /** Present in the manager so each row can show its project tag. */
  folders?: FolderDto[];
  editable: boolean;
  onUpdate: (id: string, content: string) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  /** Drill from a memory's project into that project. */
  onOpenProject?: (folderId: string) => void;
}) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState<MemoryDto>();
  const [deleting, setDeleting] = useState<MemoryDto>();
  const [error, setError] = useState<string>();

  const folderName = useMemo(() => {
    const byId = new Map((folders ?? []).map((folder) => [folder.id, folder.name]));
    return (memory: MemoryDto) => (memory.folderId ? byId.get(memory.folderId) : undefined);
  }, [folders]);

  return (
    <>
      <div className="settings-rows memory-rows">
        {memories.map((memory) => {
          const expanded = expandedIds.has(memory.id);
          const project = folderName(memory);
          return (
            <div key={memory.id} className="settings-row settings-row-compact memory-row">
              <div className="settings-row-info">
                <button
                  type="button"
                  className="memory-content"
                  data-expanded={expanded || undefined}
                  aria-expanded={expanded}
                  onClick={() =>
                    setExpandedIds((current) => {
                      const next = new Set(current);
                      if (next.has(memory.id)) next.delete(memory.id);
                      else next.add(memory.id);
                      return next;
                    })
                  }
                >
                  {memory.content}
                </button>
                <p className="memory-meta">
                  <span>{memory.source === "agent" ? "Added by June" : "Added by you"}</span>
                  <span className="metadata-dot" aria-hidden />
                  <span>{formatMemoryDate(memory.createdAt)}</span>
                  {project && memory.folderId ? (
                    <>
                      <span className="metadata-dot" aria-hidden />
                      {onOpenProject ? (
                        <button
                          type="button"
                          className="memory-project"
                          aria-label={`Open project ${project}`}
                          onClick={() => onOpenProject(memory.folderId as string)}
                        >
                          <IconProjects size={11} />
                          {project}
                          <IconChevronRightSmall size={11} className="memory-project-chevron" />
                        </button>
                      ) : (
                        <span className="memory-project">
                          <IconProjects size={11} />
                          {project}
                        </span>
                      )}
                    </>
                  ) : null}
                </p>
              </div>
              <div className="settings-row-control">
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Edit memory"
                  disabled={!editable}
                  onClick={() => setEditing(memory)}
                >
                  <IconPencilLine size={14} />
                </button>
                <button
                  type="button"
                  className="icon-button icon-button-destructive"
                  aria-label="Delete memory"
                  onClick={() => setDeleting(memory)}
                >
                  <IconTrashCanSimple size={14} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {error ? (
        <p className="settings-row-error" role="alert">
          {error}
        </p>
      ) : null}

      <MemoryDialog
        open={editing !== undefined}
        title="Edit memory"
        submitLabel="Save changes"
        initialContent={editing?.content}
        onClose={() => {
          setEditing(undefined);
          setError(undefined);
        }}
        onSubmit={async (content) => {
          if (!editing) return;
          try {
            await onUpdate(editing.id, content);
            setEditing(undefined);
            setError(undefined);
          } catch (caught) {
            setError(messageFromError(caught));
            throw caught;
          }
        }}
      />
      <ConfirmDialog
        open={deleting !== undefined}
        title="Delete memory?"
        description="This permanently removes this memory from June."
        confirmLabel="Delete"
        destructive
        onClose={() => setDeleting(undefined)}
        onConfirm={async () => {
          if (!deleting) return;
          await onDelete(deleting.id);
        }}
      />
    </>
  );
}

function MemoryDialog({
  open,
  title,
  submitLabel,
  initialContent = "",
  folders,
  defaultFolderId,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  submitLabel: string;
  initialContent?: string;
  folders?: FolderDto[];
  defaultFolderId?: string;
  onClose: () => void;
  onSubmit: (content: string, folderId?: string) => Promise<void>;
}) {
  const [content, setContent] = useState(initialContent);
  // null = no project (a general memory) — the optional default.
  const [scope, setScope] = useState<string | null>(defaultFolderId ?? null);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setContent(initialContent);
    setScope(defaultFolderId ?? null);
    setError(undefined);
  }, [open, initialContent, defaultFolderId]);

  function handleClose() {
    if (saving) return;
    onClose();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = content.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      await onSubmit(trimmed, folders && scope ? scope : undefined);
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={title}
      initialFocusSelector='textarea[name="memory-content"]'
      footer={
        <>
          <button type="button" className="primary-action" disabled={saving} onClick={handleClose}>
            Cancel
          </button>
          <button
            type="submit"
            form="memory-entry-form"
            className="primary-action primary-solid"
            disabled={saving || content.trim().length === 0}
          >
            {submitLabel}
          </button>
        </>
      }
    >
      <form id="memory-entry-form" className="dialog-body" onSubmit={handleSubmit}>
        <DialogField label="Memory" htmlFor="memory-content">
          <textarea
            id="memory-content"
            name="memory-content"
            className="dialog-textarea"
            value={content}
            maxLength={MEMORY_MAX_CHARS}
            onChange={(event) => {
              setContent(event.currentTarget.value);
              setError(undefined);
            }}
          />
        </DialogField>
        {folders ? (
          <DialogField label="Project" hint="Optional. Choose General to apply everywhere.">
            <Select
              value={scope ?? SCOPE_GENERAL}
              options={[
                { value: SCOPE_GENERAL, label: "General" },
                ...folders.map((folder) => ({ value: folder.id, label: folder.name })),
              ]}
              placeholder="Select a project"
              ariaLabel="Memory project"
              onChange={(value) => setScope(value === SCOPE_GENERAL ? null : value)}
              popoverWidth="trigger"
            />
          </DialogField>
        ) : null}
        {error ? (
          <p className="settings-row-error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}

/** Spread demo memories across the first real projects (leaving one General)
 * so the manager mock shows realistic project tags. */
function decorateDemoMemories(demo: MemoryDto[], folders: FolderDto[]): MemoryDto[] {
  return demo.map((memory, index) => {
    const slot = folders[index % (folders.length + 1)];
    return { ...memory, folderId: slot?.id };
  });
}

function formatMemoryDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

function sortNewestFirst(memories: MemoryDto[]) {
  return [...memories].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function messageFromError(caught: unknown) {
  if (caught && typeof caught === "object" && "message" in caught) {
    return String((caught as { message: unknown }).message);
  }
  return String(caught);
}
