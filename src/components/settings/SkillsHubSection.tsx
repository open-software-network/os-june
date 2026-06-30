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
import { IconShieldCheck } from "central-icons/IconShieldCheck";
import { IconWarningSign } from "central-icons/IconWarningSign";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  buildSkillInstallReview,
  filterHubResults,
  isDirectUrlInstall,
  requiresInstallReview,
  sourceKindFor,
  sourceKindMeta,
  sourceKindsOf,
  trustMeta,
  useSkillsHub,
  type HermesAdminMode,
  type HermesHubSkillResult,
  type HubInstallDecision,
  type HubInstallState,
  type HubSourceKind,
  type SkillsHubState,
} from "../../lib/hermes-admin";
import { AdminNotifications } from "./AdminNotifications";
import {
  SkillInstallReviewDialog,
  type SkillInstallReviewDecision,
} from "./SkillInstallReviewDialog";

/** Sentinel for the "all sources" filter chip. */
const ALL_SOURCES = "__all__";

type SkillsHubSectionProps = {
  /** The write-access mode whose runtime this page targets. Defaults to the
   * safe sandboxed runtime; the host can point it at Full mode explicitly. */
  mode?: HermesAdminMode;
};

/**
 * June's native Skills Hub browser (spec 06). Searches the hub, filters by
 * source, inspects a skill in a detail drawer, and installs it as a background
 * action with live progress, all through the typed `hermes-admin` client, the
 * shared cache (so a successful install refreshes the Installed Skills page),
 * and the gateway lifecycle (so apply-timing copy is honest).
 *
 * The user never has to understand Hermes' raw source identifiers: cards show a
 * friendly source label and a trust badge, with the exact install identifier
 * kept in the detail drawer's advanced section for debugging.
 */
export function SkillsHubSection({
  mode = "sandboxed",
}: SkillsHubSectionProps) {
  const state = useSkillsHub(mode);
  return <SkillsHubView state={state} mode={mode} />;
}

/**
 * The render-only view, split out so component tests can drive it with a stubbed
 * {@link SkillsHubState} (no Tauri, no network) and assert search / filtering /
 * inspect / install wiring. Owns only the local query + source + drawer state.
 */
