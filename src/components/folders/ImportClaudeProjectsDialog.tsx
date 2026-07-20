import { IconCheckmark2 } from "central-icons-filled/IconCheckmark2";
import { IconCodeAssistant } from "central-icons/IconCodeAssistant";
import { IconFolder1 } from "central-icons/IconFolder1";
import { useEffect, useMemo, useRef, useState } from "react";
import { messageFromError } from "../../lib/errors";
import { useScrollFade } from "../../lib/use-scroll-fade";
import {
  discoverClaudeProjects,
  importClaudeProjects,
  type ClaudeProjectCandidate,
  type FolderDto,
} from "../../lib/tauri";
import { Dialog } from "../ui/Dialog";

export function ImportClaudeProjectsDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: (folders: FolderDto[]) => void;
}) {
  const [candidates, setCandidates] = useState<ClaudeProjectCandidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>();
  const [importing, setImporting] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const listFade = useScrollFade(listRef);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCandidates(null);
    setSelected(new Set());
    setError(undefined);
    discoverClaudeProjects()
      .then((items) => {
        if (cancelled) return;
        setCandidates(items);
        setSelected(new Set(items.filter((item) => !item.alreadyAdded).map((item) => item.path)));
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(messageFromError(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const available = useMemo(
    () => candidates?.filter((candidate) => !candidate.alreadyAdded) ?? [],
    [candidates],
  );

  function toggle(path: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function submit() {
    if (selected.size === 0 || importing) return;
    setImporting(true);
    setError(undefined);
    try {
      const folders = await importClaudeProjects([...selected]);
      onImported(folders);
      onClose();
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setImporting(false);
    }
  }

  const count = selected.size;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add projects from Claude Code"
      description="Choose project folders to add to June. Your files stay where they are."
      leading={<IconCodeAssistant size={16} />}
      width={600}
      className="claude-projects-dialog"
      disableBackdropClose={importing}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={importing}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-action primary-solid"
            disabled={count === 0 || importing}
            onClick={() => void submit()}
          >
            {importing
              ? "Adding projects..."
              : `Add ${count} ${count === 1 ? "project" : "projects"}`}
          </button>
        </>
      }
    >
      <div className="dialog-body claude-projects-body">
        {candidates === null && !error ? (
          <p className="claude-projects-status">Looking for Claude Code projects...</p>
        ) : null}
        {error ? (
          <div className="claude-projects-error" role="alert">
            <p>{error}</p>
            {candidates === null ? (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setError(undefined);
                  setCandidates(null);
                  discoverClaudeProjects()
                    .then((items) => {
                      setCandidates(items);
                      setSelected(
                        new Set(
                          items.filter((item) => !item.alreadyAdded).map((item) => item.path),
                        ),
                      );
                    })
                    .catch((caught: unknown) => setError(messageFromError(caught)));
                }}
              >
                Try again
              </button>
            ) : null}
          </div>
        ) : null}
        {candidates && candidates.length === 0 ? (
          <div className="claude-projects-empty">
            <IconFolder1 size={20} />
            <div>
              <strong>No Claude Code projects found</strong>
              <p>Open a local folder with Claude Code, then scan again.</p>
            </div>
          </div>
        ) : null}
        {candidates && candidates.length > 0 && available.length === 0 ? (
          <div className="claude-projects-empty">
            <IconCheckmark2 size={20} />
            <div>
              <strong>Everything is already here</strong>
              <p>All available Claude Code projects have been added to June.</p>
            </div>
          </div>
        ) : null}
        {available.length > 0 ? (
          <>
            <div className="claude-projects-selection-bar">
              <span>{available.length} found</span>
              <button
                type="button"
                onClick={() =>
                  setSelected(
                    selected.size === available.length
                      ? new Set()
                      : new Set(available.map((item) => item.path)),
                  )
                }
              >
                {selected.size === available.length ? "Clear selection" : "Select all"}
              </button>
            </div>
            <ul
              ref={listRef}
              className="claude-projects-list scroll-fade-mask"
              {...listFade.props}
            >
              {available.map((candidate) => (
                <li key={candidate.path}>
                  <label className="claude-project-row">
                    <input
                      type="checkbox"
                      checked={selected.has(candidate.path)}
                      onChange={() => toggle(candidate.path)}
                    />
                    <span className="claude-project-row-icon" aria-hidden>
                      <IconFolder1 size={14} />
                    </span>
                    <span className="claude-project-row-copy">
                      <strong>{candidate.name}</strong>
                      <span title={candidate.path}>{candidate.path}</span>
                    </span>
                    {candidate.lastUsedAt ? (
                      <time dateTime={candidate.lastUsedAt}>
                        {formatLastUsed(candidate.lastUsedAt)}
                      </time>
                    ) : null}
                  </label>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}

function formatLastUsed(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}
