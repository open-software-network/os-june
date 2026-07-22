import { IconArrowUpRight } from "central-icons/IconArrowUpRight";
import { IconBubbleWide } from "central-icons/IconBubbleWide";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconChevronLeftSmall } from "central-icons/IconChevronLeftSmall";
import { IconFinder } from "central-icons/IconFinder";
import { IconFolder1 } from "central-icons/IconFolder1";
import { IconFolders } from "central-icons/IconFolders";
import { type CSSProperties, useState } from "react";
import {
  revealPath,
  type HermesFilesystemEntry,
  type HermesFilesystemSnapshot,
  type HermesMessagingEnvVarInfo,
  type HermesMessagingPlatformInfo,
} from "../../../lib/tauri";
import { EmptyState } from "../../ui/EmptyState";
import { Spinner } from "../../ui/Spinner";
import {
  capabilityMatches,
  compactPath,
  filterFilesystemEntries,
  formatBytes,
  includesQuery,
  isAbsolutePath,
  relativeDate,
  safeText,
} from "../agent-workspace-helpers";
import { FileTypeIcon } from "../FileTypeIcon";
import { CapabilityGroup, CapabilityRow, ManagementToolbar } from "./ManagementComponents";
import { envFieldSet, fieldLabel, messagingTrimEdits, stateLabel } from "./management-helpers";

export function MessagingPanel({
  envEdits,
  loading,
  platforms,
  query,
  saving,
  selectedPlatformId,
  onEditEnv,
  onQueryChange,
  onRefresh,
  onSaveEnv,
  onSelectPlatform,
  onBack,
  onToggle,
}: {
  envEdits: Record<string, string>;
  loading: boolean;
  platforms: HermesMessagingPlatformInfo[] | null;
  query: string;
  saving: string | null;
  selectedPlatformId?: string;
  onEditEnv: (key: string, value: string) => void;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
  onSaveEnv: (platform: HermesMessagingPlatformInfo) => void;
  onSelectPlatform: (platform: HermesMessagingPlatformInfo) => void;
  /** Returns from a platform's configuration to the platform list. */
  onBack?: () => void;
  onToggle: (platform: HermesMessagingPlatformInfo, enabled: boolean) => void;
}) {
  const q = query.trim().toLowerCase();
  const visible = (platforms ?? [])
    .filter((platform) => capabilityMatches(platform, q))
    .sort((a, b) => safeText(a.name).localeCompare(safeText(b.name)));
  // Selection is a drill-in: no platform is open until the user picks one.
  const selected = (platforms ?? []).find((platform) => platform.id === selectedPlatformId) ?? null;

  if (selected) {
    return (
      <section className="agent-management-panel" aria-label="Messaging platforms">
        <div className="agent-platform-topbar">
          <button
            type="button"
            className="icon-button"
            aria-label="Back to messaging platforms"
            onClick={onBack}
          >
            <IconChevronLeftSmall size={14} ariaHidden />
          </button>
          <span className="agent-platform-topbar-title">{selected.name}</span>
        </div>
        <MessagingPlatformDetail
          envEdits={envEdits}
          platform={selected}
          saving={saving}
          onEditEnv={onEditEnv}
          onSaveEnv={onSaveEnv}
          onToggle={onToggle}
        />
      </section>
    );
  }

  return (
    <section className="agent-management-panel" aria-label="Messaging platforms">
      <ManagementToolbar
        loading={loading}
        placeholder="Search messaging platforms"
        query={query}
        onQueryChange={onQueryChange}
        onRefresh={onRefresh}
      />
      {loading && !platforms ? (
        <div className="agent-loading">
          <Spinner />
        </div>
      ) : (
        <div className="agent-messaging-list" aria-label="Messaging channels">
          <CapabilityGroup
            title="Platforms"
            count={visible.length}
            empty="No matching platforms"
            hideTitle
          >
            {visible.map((platform) => {
              const envVars = platform.envVars ?? platform.env_vars ?? [];
              const requiredSet = envVars.filter(
                (field) => field.required && envFieldSet(field),
              ).length;
              const requiredTotal = envVars.filter((field) => field.required).length;
              const state = platform.state ?? "unknown";
              const enabled = Boolean(platform.enabled);
              const configured =
                platform.configured || (requiredTotal > 0 && requiredSet === requiredTotal);
              // The switch already conveys enabled/disabled and the count badge
              // by the name owns the required-field progress, so the meta line
              // keeps only meaningful status (e.g. Connected). The "Not
              // configured" pill by the switch shows only for an enabled but
              // unconfigured platform.
              return (
                <CapabilityRow
                  key={platform.id}
                  title={platform.name}
                  description={platform.description}
                  count={requiredTotal ? `${requiredSet}/${requiredTotal}` : undefined}
                  enabled={enabled}
                  notConfigured={enabled && !configured}
                  selected={false}
                  saving={saving === `messaging:${platform.id}`}
                  onSelect={() => onSelectPlatform(platform)}
                  onToggle={(enabled) => onToggle(platform, enabled)}
                />
              );
            })}
          </CapabilityGroup>
        </div>
      )}
    </section>
  );
}