export function SkillsHubView({
  state,
  mode = "sandboxed",
}: {
  state: SkillsHubState;
  mode?: HermesAdminMode;
}) {
  const [query, setQuery] = useState("");
  const [sourceKind, setSourceKind] = useState<string>(ALL_SOURCES);
  const [inspecting, setInspecting] = useState<string>();
  // The skill currently being reviewed before install, plus the resolver the
  // install's `confirm` hook is awaiting. The dialog resolves the promise.
  const [pendingReview, setPendingReview] = useState<{
    result: HermesHubSkillResult;
    resolve: (decision: HubInstallDecision) => void;
  }>();
  const reviewMode = state.mode ?? mode;

  // Reflect the controller's echoed query into the input once results land, so
  // the box never drifts from what was searched.
  useEffect(() => {
    setQuery(state.query);
  }, [state.query]);

  const sourceKinds = useMemo(
    () => sourceKindsOf(state.results),
    [state.results],
  );
  const visible = useMemo(
    () =>
      filterHubResults(state.results, {
        sourceKind:
          sourceKind === ALL_SOURCES
            ? undefined
            : (sourceKind as HubSourceKind),
      }),
    [state.results, sourceKind],
  );

  // A source filter that vanished after a new search should not strand the row.
  const activeSource =
    sourceKind !== ALL_SOURCES &&
    !sourceKinds.includes(sourceKind as HubSourceKind)
      ? ALL_SOURCES
      : sourceKind;

  const inspected = inspecting
    ? state.results.find((result) => result.identifier === inspecting)
    : undefined;

  const isUnavailable = state.status === "unavailable";
  const isSearching = state.status === "searching";
  const isErrored = state.status === "error";
  const hasResults = state.results.length > 0;

  function runSearch(event: React.FormEvent) {
    event.preventDefault();
    state.search(query);
  }

  const installResult = useCallback(
    (result: HermesHubSkillResult) => {
      // Trusted installs (official/verified, no scan concern) go straight
      // through. Everything else routes through the spec-07 security review,
      // wired into the controller's `confirm` hook: the dialog resolves the
      // decision, and `force` is sent only when the user confirms an override.
      if (!requiresInstallReview(result)) {
        state.install(result);
        return;
      }
      state.install(result, {
        confirm: (target) =>
          new Promise<HubInstallDecision>((resolve) => {
            setPendingReview({ result: target, resolve });
          }),
      });
    },
    [state],
  );

  // Resolve the pending review with the dialog's decision and close it.
  const resolveReview = useCallback((decision: SkillInstallReviewDecision) => {
    setPendingReview((current) => {
      current?.resolve(decision);
      return undefined;
    });
  }, []);

  return (
    <section
      className="settings-group skills-hub"
      aria-labelledby="skills-hub-heading"
    >
      <h2 id="skills-hub-heading" className="settings-group-heading">
        Skills hub
      </h2>
      <p className="settings-group-description">
        Find and install skills for your sessions without leaving June. Installs
        apply to new sessions.{" "}
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

      <div className="settings-card skills-hub-card">
        <div className="skills-hub-toolbar">
          <form
            className="skills-hub-search"
            onSubmit={runSearch}
            role="search"
          >
            <IconMagnifyingGlass
              size={15}
              ariaHidden
              className="skills-hub-search-icon"
            />
            <input
              type="search"
              value={query}
              placeholder="Search the hub"
              aria-label="Search the Skills Hub"
              disabled={isUnavailable}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </form>
          <button
            type="button"
            className="skills-hub-refresh"
            disabled={isUnavailable || isSearching}
            onClick={state.refresh}
          >
            <IconArrowRotateClockwise size={14} ariaHidden />
            Refresh
          </button>
        </div>

        {sourceKinds.length > 1 && !isUnavailable ? (
          <div
            className="skills-hub-filters"
            role="group"
            aria-label="Filter by source"
          >
            <SourceChip
              label="All"
              count={state.results.length}
              active={activeSource === ALL_SOURCES}
              onSelect={() => setSourceKind(ALL_SOURCES)}
            />
            {sourceKinds.map((kind) => (
              <SourceChip
                key={kind}
                label={sourceKindMeta(kind).label}
                count={
                  state.results.filter(
                    (result) => sourceKindFor(result) === kind,
                  ).length
                }
                active={activeSource === kind}
                onSelect={() => setSourceKind(kind)}
              />
            ))}
          </div>
        ) : null}

        <div className="skills-hub-body">
          {isUnavailable ? (
            <EmptyState
              title="Hermes is not running"
              description="Start Hermes to browse and install skills from the hub."
            />
          ) : isErrored ? (
            <ErrorState
              message={state.error ?? "Could not search the hub."}
              retryable={state.retryable}
              onRetry={state.refresh}
            />
          ) : isSearching && !hasResults ? (
            <HubLoading />
          ) : !hasResults ? (
            <EmptyState
              title={state.query ? "No results" : "Search the hub"}
              description={
                state.query
                  ? "No hub skill matches your search. Try a different term."
                  : "Type a skill name or keyword to find skills to install."
              }
            />
          ) : visible.length === 0 ? (
            <EmptyState
              title="No matching source"
              description="No result matches the selected source. Clear the source filter."
            />
          ) : (
            <ul className="skills-hub-list" aria-busy={isSearching}>
              {visible.map((result) => (
                <HubResultCard
                  key={result.identifier}
                  result={result}
                  install={state.installs.get(result.identifier)}
                  onInspect={() => setInspecting(result.identifier)}
                  onInstall={() => installResult(result)}
                  onClearInstall={() => state.clearInstall(result.identifier)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      {inspected ? (
        <InspectDrawer
          result={inspected}
          install={state.installs.get(inspected.identifier)}
          onClose={() => setInspecting(undefined)}
          onInstall={() => installResult(inspected)}
          onClearInstall={() => state.clearInstall(inspected.identifier)}
        />
      ) : null}

      {pendingReview ? (
        <SkillInstallReviewDialog
          review={buildSkillInstallReview(pendingReview.result)}
          mode={reviewMode}
          onDecide={resolveReview}
        />
      ) : null}
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
    <span className="skills-hub-mode-note">
      Installing into the {modeLabel} runtime
      {profile ? ` (profile ${profile})` : ""}.
    </span>
  );
}

/** The shared gateway-lifecycle banner. Only shown when there is something to
 * say (a pending next-session change). Hub installs are next-session, so this
 * stays informational. */
function LifecycleBanner({ state }: { state: SkillsHubState }) {
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
    <div className="skills-hub-lifecycle" data-tone={tone} role="status">
      <span className="skills-hub-lifecycle-eyebrow">
        <IconCircleInfo size={15} ariaHidden />
        {snapshot.label}
      </span>
      <span className="skills-hub-lifecycle-body">{snapshot.detail}</span>
    </div>
  );
}

/** A source filter chip. */
function SourceChip({
  label,
  count,
  active,
  onSelect,
}: {
  label: string;
  count: number;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className="skills-hub-chip"
      aria-pressed={active}
      onClick={onSelect}
    >
      {label}
      <span className="skills-hub-chip-count">{count}</span>
    </button>
  );
}

/** One result card: name + source/trust badges, description, an inspect button,
 * and the install action (which becomes a progress/done/failed state). */
function HubResultCard({
  result,
  install,
  onInspect,
  onInstall,
  onClearInstall,
}: {
  result: HermesHubSkillResult;
  install?: HubInstallState;
  onInspect: () => void;
  onInstall: () => void;
  onClearInstall: () => void;
}) {
  const source = sourceKindMeta(sourceKindFor(result));
  const trust = trustMeta(result.trust);
  const labelId = `hub-skill-${cssId(result.identifier)}`;

  return (
    <li className="skills-hub-row">
      <div className="skills-hub-main">
        <div className="skills-hub-headline">
          <button
            type="button"
            className="skills-hub-name"
            id={labelId}
            onClick={onInspect}
          >
            {result.name}
          </button>
          <SourcePill kind={source.kind} label={source.label} />
          <TrustPill trust={result.trust} />
          {result.version ? (
            <span className="skills-hub-version">v{result.version}</span>
          ) : null}
          {result.installed ? (
            <span className="skills-hub-installed-tag">
              <IconCircleCheck size={12} ariaHidden />
              {result.updateAvailable ? "Update available" : "Installed"}
            </span>
          ) : null}
        </div>

        {result.description ? (
          <p className="skills-hub-description">{result.description}</p>
        ) : (
          <p className="skills-hub-description skills-hub-description-muted">
            {source.blurb}
          </p>
        )}

        {result.tags && result.tags.length > 0 ? (
          <div className="skills-hub-tags">
            {result.tags.slice(0, 4).map((tag) => (
              <span key={tag} className="skills-hub-tag">
                {tag}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="skills-hub-actions">
        <button
          type="button"
          className="skills-hub-inspect"
          aria-label={`Inspect ${result.name}`}
          onClick={onInspect}
        >
          Inspect
        </button>
        <InstallControl
          result={result}
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
  result,
  install,
  onInstall,
  onClearInstall,
}: {
  result: HermesHubSkillResult;
  install?: HubInstallState;
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
        Applies next session
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
      {result.installed
        ? result.updateAvailable
          ? "Update"
          : "Reinstall"
        : "Install"}
    </button>
  );
}

/** The detail/preview drawer shown before install: full description, trust
 * advisory, upstream URLs, and the exact install identifier in an advanced
 * section. */
function InspectDrawer({
  result,
  install,
  onClose,
  onInstall,
  onClearInstall,
}: {
  result: HermesHubSkillResult;
  install?: HubInstallState;
  onClose: () => void;
  onInstall: () => void;
  onClearInstall: () => void;
}) {
  const source = sourceKindMeta(sourceKindFor(result));
  const trust = trustMeta(result.trust);
  const directUrl = isDirectUrlInstall(result);

  // Close the drawer on Escape.
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
        aria-labelledby="skills-hub-drawer-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="skills-hub-drawer-header">
          <div className="skills-hub-drawer-title-row">
            <h3
              id="skills-hub-drawer-title"
              className="skills-hub-drawer-title"
            >
              {result.name}
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
            <SourcePill kind={source.kind} label={source.label} />
            <TrustPill trust={result.trust} />
            {result.version ? (
              <span className="skills-hub-version">v{result.version}</span>
            ) : null}
            {result.installed ? (
              <span className="skills-hub-installed-tag">
                <IconCircleCheck size={12} ariaHidden />
                {result.updateAvailable ? "Update available" : "Installed"}
              </span>
            ) : null}
          </div>
        </header>

        <div className="skills-hub-drawer-body">
          {result.description ? (
            <p className="skills-hub-drawer-description">
              {result.description}
            </p>
          ) : null}

          <div
            className="skills-hub-drawer-trust"
            data-tone={trust.tone}
            role="note"
          >
            <span className="skills-hub-drawer-trust-eyebrow">
              {trust.tone === "trusted" ? (
                <IconShieldCheck size={15} ariaHidden />
              ) : (
                <IconWarningSign size={15} ariaHidden />
              )}
              {trust.label}
            </span>
            <span className="skills-hub-drawer-trust-body">
              {trust.advisory}
            </span>
          </div>

          {directUrl ? (
            <p className="skills-hub-drawer-note">
              This installs a single SKILL.md file directly from a URL. June
              asks you to confirm before installing it because it has not been
              reviewed.
            </p>
          ) : null}

          {result.author ? (
            <p className="skills-hub-drawer-meta">By {result.author}</p>
          ) : null}

          {result.upstreamUrls && result.upstreamUrls.length > 0 ? (
            <ul className="skills-hub-drawer-links">
              {result.upstreamUrls.map((url) => (
                <li key={url}>
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="skills-hub-drawer-link"
                  >
                    <IconArrowUpRight size={13} ariaHidden />
                    {url}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}

          <details className="skills-hub-drawer-advanced">
            <summary>Advanced</summary>
            <dl className="skills-hub-drawer-advanced-list">
              <dt>Install identifier</dt>
              <dd className="skills-hub-drawer-mono">{result.identifier}</dd>
              {result.source ? (
                <>
                  <dt>Source</dt>
                  <dd className="skills-hub-drawer-mono">{result.source}</dd>
                </>
              ) : null}
            </dl>
          </details>
        </div>

        <footer className="skills-hub-drawer-footer">
          <InstallControl
            result={result}
            install={install}
            onInstall={onInstall}
            onClearInstall={onClearInstall}
          />
        </footer>
      </aside>
    </div>
  );
}

/** The colored source pill. */
function SourcePill({ kind, label }: { kind: HubSourceKind; label: string }) {
  return (
    <span className="skills-hub-source" data-source={kind}>
      {label}
    </span>
  );
}

/** The trust badge. */
function TrustPill({ trust }: { trust: HermesHubSkillResult["trust"] }) {
  const meta = trustMeta(trust);
  return (
    <span
      className="skills-hub-trust"
      data-tone={meta.tone}
      title={meta.advisory}
    >
      {meta.tone === "trusted" ? (
        <IconShieldCheck size={11} ariaHidden />
      ) : meta.tone === "caution" ? (
        <IconWarningSign size={11} ariaHidden />
      ) : null}
      {meta.label}
    </span>
  );
}

function HubLoading() {
  return (
    <div className="skills-hub-loading">
      <ul className="skills-hub-list" aria-hidden>
        {[0, 1, 2].map((index) => (
          <li key={index} className="skills-hub-row skills-hub-skeleton">
            <div className="skills-hub-main">
              <span className="skills-hub-skeleton-line skills-hub-skeleton-title" />
              <span className="skills-hub-skeleton-line" />
            </div>
          </li>
        ))}
      </ul>
      <p className="skills-hub-loading-note" role="status">
        Searching across skill sources. This can take a few seconds.
      </p>
    </div>
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
    <div className="skills-hub-empty" role="status">
      <span className="skills-hub-empty-icon" aria-hidden>
        <IconPlugin2 size={22} />
      </span>
      <p className="skills-hub-empty-title">{title}</p>
      <p className="skills-hub-empty-description">{description}</p>
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
    <div className="skills-hub-error" role="alert">
      <span className="skills-hub-empty-icon" aria-hidden>
        <IconExclamationCircle size={22} />
      </span>
      <p className="skills-hub-empty-title">Couldn't search the hub</p>
      <p className="skills-hub-empty-description">{message}</p>
      {retryable ? (
        <button type="button" className="skills-hub-retry" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

/** A DOM-id-safe slug of an identifier for `id` wiring. */
function cssId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}
