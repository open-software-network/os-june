import { IconChevronLeftSmall } from "central-icons/IconChevronLeftSmall";
import { useState } from "react";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Spinner } from "../../ui/Spinner";
import { messageFromError } from "../../../lib/errors";
import type { HermesSkillDocument, HermesSkillInfo, HermesToolsetInfo } from "../../../lib/tauri";
import { capabilityMatches, safeText } from "../agent-workspace-helpers";
import { CapabilityGroup, CapabilityRow, ManagementToolbar } from "./ManagementComponents";
import { toolNames } from "./management-helpers";
export function SkillsToolsPanel({
  loading,
  query,
  saving,
  skills,
  toolsets,
  onQueryChange,
  onRefresh,
  onToggleSkill,
  onToggleToolset,
  onOpenSkill,
  onSaveSkill,
}: {
  loading: boolean;
  query: string;
  saving: string | null;
  skills: HermesSkillInfo[] | null;
  toolsets: HermesToolsetInfo[] | null;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
  onToggleSkill: (skill: HermesSkillInfo, enabled: boolean) => void;
  onToggleToolset: (toolset: HermesToolsetInfo, enabled: boolean) => void;
  onOpenSkill?: (skill: HermesSkillInfo) => Promise<HermesSkillDocument>;
  onSaveSkill?: (skill: HermesSkillInfo, content: string) => Promise<HermesSkillDocument>;
}) {
  const [selectedSkillName, setSelectedSkillName] = useState<string | null>(null);
  const [skillDocument, setSkillDocument] = useState<HermesSkillDocument | null>(null);
  const [skillDraft, setSkillDraft] = useState("");
  const [skillLoading, setSkillLoading] = useState(false);
  const [skillSaving, setSkillSaving] = useState(false);
  const [skillError, setSkillError] = useState<string | null>(null);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const q = query.trim().toLowerCase();
  const visibleSkills = (skills ?? [])
    .filter((skill) => capabilityMatches(skill, q))
    .sort((a, b) => safeText(a.name).localeCompare(safeText(b.name)));
  const visibleToolsets = (toolsets ?? [])
    .filter((toolset) => capabilityMatches(toolset, q))
    .sort((a, b) => safeText(a.label ?? a.name).localeCompare(safeText(b.label ?? b.name)));
  const selectedSkill = (skills ?? []).find((skill) => skill.name === selectedSkillName) ?? null;
  const skillDirty = Boolean(skillDocument) && skillDraft !== (skillDocument?.content ?? "");

  async function openSkill(skill: HermesSkillInfo) {
    if (!onOpenSkill) return;
    setSelectedSkillName(skill.name);
    setSkillDocument(null);
    setSkillDraft("");
    setSkillError(null);
    setSkillLoading(true);
    try {
      const document = await onOpenSkill(skill);
      setSkillDocument(document);
      setSkillDraft(document.content);
    } catch (err) {
      setSkillError(messageFromError(err));
    } finally {
      setSkillLoading(false);
    }
  }

  async function saveSkill() {
    if (!selectedSkill || !onSaveSkill || !skillDocument) return;
    setSkillSaving(true);
    setSkillError(null);
    try {
      const document = await onSaveSkill(selectedSkill, skillDraft);
      setSkillDocument(document);
      setSkillDraft(document.content);
    } catch (err) {
      setSkillError(messageFromError(err));
    } finally {
      setSkillSaving(false);
    }
  }

  function closeSkillEditor() {
    setSelectedSkillName(null);
    setSkillDocument(null);
    setSkillDraft("");
    setSkillError(null);
    setDiscardConfirmOpen(false);
  }

  function requestCloseSkillEditor() {
    if (skillDirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    closeSkillEditor();
  }

  if (selectedSkillName) {
    return (
      <>
        <SkillEditorPanel
          document={skillDocument}
          dirty={skillDirty}
          error={skillError}
          loading={skillLoading}
          saving={skillSaving}
          skill={selectedSkill}
          value={skillDraft}
          onBack={requestCloseSkillEditor}
          onCancel={requestCloseSkillEditor}
          onChange={setSkillDraft}
          onSave={() => void saveSkill()}
        />
        <ConfirmDialog
          open={discardConfirmOpen}
          title="Discard skill edits?"
          description="Your unsaved changes will be lost."
          confirmLabel="Discard"
          destructive
          onClose={() => setDiscardConfirmOpen(false)}
          onConfirm={closeSkillEditor}
        />
      </>
    );
  }

  return (
    <section className="agent-management-panel" aria-label="Skills and tools">
      <ManagementToolbar
        loading={loading}
        placeholder="Search skills and toolsets"
        query={query}
        onQueryChange={onQueryChange}
        onRefresh={onRefresh}
      />
      {loading && !skills && !toolsets ? (
        <div className="agent-loading">
          <Spinner />
        </div>
      ) : (
        <div className="agent-management-scroll">
          <CapabilityGroup title="Skills" count={visibleSkills.length} empty="No matching skills">
            {visibleSkills.map((skill) => (
              <CapabilityRow
                key={skill.name}
                title={skill.name}
                description={skill.description}
                meta={skill.category}
                enabled={Boolean(skill.enabled)}
                saving={saving === `skill:${skill.name}`}
                onSelect={onOpenSkill ? () => void openSkill(skill) : undefined}
                onToggle={(enabled) => onToggleSkill(skill, enabled)}
              />
            ))}
          </CapabilityGroup>
          <CapabilityGroup
            title="Toolsets"
            count={visibleToolsets.length}
            empty="No matching toolsets"
          >
            {visibleToolsets.map((toolset) => (
              <CapabilityRow
                key={toolset.name}
                title={toolset.label ?? toolset.name}
                description={toolset.description}
                meta={toolset.provider ?? toolNames(toolset).slice(0, 4).join(", ")}
                enabled={Boolean(toolset.enabled)}
                saving={saving === `toolset:${toolset.name}`}
                onToggle={(enabled) => onToggleToolset(toolset, enabled)}
              />
            ))}
          </CapabilityGroup>
        </div>
      )}
    </section>
  );
}

function SkillEditorPanel({
  dirty,
  document,
  error,
  loading,
  saving,
  skill,
  value,
  onBack,
  onCancel,
  onChange,
  onSave,
}: {
  dirty: boolean;
  document: HermesSkillDocument | null;
  error: string | null;
  loading: boolean;
  saving: boolean;
  skill: HermesSkillInfo | null;
  value: string;
  onBack: () => void;
  onCancel: () => void;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const title = skill?.name ?? document?.name ?? "Skill";
  const readOnly = Boolean(document?.readOnly);
  return (
    <section className="agent-management-panel agent-skill-editor-panel" aria-label={title}>
      <div className="agent-skill-editor">
        <header className="agent-skill-editor-header">
          <button type="button" className="btn btn-ghost agent-skill-editor-back" onClick={onBack}>
            <IconChevronLeftSmall size={15} aria-hidden />
            Skills
          </button>
          <div className="agent-skill-editor-heading">
            <div>
              <h3>{title}</h3>
              {skill?.description ? <p>{skill.description}</p> : null}
            </div>
            <div className="agent-platform-pills">
              {skill?.category ? <span>{skill.category}</span> : null}
              {document?.relativePath ? <span>{document.relativePath}</span> : null}
              {readOnly ? <span>Read-only</span> : null}
              {skill ? <span>{skill.enabled ? "Enabled" : "Disabled"}</span> : null}
            </div>
          </div>
        </header>
        {error ? <p className="settings-row-error">{error}</p> : null}
        {loading ? (
          <div className="agent-loading">
            <Spinner />
          </div>
        ) : (
          <textarea
            className="agent-skill-editor-textarea"
            value={value}
            aria-label={`${title} skill Markdown`}
            disabled={saving}
            readOnly={readOnly}
            spellCheck={false}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
        )}
      </div>
      <footer className="agent-messaging-footer">
        {readOnly ? (
          <p className="agent-skill-editor-readonly-note">
            Read-only. This skill loads from ~/.agents/skills. Edit it on disk.
          </p>
        ) : null}
        <button type="button" disabled={saving || loading} onClick={onCancel}>
          Cancel
        </button>
        {readOnly ? null : (
          <button
            type="button"
            className="primary-action primary-solid"
            disabled={!dirty || saving || loading || !document}
            onClick={onSave}
          >
            {saving ? "Saving..." : "Save changes"}
          </button>
        )}
      </footer>
    </section>
  );
}
