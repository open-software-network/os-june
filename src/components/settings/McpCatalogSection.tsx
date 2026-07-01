import { IconArrowInbox } from "central-icons/IconArrowInbox";
import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconArrowUpRight } from "central-icons/IconArrowUpRight";
import { IconCircleCheck } from "central-icons/IconCircleCheck";
import { IconCircleInfo } from "central-icons/IconCircleInfo";
import { IconCrossMedium } from "central-icons/IconCrossMedium";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconPlugin2 } from "central-icons/IconPlugin2";
import { IconShield } from "central-icons/IconShield";
import { IconShieldCheck } from "central-icons/IconShieldCheck";
import { useEffect, useMemo, useState } from "react";
import {
  catalogAuthMeta,
  catalogStatusMeta,
  catalogStatusOf,
  catalogTransportMeta,
  classifyEntryRisk,
  emptyInstallDraft,
  envRequirementsFor,
  filterCatalog,
  inlineSecurityLabels,
  installConfirmationFor,
  isLocalSubprocessEntry,
  needsAuthHandoff,
  needsCredentials,
  securityLabelsForEntry,
  validateInstallDraft,
  useMcpCatalog,
  type HermesAdminMode,
  type HermesMcpCatalogEntry,
  type McpCatalogInstallState,
  type McpCatalogState,
  type McpInstallDraft,
} from "../../lib/hermes-admin";
import { AdminNotifications } from "./AdminNotifications";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Dialog } from "../ui/Dialog";

type McpCatalogSectionProps = {
  /** The write-access mode whose runtime this page targets. Defaults to the safe
   * sandboxed runtime; the host can point it at Full mode explicitly. */
  mode?: HermesAdminMode;
};

/**
 * June's native MCP catalog browser (spec 15). Lists the Nous-approved MCP
 * catalog for the targeted profile, inspects an entry, and installs it (which
 * adds an MCP server to the inventory) through the typed `hermes-admin` client,
 * the shared cache (so a successful install refreshes the MCP servers page), and
 * the gateway lifecycle (so the apply-timing copy is honest: catalog installs are
 * "restart required").
 *
 * Per-entry the UI shows name, description, transport + local-subprocess /
 * remote-HTTP risk, the auth requirement (API key / OAuth / third-party / none),
 * whether it is already installed (and enabled), and its default tools. Install
 * prompts inline for any required env values with masked inputs and never logs
 * them; for an OAuth / third-party entry it explains the sign-in still has to
 * happen (feature 17) rather than pretending install is complete.
 */
export function McpCatalogSection({
  mode = "sandboxed",
}: McpCatalogSectionProps) {
  const state = useMcpCatalog(mode);
  return <McpCatalogView state={state} mode={mode} />;
}

/**
 * The render-only view, split out so component tests can drive it with a stubbed
 * {@link McpCatalogState} (no Tauri, no network) and assert search / inspect /
 * install wiring. Owns only the local query + inspect + install-dialog state.
 */