export function FilesystemPanel({
  loading,
  query,
  snapshot,
  onQueryChange,
  onRefresh,
}: {
  loading: boolean;
  query: string;
  snapshot: HermesFilesystemSnapshot | null;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
}) {
  const q = query.trim().toLowerCase();
  const roots = (snapshot?.roots ?? [])
    .map((root) => ({
      ...root,
      entries: filterFilesystemEntries(root.entries, q),
    }))
    .filter(
      (root) =>
        !q ||
        includesQuery(root.label, q) ||
        includesQuery(root.path, q) ||
        root.entries.length > 0,
    );

  return (
    <section className="agent-management-panel" aria-label="Agent filesystem">
      <ManagementToolbar
        loading={loading}
        placeholder="Search workspace and memory"
        query={query}
        onQueryChange={onQueryChange}
        onRefresh={onRefresh}
      />
      {loading && !snapshot ? (
        <div className="agent-loading">
          <Spinner />
        </div>
      ) : roots.length ? (
        <div className="agent-management-scroll">
          {roots.map((root) => (
            <section key={root.id} className="agent-files-root">
              <header>
                <div>
                  <h3 className="agent-files-root-title">{root.label}</h3>
                  <p>{root.description}</p>
                </div>
                <button
                  type="button"
                  className="agent-files-root-path"
                  title={`Reveal ${root.label} in Finder`}
                  onClick={() => void revealPath(root.path)}
                >
                  <code>{compactPath(root.path)}</code>
                </button>
              </header>
              <div className="agent-files-body">
                {root.entries.length ? (
                  <div className="agent-files-tree">
                    {root.entries.map((entry) => (
                      <FilesystemEntryRow key={entry.path} entry={entry} level={0} />
                    ))}
                  </div>
                ) : (
                  <p className="agent-capability-empty">No visible entries</p>
                )}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="agent-loading">
          <EmptyState
            icon={<IconFolders size={24} />}
            title="No files"
            description="No matching agent files were found."
          />
        </div>
      )}
    </section>
  );
}

function FilesystemEntryRow({ entry, level }: { entry: HermesFilesystemEntry; level: number }) {
  const isDirectory = entry.kind === "directory";
  const children = entry.children ?? [];
  return (
    <div className="agent-files-entry-group">
      <div className="agent-files-entry" style={{ "--agent-file-depth": level } as CSSProperties}>
        <span className="agent-files-entry-icon" aria-hidden="true">
          {isDirectory ? <IconFolder1 size={14} /> : <FileTypeIcon name={entry.name} size={14} />}
        </span>
        <span className="agent-files-entry-name">{entry.name}</span>
        <span className="agent-files-entry-meta">
          {isDirectory ? "Folder" : formatBytes(entry.size)}
          {entry.modifiedAt ? ` · ${relativeDate(entry.modifiedAt)}` : ""}
        </span>
        {/* Reveal-in-Finder: an interactive icon-button shown on row hover/focus
         * that opens the entry's absolute path in the OS file manager. Hidden
         * for any entry the snapshot reports without an absolute path. */}
        {isAbsolutePath(entry.path) ? (
          <button
            type="button"
            className="icon-button agent-files-entry-reveal"
            title="Reveal in Finder"
            aria-label={`Reveal ${entry.name} in Finder`}
            onClick={() => void revealPath(entry.path)}
          >
            <IconFinder size={13} ariaHidden />
          </button>
        ) : null}
      </div>
      {children.length ? (
        <div className="agent-files-children">
          {children.map((child) => (
            <FilesystemEntryRow key={child.path} entry={child} level={level + 1} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function MessagingPlatformDetail({
  envEdits,
  platform,
  saving,
  hideFooter,
  onEditEnv,
  onSaveEnv,
  onToggle,
}: {
  envEdits: Record<string, string>;
  platform: HermesMessagingPlatformInfo | null;
  saving: string | null;
  /** When the host renders the Save / enable actions itself (e.g. in the pinned
   * breadcrumb bar of the settings drill-in), suppress this component's own
   * footer so the actions aren't duplicated. */
  hideFooter?: boolean;
  onEditEnv: (key: string, value: string) => void;
  onSaveEnv: (platform: HermesMessagingPlatformInfo) => void;
  onToggle: (platform: HermesMessagingPlatformInfo, enabled: boolean) => void;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  if (!platform) {
    return (
      <div className="agent-messaging-detail">
        <EmptyState
          icon={<IconBubbleWide size={24} />}
          title="No messaging platform"
          description="No matching Hermes messaging platform is available."
        />
      </div>
    );
  }
  const envVars = platform.envVars ?? platform.env_vars ?? [];
  const required = envVars.filter((field) => field.required);
  const recommended = envVars.filter((field) => !field.required && !field.advanced);
  const advanced = envVars.filter((field) => !field.required && field.advanced);
  const hasEdits = Object.values(messagingTrimEdits(envEdits)).length > 0;
  const docsUrl = platform.docsUrl ?? platform.docs_url;
  const isSavingEnv = saving === `env:${platform.id}`;

  return (
    <div className="agent-messaging-detail">
      <div className="agent-messaging-detail-scroll">
        <header className="agent-messaging-detail-header">
          <h3>{platform.name}</h3>
          <p>{platform.description}</p>
          {docsUrl ? (
            <a className="agent-platform-docs" href={docsUrl} rel="noreferrer" target="_blank">
              Setup guide
              <IconArrowUpRight size={12} ariaHidden />
            </a>
          ) : null}
          <div className="agent-platform-pills">
            <span>{stateLabel(platform.state ?? "unknown")}</span>
            <span>{platform.configured ? "Credentials set" : "Needs setup"}</span>
            {platform.gatewayRunning || platform.gateway_running ? null : (
              <span>Messaging gateway stopped</span>
            )}
          </div>
        </header>
        {platform.errorMessage || platform.error_message ? (
          <div className="agent-platform-error">
            {platform.errorMessage ?? platform.error_message}
          </div>
        ) : null}
        <MessagingFieldGroup
          title="Required"
          fields={required}
          edits={envEdits}
          saving={saving}
          onEditEnv={onEditEnv}
        />
        <MessagingFieldGroup
          title="Recommended"
          fields={recommended}
          edits={envEdits}
          saving={saving}
          onEditEnv={onEditEnv}
        />
        {advanced.length ? (
          <section className="agent-messaging-fields">
            <button
              type="button"
              className="agent-advanced-toggle"
              aria-expanded={showAdvanced}
              onClick={() => setShowAdvanced((value) => !value)}
            >
              <span>Advanced</span>
              <span className="status-pill">{advanced.length}</span>
              <IconChevronDownSmall
                size={14}
                aria-hidden
                className="agent-advanced-toggle-chevron"
                data-open={showAdvanced || undefined}
              />
            </button>
            {showAdvanced ? (
              <MessagingFieldGroup
                title=""
                fields={advanced}
                edits={envEdits}
                saving={saving}
                onEditEnv={onEditEnv}
              />
            ) : null}
          </section>
        ) : null}
      </div>
      {hideFooter ? null : (
        <footer className="agent-messaging-footer">
          <button
            type="button"
            className="agent-messaging-enable"
            disabled={saving === `messaging:${platform.id}`}
            onClick={() => onToggle(platform, !platform.enabled)}
          >
            {platform.enabled ? "Enabled" : "Disabled"}
          </button>
          <button
            type="button"
            disabled={!hasEdits || isSavingEnv}
            onClick={() => onSaveEnv(platform)}
          >
            {isSavingEnv ? "Saving..." : "Save changes"}
          </button>
        </footer>
      )}
    </div>
  );
}

export function MessagingFieldGroup({
  edits,
  fields,
  saving,
  title,
  onEditEnv,
}: {
  edits: Record<string, string>;
  fields: HermesMessagingEnvVarInfo[];
  saving: string | null;
  title: string;
  onEditEnv: (key: string, value: string) => void;
}) {
  if (!fields.length) {
    return null;
  }
  return (
    <section className="agent-messaging-fields">
      {title ? <h4>{title}</h4> : null}
      {fields.map((field) => (
        <label key={field.key} className="agent-messaging-field">
          <span>
            {fieldLabel(field)}
            {envFieldSet(field) ? <strong>Saved</strong> : null}
          </span>
          <input
            type={field.isPassword || field.is_password ? "password" : "text"}
            value={edits[field.key] ?? ""}
            disabled={saving === `env:${field.key}`}
            placeholder={
              envFieldSet(field)
                ? (field.redactedValue ?? field.redacted_value ?? "Replace current value")
                : (field.prompt ?? field.key)
            }
            onChange={(event) => onEditEnv(field.key, event.currentTarget.value)}
          />
          {field.description ? <small>{field.description}</small> : null}
        </label>
      ))}
    </section>
  );
}
