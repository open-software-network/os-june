import { IconConcise } from "central-icons/IconConcise";
import { IconConsole } from "central-icons/IconConsole";
import { IconDotGrid1x3Horizontal } from "central-icons/IconDotGrid1x3Horizontal";
import { IconFiles } from "central-icons/IconFiles";
import { IconFolderAddRight } from "central-icons/IconFolderAddRight";
import { IconGauge } from "central-icons/IconGauge";
import { IconMoveFolder } from "central-icons/IconMoveFolder";
import { IconPencil } from "central-icons/IconPencil";
import { IconShareOs } from "central-icons/IconShareOs";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { useEffect, useRef, useState } from "react";
import { ShareLinkCopyAction } from "../../share/ShareLinkCopyAction";
import { BackButton } from "../../ui/BackButton";
import { Dialog } from "../../ui/Dialog";
import type { AgentProjectContext } from "../../../lib/agent-project-context";
import { HERMES_TUI_DEBUG_WARNING } from "../../../lib/hermes-tui-debug";
import type { ModelPrivacyBadge } from "../../../lib/model-privacy";
import type { AgentWorkspaceOrigin } from "../agent-workspace-types";
import { PrivacyModeBadge, UnrestrictedBadge } from "../composer/ModelPicker";

// Persistent, full-width session bar — same chrome as the Notes/Folders
// breadcrumb. Stays pinned while the conversation scrolls beneath it, carries
// the back arrow + origin crumbs (Projects / {project} or Agents), the
// private-mode badge, and folds rename/delete into an overflow menu so the
// conversation keeps the focus (no separate title heading).
export function AgentSessionBar({
  origin,
  privacyBadge,
  fullMode,
  title,
  shareUrl,
  artifactCount = 0,
  artifactsOpen = false,
  inProject = false,
  projectContext,
  onToggleArtifacts,
  onRename,
  onShare,
  onMoveToProject,
  onDelete,
  onShowUsage,
  onCompactContext,
  onOpenTuiDebug,
}: {
  origin?: AgentWorkspaceOrigin;
  privacyBadge?: ModelPrivacyBadge;
  fullMode?: boolean;
  title?: string;
  shareUrl?: string;
  artifactCount?: number;
  artifactsOpen?: boolean;
  inProject?: boolean;
  projectContext?: AgentProjectContext;
  onToggleArtifacts?: () => void;
  onRename?: (title: string) => void;
  /** Opens the private-sharing dialog for this session (JUN-308). */
  onShare?: () => void;
  /** Opens the change-project dialog (which also owns removal). */
  onMoveToProject?: () => void;
  onDelete?: () => void;
  onShowUsage?: () => void;
  onCompactContext?: () => void;
  /** Developer-only: open this session in Hermes' raw TUI. Undefined (and the
   * menu item absent) in production builds. */
  onOpenTuiDebug?: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(title ?? "");
  const [menuOpen, setMenuOpen] = useState(false);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const menuWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onPointer(event: MouseEvent) {
      if (!menuWrapRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  function commitRename() {
    setRenaming(false);
    onRename?.(draft);
  }

  const hasMenu = Boolean(
    onRename ||
      onShare ||
      onMoveToProject ||
      onDelete ||
      onShowUsage ||
      onCompactContext ||
      onOpenTuiDebug,
  );

  return (
    <div className="detail-bar agent-session-bar" data-tauri-drag-region>
      {origin ? <BackButton label={origin.backLabel} onClick={origin.onBack} /> : null}
      <nav className="detail-breadcrumb" aria-label="Breadcrumb">
        <ol>
          {origin ? (
            origin.crumbs.map((crumb, index) => (
              <li key={`${crumb.label}-${index}`}>
                {index > 0 ? (
                  <span className="detail-breadcrumb-separator" aria-hidden>
                    /
                  </span>
                ) : null}
                <button type="button" className="detail-breadcrumb-link" onClick={crumb.onClick}>
                  {crumb.icon ? (
                    <span className="detail-breadcrumb-icon" aria-hidden>
                      {crumb.icon}
                    </span>
                  ) : null}
                  {crumb.label}
                </button>
              </li>
            ))
          ) : (
            <li>
              <span className="detail-breadcrumb-label">Session</span>
            </li>
          )}
          {title !== undefined ? (
            <li>
              <span className="detail-breadcrumb-separator" aria-hidden>
                /
              </span>
              {renaming ? (
                <input
                  className="agent-session-rename"
                  aria-label="Session name"
                  autoFocus
                  value={draft}
                  onChange={(event) => setDraft(event.currentTarget.value)}
                  onBlur={commitRename}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitRename();
                    }
                    if (event.key === "Escape") {
                      setRenaming(false);
                      setDraft(title ?? "");
                    }
                  }}
                />
              ) : (
                <span className="detail-breadcrumb-current-group">
                  <span className="detail-breadcrumb-current">{title || "Untitled session"}</span>
                  {shareUrl ? <ShareLinkCopyAction url={shareUrl} /> : null}
                </span>
              )}
            </li>
          ) : origin ? (
            <li>
              <span className="detail-breadcrumb-separator" aria-hidden>
                /
              </span>
              <span className="detail-breadcrumb-current">New session</span>
            </li>
          ) : null}
        </ol>
      </nav>
      <div className="detail-bar-actions">
        {projectContext ? (
          <button
            type="button"
            className="agent-project-instructions"
            onClick={() => setInstructionsOpen(true)}
          >
            Project instructions
          </button>
        ) : null}
        {fullMode ? <UnrestrictedBadge /> : null}
        {onToggleArtifacts && artifactCount > 0 ? (
          <button
            type="button"
            className="agent-session-files"
            aria-label={`View files (${artifactCount})`}
            title="View files"
            aria-pressed={artifactsOpen}
            onClick={onToggleArtifacts}
          >
            <IconFiles size={14} />
            <span aria-hidden>{artifactCount}</span>
          </button>
        ) : null}
        <PrivacyModeBadge badge={privacyBadge} />
        {hasMenu ? (
          <div className="agent-session-menu-wrap" ref={menuWrapRef}>
            <button
              type="button"
              className="icon-button agent-session-menu-trigger"
              aria-label="Session actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <IconDotGrid1x3Horizontal size={16} />
            </button>
            {menuOpen ? (
              <div className="sidebar-identity-menu agent-session-menu" role="menu">
                {onRename ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      setDraft(title ?? "");
                      setRenaming(true);
                    }}
                  >
                    <IconPencil size={14} />
                    Rename
                  </button>
                ) : null}
                {onShare ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onShare();
                    }}
                  >
                    <IconShareOs size={14} />
                    Share
                  </button>
                ) : null}
                {onMoveToProject ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onMoveToProject();
                    }}
                  >
                    {inProject ? <IconMoveFolder size={14} /> : <IconFolderAddRight size={14} />}
                    {inProject ? "Change project" : "Add to project"}
                  </button>
                ) : null}
                {(onRename || onShare || onMoveToProject) && (onShowUsage || onCompactContext) ? (
                  <div className="context-menu-separator" role="separator" />
                ) : null}
                {onShowUsage ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onShowUsage();
                    }}
                  >
                    <IconGauge size={14} />
                    Usage
                  </button>
                ) : null}
                {onCompactContext ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onCompactContext();
                    }}
                  >
                    <IconConcise size={14} />
                    Compact context
                  </button>
                ) : null}
                {onDelete && (onRename || onMoveToProject || onShowUsage || onCompactContext) ? (
                  <div className="context-menu-separator" role="separator" />
                ) : null}
                {onDelete ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="destructive"
                    onClick={() => {
                      setMenuOpen(false);
                      onDelete();
                    }}
                  >
                    <IconTrashCan size={14} />
                    Delete session
                  </button>
                ) : null}
                {onOpenTuiDebug ? (
                  <>
                    <div className="context-menu-separator" role="separator" />
                    <button
                      type="button"
                      role="menuitem"
                      // Debug-only fallback: resume this session in Hermes' raw
                      // TUI to tell a June adapter/UI bug from a Hermes one.
                      title={HERMES_TUI_DEBUG_WARNING}
                      onClick={() => {
                        setMenuOpen(false);
                        onOpenTuiDebug();
                      }}
                    >
                      <IconConsole size={14} />
                      Debug with Hermes TUI
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <Dialog
        open={instructionsOpen}
        onClose={() => setInstructionsOpen(false)}
        title={`${projectContext?.name ?? "Project"} instructions`}
        footer={
          <button
            type="button"
            className="primary-action"
            onClick={() => setInstructionsOpen(false)}
          >
            Close
          </button>
        }
      >
        <div className="agent-project-instructions-content">
          {projectContext?.instructions?.trim() || "No project instructions have been added."}
        </div>
      </Dialog>
    </div>
  );
}