export function McpCatalogView({
  state,
  mode = "sandboxed",
}: {
  state: McpCatalogState;
  mode?: HermesAdminMode;
}) {
  const [query, setQuery] = useState("");
  const [inspecting, setInspecting] = useState<string>();
  const [installing, setInstalling] = useState<string>();
  // A high-risk install is gated behind a confirmation before the credential /
  // direct-install path runs. This holds the entry awaiting that confirmation.
  const [toConfirm, setToConfirm] = useState<string>();

  const visible = useMemo(
    () => filterCatalog(state.entries, query),
    [state.entries, query],
  );

  const inspected = inspecting
    ? state.entries.find((entry) => entry.installName === inspecting)
    : undefined;
  const toInstall = installing
    ? state.entries.find((entry) => entry.installName === installing)
    : undefined;
  const confirmEntry = toConfirm
    ? state.entries.find((entry) => entry.installName === toConfirm)
    : undefined;

  const isUnavailable = state.status === "unavailable";
  const isLoadingFirst = state.status === "loading";
  const isErrored = state.status === "error";
  const hasEntries = state.entries.length > 0;

  /** Routes an install: a high-risk entry first asks for confirmation (a WARNING
   * gate, never a block); an entry that needs credentials opens the install
   * dialog; otherwise it installs straight away with no extra env. */
  function startInstall(entry: HermesMcpCatalogEntry) {
    if (classifyEntryRisk(entry).requiresConfirmation) {
      setToConfirm(entry.installName);
      return;
    }
    proceedInstall(entry);
  }

  /** The install path after any confirmation: credentials dialog or direct
   * install. */
  function proceedInstall(entry: HermesMcpCatalogEntry) {
    if (needsCredentials(entry)) {
      setInstalling(entry.installName);
      return;
    }
    const result = validateInstallDraft(entry, emptyInstallDraft(entry));
    if (result.ok) state.install(entry, result.payload);
  }

  return (
    <section
      className="settings-group mcp-servers mcp-catalog"
      aria-labelledby="mcp-catalog-heading"
    >
      <h2 id="mcp-catalog-heading" className="settings-group-heading">
        MCP catalog
      </h2>
      <p className="settings-group-description">
        Browse the Nous-approved catalog and install a server in one step.
        Installs add an MCP server. Changes apply after the Hermes gateway
        restarts.{" "}
        <ModeNote
          mode={state.mode ?? mode}
          profile={state.profile}
          show={!isUnavailable}
        />
      </p>

      <LifecycleBanner state={state} />
      <AdminNotifications
        notifications={state.notifications}
        onDismiss={state.dismissNotification}
      />

      <div className="settings-card mcp-servers-card">
        <div className="mcp-servers-toolbar">
          <div className="mcp-servers-search">
            <IconMagnifyingGlass
              size={15}
              ariaHidden
              className="mcp-servers-search-icon"
            />
            <input
              type="search"
              value={query}
              placeholder="Filter catalog"
              aria-label="Filter MCP catalog"
              disabled={isUnavailable}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </div>
          <button
            type="button"
            className="mcp-servers-refresh"
            disabled={isUnavailable || isLoadingFirst}
            onClick={state.refresh}
          >
            <IconArrowRotateClockwise size={14} ariaHidden />
            Refresh
          </button>
        </div>

        {state.error && hasEntries ? (
          <p className="settings-row-error mcp-servers-inline-error">
            <IconExclamationCircle size={14} ariaHidden />
            {state.error}
          </p>
        ) : null}

        <div className="mcp-servers-body">
          {isUnavailable ? (
            <EmptyState
              title="Hermes is not running"
              description="Start Hermes to browse and install MCP servers from the catalog."
            />
          ) : isErrored ? (
            <ErrorState
              message={state.error ?? "Could not load the MCP catalog."}
              retryable={state.retryable}
              onRetry={state.refresh}
            />
          ) : isLoadingFirst ? (
            <CatalogLoading />
          ) : !hasEntries ? (
            <EmptyState
              title="No catalog entries"
              description="The catalog returned no entries for this profile."
            />
          ) : visible.length === 0 ? (
            <EmptyState
              title="No matching entries"
              description="No catalog entry matches your search. Try a different term."
            />
          ) : (
            <ul className="mcp-servers-list">
              {visible.map((entry) => (
                <CatalogRow
                  key={entry.installName}
                  entry={entry}
                  install={state.installs.get(entry.installName)}
                  onInspect={() => setInspecting(entry.installName)}
                  onInstall={() => startInstall(entry)}
                  onClearInstall={() => state.clearInstall(entry.installName)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      {inspected ? (
        <InspectDrawer
          entry={inspected}
          install={state.installs.get(inspected.installName)}
          onClose={() => setInspecting(undefined)}
          onInstall={() => {
            setInspecting(undefined);
            startInstall(inspected);
          }}
          onClearInstall={() => state.clearInstall(inspected.installName)}
        />
      ) : null}

      <InstallDialog
        entry={toInstall}
        onClose={() => setInstalling(undefined)}
        onInstall={(entry, payload) => {
          state.install(entry, payload);
          setInstalling(undefined);
        }}
      />

      <ConfirmInstallDialog
        entry={confirmEntry}
        onClose={() => setToConfirm(undefined)}
        onConfirm={() => {
          const entry = confirmEntry;
          setToConfirm(undefined);
          if (entry) proceedInstall(entry);
        }}
      />
    </section>
  );
}

/** The sandbox/full-mode + profile context line. */
function ModeNote({
  mode,
  profile,
  show,
}: {
  mode: HermesAdminMode;
  profile?: string;
  show: boolean;
}) {
  if (!show) return null;
  const modeLabel = mode === "unrestricted" ? "Full mode" : "Sandboxed";
  return (
    <span className="mcp-servers-mode-note">
      Installing into the {modeLabel} runtime
      {profile ? ` (profile ${profile})` : ""}.
    </span>
  );
}

/** The shared gateway-lifecycle banner. Catalog installs are restart-required,
 * so this surfaces the restart state once an install lands. */
function LifecycleBanner({ state }: { state: McpCatalogState }) {
  const snapshot = state.lifecycle;
  if (state.status === "unavailable") return null;
  if (snapshot.state === "clean") return null;
  const tone =
    snapshot.state === "restart-failed"
      ? "destructive"
      : snapshot.state === "gateway-restart-required" ||
          snapshot.state === "active-session-should-restart"
        ? "warning"
        : "info";
  return (
    <div className="mcp-servers-lifecycle" data-tone={tone} role="status">
      <span className="mcp-servers-lifecycle-eyebrow">
        <IconCircleInfo size={15} ariaHidden />
        {snapshot.label}
      </span>
      <span className="mcp-servers-lifecycle-body">{snapshot.detail}</span>
    </div>
  );
}

/** One catalog entry row: name + transport/risk/auth pills, status, description,
 * an inspect button, and the install action (which becomes a progress / done /
 * failed state). */
function CatalogRow({
  entry,
  install,
  onInspect,
  onInstall,
  onClearInstall,
}: {
  entry: HermesMcpCatalogEntry;
  install?: McpCatalogInstallState;
  onInspect: () => void;
  onInstall: () => void;
  onClearInstall: () => void;
}) {
  const transport = catalogTransportMeta(entry);
  const auth = catalogAuthMeta(entry.auth);
  const status = catalogStatusMeta(catalogStatusOf(entry));
  const labelId = `mcp-catalog-${cssId(entry.installName)}`;
  const securityLabels = inlineSecurityLabels(securityLabelsForEntry(entry));
  const risk = classifyEntryRisk(entry);

  return (
    <li className="mcp-server-row mcp-catalog-row">
      <div className="mcp-server-main">
        <div className="mcp-server-headline">
          <button
            type="button"
            className="mcp-server-name mcp-catalog-name"
            id={labelId}
            onClick={onInspect}
          >
            {entry.name}
          </button>
          <span className="mcp-server-transport" data-risk={transport.risk}>
            {transport.label}
          </span>
          <span className="mcp-server-risk" data-risk={transport.risk}>
            <IconShield size={12} ariaHidden />
            {transport.riskLabel}
          </span>
          <span className="mcp-server-auth" data-tone={auth.tone}>
            {auth.label}
          </span>
          <span className="mcp-catalog-status" data-tone={status.tone}>
            {status.status !== "available" ? (
              <IconCircleCheck size={12} ariaHidden />
            ) : null}
            {status.label}
          </span>
        </div>

        {entry.description ? (
          <p className="mcp-server-blurb">{entry.description}</p>
        ) : (
          <p className="mcp-server-blurb">{transport.blurb}</p>
        )}

        <CatalogSecurityLabels labels={securityLabels} />

        {risk.tier === "high" ? (
          <p className="mcp-server-risk-note" data-tier="high" role="note">
            <IconExclamationCircle size={13} ariaHidden />
            {risk.reasons[0]?.detail ??
              "This server can take high-impact actions."}
          </p>
        ) : null}

        <p className="mcp-catalog-trust">
          <IconShieldCheck size={12} ariaHidden />
          {entry.source
            ? `Nous-approved catalog (${entry.source})`
            : "Nous-approved catalog"}
        </p>
      </div>

      <div className="mcp-server-actions">
        <button
          type="button"
          className="mcp-server-test"
          aria-label={`Inspect ${entry.name}`}
          onClick={onInspect}
        >
          Inspect
        </button>
        <InstallControl
          entry={entry}
          install={install}
          onInstall={onInstall}
          onClearInstall={onClearInstall}
        />
      </div>
    </li>
  );
}

/** The install button + its progress / done / failed states. */
function InstallControl({
  entry,
  install,
  onInstall,
  onClearInstall,
}: {
  entry: HermesMcpCatalogEntry;
  install?: McpCatalogInstallState;
  onInstall: () => void;
  onClearInstall: () => void;
}) {
  const phase = install?.phase ?? "idle";

  if (phase === "installing") {
    const pct = install?.progress;
    return (
      <span className="skills-hub-install-progress" role="status">
        <span className="skills-hub-install-bar" aria-hidden>
          <span
            className="skills-hub-install-bar-fill"
            style={pct !== undefined ? { width: `${pct}%` } : undefined}
            data-indeterminate={pct === undefined || undefined}
          />
        </span>
        <span className="skills-hub-install-label">
          {install?.message ?? "Installing"}
          {pct !== undefined ? ` ${Math.round(pct)}%` : ""}
        </span>
      </span>
    );
  }

  if (phase === "done") {
    return (
      <span className="skills-hub-install-done" role="status">
        <IconCircleCheck size={14} ariaHidden />
        {install?.needsAuthHandoff
          ? "Installed. Sign in to finish"
          : "Restart to apply"}
      </span>
    );
  }

  if (phase === "failed") {
    return (
      <span className="skills-hub-install-failed">
        <span className="skills-hub-install-failed-text" role="alert">
          <IconExclamationCircle size={13} ariaHidden />
          {install?.error ?? "Install failed."}
        </span>
        <button
          type="button"
          className="skills-hub-install-retry"
          onClick={onInstall}
        >
          Try again
        </button>
        <button
          type="button"
          className="skills-hub-install-dismiss"
          aria-label="Dismiss install error"
          onClick={onClearInstall}
        >
          <IconCrossSmall size={12} ariaHidden />
        </button>
      </span>
    );
  }

  return (
    <button type="button" className="skills-hub-install" onClick={onInstall}>
      <IconArrowInbox size={14} ariaHidden />
      {entry.installed ? "Reinstall" : "Install"}
    </button>
  );
}

/** The detail drawer shown before install: full description, transport/risk,
 * auth requirement + what install will add, default tools, and trust/source. */
function InspectDrawer({
  entry,
  install,
  onClose,
  onInstall,
  onClearInstall,
}: {
  entry: HermesMcpCatalogEntry;
  install?: McpCatalogInstallState;
  onClose: () => void;
  onInstall: () => void;
  onClearInstall: () => void;
}) {
  const transport = catalogTransportMeta(entry);
  const auth = catalogAuthMeta(entry.auth);
  const status = catalogStatusMeta(catalogStatusOf(entry));
  const envRequirements = envRequirementsFor(entry);
  const local = isLocalSubprocessEntry(entry);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="skills-hub-drawer-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <aside
        className="skills-hub-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-catalog-drawer-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="skills-hub-drawer-header">
          <div className="skills-hub-drawer-title-row">
            <h3
              id="mcp-catalog-drawer-title"
              className="skills-hub-drawer-title"
            >
              {entry.name}
            </h3>
            <button
              type="button"
              className="skills-hub-drawer-close"
              aria-label="Close"
              onClick={onClose}
            >
              <IconCrossMedium size={16} ariaHidden />
            </button>
          </div>
          <div className="skills-hub-drawer-badges">
            <span className="mcp-server-transport" data-risk={transport.risk}>
              {transport.label}
            </span>
            <span className="mcp-server-auth" data-tone={auth.tone}>
              {auth.label}
            </span>
            <span className="mcp-catalog-status" data-tone={status.tone}>
              {status.label}
            </span>
          </div>
        </header>

        <div className="skills-hub-drawer-body">
          {entry.description ? (
            <p className="skills-hub-drawer-description">{entry.description}</p>
          ) : null}

          <p className="skills-hub-drawer-meta">{auth.blurb}</p>

          {local ? (
            <p className="skills-hub-drawer-note">
              <IconShield size={13} ariaHidden /> This runs a local subprocess
              and inherits June and Hermes sandbox constraints.
            </p>
          ) : null}

          {envRequirements.length > 0 ? (
            <div className="mcp-catalog-requirements">
              <p className="mcp-catalog-requirements-title">
                Install will ask for
              </p>
              <ul className="mcp-catalog-requirements-list">
                {envRequirements.map((requirement) => (
                  <li key={requirement.key}>
                    <span className="skills-hub-drawer-mono">
                      {requirement.key}
                    </span>
                    {requirement.label ? `: ${requirement.label}` : null}
                    {requirement.required === false ? " (optional)" : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {needsAuthHandoff(entry) ? (
            <p className="skills-hub-drawer-note">
              After install you sign in to finish connecting. June opens that
              flow in your browser.
            </p>
          ) : null}

          {entry.defaultTools && entry.defaultTools.length > 0 ? (
            <div className="mcp-catalog-tools">
              <p className="mcp-catalog-tools-title">Default tools</p>
              <ul className="mcp-server-test-tools">
                {entry.defaultTools.map((tool) => (
                  <li key={tool}>{tool}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {entry.source ? (
            <ul className="skills-hub-drawer-links">
              <li>
                <span className="skills-hub-drawer-link">
                  <IconArrowUpRight size={13} ariaHidden />
                  {entry.source}
                </span>
              </li>
            </ul>
          ) : null}

          <p className="mcp-catalog-trust">
            <IconShieldCheck size={12} ariaHidden />
            Nous-approved catalog
          </p>

          <details className="skills-hub-drawer-advanced">
            <summary>Advanced</summary>
            <dl className="skills-hub-drawer-advanced-list">
              <dt>Install identifier</dt>
              <dd className="skills-hub-drawer-mono">{entry.installName}</dd>
            </dl>
          </details>
        </div>

        <footer className="skills-hub-drawer-footer">
          <InstallControl
            entry={entry}
            install={install}
            onInstall={onInstall}
            onClearInstall={onClearInstall}
          />
        </footer>
      </aside>
    </div>
  );
}

/** The install dialog for entries that need credentials: one masked input per
 * required env value, an enable-after-install toggle note, and a submit that
 * validates and sends the install. Secrets stay in local state and ride only in
 * the install body. */
function InstallDialog({
  entry,
  onClose,
  onInstall,
}: {
  entry?: HermesMcpCatalogEntry;
  onClose: () => void;
  onInstall: (
    entry: HermesMcpCatalogEntry,
    payload: import("../../lib/hermes-admin").HermesInstallCatalogPayload,
  ) => void;
}) {
  const [draft, setDraft] = useState<McpInstallDraft>(() =>
    entry ? emptyInstallDraft(entry) : { enable: true, env: {} },
  );
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Reseed the draft whenever the target entry changes.
  useEffect(() => {
    if (entry) {
      setDraft(emptyInstallDraft(entry));
      setErrors({});
    }
  }, [entry]);

  if (!entry) return null;
  const requirements = envRequirementsFor(entry);

  function handleSubmit() {
    if (!entry) return;
    const result = validateInstallDraft(entry, draft);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    onInstall(entry, result.payload);
  }

  return (
    <Dialog
      open={Boolean(entry)}
      onClose={onClose}
      title={`Install ${entry.name}`}
      description="Enter the values this server needs to connect. They are sent securely and never shown again. It becomes available to new sessions after the Hermes gateway restarts."
      width={520}
      className="mcp-add-dialog"
      footer={
        <>
          <button type="button" className="primary-action" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-action primary-solid"
            onClick={handleSubmit}
          >
            Install
          </button>
        </>
      }
    >
      <div className="mcp-add-form">
        {requirements.map((requirement) => {
          const masked = requirement.secret !== false;
          return (
            <fieldset key={requirement.key} className="mcp-add-field">
              <label
                className="mcp-add-label"
                htmlFor={`mcp-catalog-env-${cssId(requirement.key)}`}
              >
                {requirement.label ?? requirement.key}
                {requirement.required === false ? " (optional)" : null}
              </label>
              <input
                id={`mcp-catalog-env-${cssId(requirement.key)}`}
                type={masked ? "password" : "text"}
                className="mcp-add-input"
                value={draft.env[requirement.key] ?? ""}
                placeholder={requirement.key}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(errors[requirement.key])}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setDraft((d) => ({
                    ...d,
                    env: { ...d.env, [requirement.key]: value },
                  }));
                }}
              />
              {errors[requirement.key] ? (
                <p className="mcp-add-error">{errors[requirement.key]}</p>
              ) : null}
            </fieldset>
          );
        })}

        <p className="mcp-add-note">
          <IconCircleInfo size={13} ariaHidden />
          Installing adds an MCP server. Its tools become available to new
          sessions after the Hermes gateway restarts.
        </p>
      </div>
    </Dialog>
  );
}

/** The security/sandbox-boundary labels a catalog entry will earn once
 * installed (local subprocess / remote server / OAuth / secret-backed / sandbox
 * constrained / unrestricted capable). Pure presentation; the derivation and
 * copy live in `mcp-security-view`. */
function CatalogSecurityLabels({
  labels,
}: {
  labels: ReturnType<typeof securityLabelsForEntry>;
}) {
  if (labels.length === 0) return null;
  return (
    <ul className="mcp-server-security-labels" aria-label="Security labels">
      {labels.map((entry) => (
        <li
          key={entry.code}
          className="mcp-server-security-label"
          data-code={entry.code}
          data-tone={entry.tone}
          title={entry.blurb}
        >
          <IconShield size={11} ariaHidden />
          {entry.label}
        </li>
      ))}
    </ul>
  );
}

/** The confirmation gate before installing a high-risk catalog entry. Leads with
 * the file-tools warning (the spec's exact copy for local servers), then lists
 * the matched reasons. This NEVER blocks: the user can always confirm. */
function ConfirmInstallDialog({
  entry,
  onClose,
  onConfirm,
}: {
  entry?: HermesMcpCatalogEntry;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const confirmation = entry ? installConfirmationFor(entry) : undefined;
  return (
    <ConfirmDialog
      open={Boolean(entry)}
      onClose={onClose}
      onConfirm={onConfirm}
      title={confirmation?.title ?? "Install server?"}
      description={
        confirmation ? (
          <span className="mcp-confirm-body">
            <span className="mcp-confirm-lead">{confirmation.lead}</span>
            {confirmation.reasons.map((reason, index) => (
              <span key={index} className="mcp-confirm-reason">
                {reason}
              </span>
            ))}
          </span>
        ) : undefined
      }
      confirmLabel="Install server"
    />
  );
}

function CatalogLoading() {
  return (
    <ul className="mcp-servers-list" aria-hidden>
      {[0, 1, 2].map((index) => (
        <li key={index} className="mcp-server-row mcp-server-skeleton">
          <div className="mcp-server-main">
            <span className="mcp-server-skeleton-line mcp-server-skeleton-title" />
            <span className="mcp-server-skeleton-line" />
          </div>
        </li>
      ))}
    </ul>
  );
}

function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mcp-servers-empty" role="status">
      <span className="mcp-servers-empty-icon" aria-hidden>
        <IconPlugin2 size={22} />
      </span>
      <p className="mcp-servers-empty-title">{title}</p>
      <p className="mcp-servers-empty-description">{description}</p>
    </div>
  );
}

function ErrorState({
  message,
  retryable,
  onRetry,
}: {
  message: string;
  retryable: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="mcp-servers-error" role="alert">
      <span className="mcp-servers-empty-icon" aria-hidden>
        <IconExclamationCircle size={22} />
      </span>
      <p className="mcp-servers-empty-title">Couldn't load the catalog</p>
      <p className="mcp-servers-empty-description">{message}</p>
      {retryable ? (
        <button type="button" className="mcp-servers-retry" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

/** A DOM-id-safe slug for `id` wiring. */
function cssId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}
