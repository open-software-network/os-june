import { IconArrowInbox } from "central-icons/IconArrowInbox";
import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconCircleCheck } from "central-icons/IconCircleCheck";
import { IconCircleInfo } from "central-icons/IconCircleInfo";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { IconGithub } from "central-icons/IconGithub";
import { IconKey1 } from "central-icons/IconKey1";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconShieldCheck } from "central-icons/IconShieldCheck";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { IconWarningSign } from "central-icons/IconWarningSign";
import { useEffect, useState } from "react";
import {
  DEFAULT_TAP_PATH,
  TAP_EXPLAINER,
  TAP_GITHUB_TOKEN_ENV,
  tapPathLabel,
  tapTrustMeta,
  useSkillTaps,
  type HermesAdminMode,
  type HermesHubSkillResult,
  type SkillTapsState,
  type TapInstallState,
} from "../../lib/hermes-admin";
import type { HermesSkillTapDto } from "../../lib/tauri";
import { AdminNotifications } from "./AdminNotifications";

type TeamTapsSectionProps = {
  /** The write-access mode whose runtime this page targets. Defaults to the safe
   * sandboxed runtime; the host can point it at Full mode explicitly. */
  mode?: HermesAdminMode;
  /** Sends the user to the skill setup / secrets surface to configure the
   * GITHUB_TOKEN for private taps and higher rate limits. The host wires this to
   * the secret-setup UI; when absent the section shows the guidance copy only. */
  onConfigureGithubToken?: () => void;
};

/**
 * June's native Team skill taps manager (admin surfaces spec 13). A tap is a
 * GitHub repository of reusable SKILL.md directories; this surface lists the
 * configured taps, adds one by `owner/repo` with an optional path override,
 * removes one, searches a selected tap's skills, and installs them by reusing the
 * Skills Hub install flow.
 *
 * Taps have no dashboard REST endpoints, so list/add/remove run through narrow
 * argument-safe Tauri bridge commands; search/install reuse the hub endpoints.
 * Trust is community by default (review before installing) unless Hermes marks a
 * tap trusted. Private/rate-limited taps are steered to the GITHUB_TOKEN setup.
 */
export function TeamTapsSection({
  mode = "sandboxed",
  onConfigureGithubToken,
}: TeamTapsSectionProps) {
  const state = useSkillTaps(mode);
  return (
    <TeamTapsView
      state={state}
      mode={mode}
      onConfigureGithubToken={onConfigureGithubToken}
    />
  );
}

/**
 * The render-only view, split out so component tests can drive it with a stubbed
 * {@link SkillTapsState} (no Tauri, no network) and assert list / add / remove /
 * search / install / token-setup wiring.
 */
export function TeamTapsView({
  state,
  mode = "sandboxed",
  onConfigureGithubToken,
}: {
  state: SkillTapsState;
  mode?: HermesAdminMode;
  onConfigureGithubToken?: () => void;
}) {
  const [repo, setRepo] = useState("");
  const [path, setPath] = useState("");
  const [touched, setTouched] = useState(false);

  const isUnavailable = state.status === "unavailable";
  const isLoading = state.status === "loading";

  const repoError = touched ? state.validateRepo(repo) : null;
  const pathError = touched ? state.validatePath(path) : null;
  const canSubmit =
    !isUnavailable &&
    repo.trim().length > 0 &&
    !state.validateRepo(repo) &&
    !state.validatePath(path) &&
    !state.pending.has(repo.trim());

  function submitAdd(event: React.FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (state.validateRepo(repo) || state.validatePath(path)) return;
    void state.addTap(repo, path).then(() => {
      // Clear the inputs only when the add did not surface an error.
      setRepo("");
      setPath("");
      setTouched(false);
    });
  }

  return (
    <section
      className="settings-group team-taps"
      aria-labelledby="team-taps-heading"
    >
      <h2 id="team-taps-heading" className="settings-group-heading">
        Team skill taps
      </h2>
      <p className="settings-group-description">
        {TAP_EXPLAINER}{" "}
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

      {state.needsGithubToken ? (
        <GithubTokenCallout onConfigure={onConfigureGithubToken} />
      ) : null}

      <div className="settings-card team-taps-card">
        <form className="team-taps-add" onSubmit={submitAdd}>
          <div className="team-taps-add-fields">
            <label className="team-taps-field">
              <span className="team-taps-field-label">Repository</span>
              <span className="team-taps-input-wrap">
                <IconGithub
                  size={15}
                  ariaHidden
                  className="team-taps-input-icon"
                />
                <input
                  type="text"
                  value={repo}
                  placeholder="owner/repo"
                  aria-label="Tap repository as owner/repo"
                  aria-invalid={repoError ? true : undefined}
                  disabled={isUnavailable}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(event) => {
                    setRepo(event.currentTarget.value);
                    setTouched(true);
                  }}
                />
              </span>
            </label>
            <label className="team-taps-field">
              <span className="team-taps-field-label">Path (optional)</span>
              <input
                type="text"
                value={path}
                placeholder={DEFAULT_TAP_PATH}
                aria-label="Path override inside the repository"
                aria-invalid={pathError ? true : undefined}
                disabled={isUnavailable}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) => {
                  setPath(event.currentTarget.value);
                  setTouched(true);
                }}
              />
            </label>
            <button
              type="submit"
              className="team-taps-add-button"
              disabled={!canSubmit}
            >
              <IconPlusMedium size={14} ariaHidden />
              Add tap
            </button>
          </div>
          {repoError ? (
            <p className="team-taps-field-error" role="alert">
              {repoError}
            </p>
          ) : null}
          {pathError ? (
            <p className="team-taps-field-error" role="alert">
              {pathError}
            </p>
          ) : null}
          <p className="team-taps-add-hint">
            Skills are read from {DEFAULT_TAP_PATH} unless you set a path.
            Private taps and higher GitHub rate limits use a{" "}
            {TAP_GITHUB_TOKEN_ENV}.
          </p>
        </form>

        <div className="team-taps-toolbar">
          <button
            type="button"
            className="team-taps-refresh"
            disabled={isUnavailable || isLoading}
            onClick={state.refresh}
          >
            <IconArrowRotateClockwise size={14} ariaHidden />
            Refresh
          </button>
        </div>

        {state.error && !state.needsGithubToken ? (
          <p className="team-taps-error" role="alert">
            <IconExclamationCircle size={13} ariaHidden />
            {state.error}
          </p>
        ) : null}

        <div className="team-taps-body">
          {isUnavailable ? (
            <EmptyState
              title="Hermes is not running"
              description="Start Hermes to manage your team's skill taps."
            />
          ) : isLoading && state.taps.length === 0 ? (
            <p className="team-taps-loading" role="status">
              Loading taps
            </p>
          ) : state.taps.length === 0 ? (
            <EmptyState
              title="No taps configured"
              description="Add a GitHub repository above to share team runbooks, deployment procedures, and workflows."
            />
          ) : (
            <ul className="team-taps-list">
              {state.taps.map((tap) => (
                <TapRow
                  key={tap.repo}
                  tap={tap}
                  pending={state.pending.has(tap.repo)}
                  selected={state.search.repo === tap.repo}
                  onSearch={() => state.searchTap(tap.repo)}
                  onRemove={() => void state.removeTap(tap.repo)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      {state.search.repo ? (
        <TapSearchPanel
          state={state}
          onConfigureGithubToken={onConfigureGithubToken}
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
    <span className="team-taps-mode-note">
      Managing taps for the {modeLabel} runtime
      {profile ? ` (profile ${profile})` : ""}.
    </span>
  );
}

/** The shared gateway-lifecycle banner. Tap changes are next-session. */
function LifecycleBanner({ state }: { state: SkillTapsState }) {
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
    <div className="team-taps-lifecycle" data-tone={tone} role="status">
      <span className="team-taps-lifecycle-eyebrow">
        <IconCircleInfo size={15} ariaHidden />
        {snapshot.label}
      </span>
      <span className="team-taps-lifecycle-body">{snapshot.detail}</span>
    </div>
  );
}

/** The GitHub token setup callout, shown when a tap call hit a rate-limit / auth
 * problem. Steers the user to the secret-setup UI for the GITHUB_TOKEN. */
function GithubTokenCallout({ onConfigure }: { onConfigure?: () => void }) {
  return (
    <div className="team-taps-token-callout" data-tone="warning" role="status">
      <span className="team-taps-token-eyebrow">
        <IconKey1 size={15} ariaHidden />
        GitHub access needed
      </span>
      <p className="team-taps-token-body">
        This tap is private or GitHub rate-limited the request. Add a{" "}
        {TAP_GITHUB_TOKEN_ENV} to reach private repositories and raise the rate
        limit. Your token is stored as a secret and never shown again.
      </p>
      {onConfigure ? (
        <button
          type="button"
          className="team-taps-token-button"
          onClick={onConfigure}
        >
          Configure {TAP_GITHUB_TOKEN_ENV}
        </button>
      ) : null}
    </div>
  );
}

/** One configured tap: repo, path, trust badge, and search / remove actions. */
function TapRow({
  tap,
  pending,
  selected,
  onSearch,
  onRemove,
}: {
  tap: HermesSkillTapDto;
  pending: boolean;
  selected: boolean;
  onSearch: () => void;
  onRemove: () => void;
}) {
  const trust = tapTrustMeta(tap);
  return (
    <li className="team-taps-row" data-selected={selected || undefined}>
      <div className="team-taps-row-main">
        <div className="team-taps-row-headline">
          <IconGithub size={14} ariaHidden className="team-taps-row-icon" />
          <span className="team-taps-row-repo">{tap.repo}</span>
          <TrustPill trust={trust} />
        </div>
        <span className="team-taps-row-path">
          Reads from {tapPathLabel(tap)}
        </span>
      </div>
      <div className="team-taps-row-actions">
        <button
          type="button"
          className="team-taps-row-search"
          onClick={onSearch}
          aria-label={`Browse skills in ${tap.repo}`}
        >
          <IconMagnifyingGlass size={13} ariaHidden />
          Browse skills
        </button>
        <button
          type="button"
          className="team-taps-row-remove"
          onClick={onRemove}
          disabled={pending}
          aria-label={`Remove ${tap.repo}`}
        >
          <IconTrashCan size={13} ariaHidden />
          Remove
        </button>
      </div>
    </li>
  );
}

/** The search-within-a-tap panel: searches and installs the selected tap's
 * skills, reusing the hub install flow. */
function TapSearchPanel({
  state,
  onConfigureGithubToken,
}: {
  state: SkillTapsState;
  onConfigureGithubToken?: () => void;
}) {
  const { search } = state;
  const repo = search.repo ?? "";
  const [query, setQuery] = useState(search.query);

  useEffect(() => {
    setQuery(search.query);
  }, [search.query, search.repo]);

  function runSearch(event: React.FormEvent) {
    event.preventDefault();
    state.searchTap(repo, query);
  }

  const isSearching = search.status === "searching";
  const isErrored = search.status === "error";
  const hasResults = search.results.length > 0;

  return (
    <div className="settings-card team-taps-search-card">
      <div className="team-taps-search-header">
        <h3 className="team-taps-search-title">
          Skills in <span className="team-taps-search-repo">{repo}</span>
        </h3>
        <button
          type="button"
          className="team-taps-search-close"
          aria-label="Close tap search"
          onClick={state.clearSearch}
        >
          <IconCrossSmall size={13} ariaHidden />
        </button>
      </div>

      <form
        className="team-taps-search-form"
        onSubmit={runSearch}
        role="search"
      >
        <IconMagnifyingGlass
          size={15}
          ariaHidden
          className="team-taps-search-icon"
        />
        <input
          type="search"
          value={query}
          placeholder="Search this tap"
          aria-label={`Search skills in ${repo}`}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </form>

      <div className="team-taps-search-body">
        {isErrored ? (
          <div className="team-taps-search-error" role="alert">
            <p>{search.error ?? "Could not search this tap."}</p>
            {onConfigureGithubToken ? (
              <button
                type="button"
                className="team-taps-token-button"
                onClick={onConfigureGithubToken}
              >
                Configure {TAP_GITHUB_TOKEN_ENV}
              </button>
            ) : null}
            {search.retryable ? (
              <button
                type="button"
                className="team-taps-search-retry"
                onClick={state.refreshSearch}
              >
                Try again
              </button>
            ) : null}
          </div>
        ) : isSearching && !hasResults ? (
          <p className="team-taps-loading" role="status">
            Searching
          </p>
        ) : !hasResults ? (
          <p className="team-taps-search-empty" role="status">
            No skills found in this tap yet.
          </p>
        ) : (
          <ul className="team-taps-skill-list" aria-busy={isSearching}>
            {search.results.map((result) => (
              <TapSkillRow
                key={result.identifier}
                result={result}
                install={state.installs.get(result.identifier)}
                onInstall={() => state.installSkill(result)}
                onClearInstall={() => state.clearInstall(result.identifier)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** One searchable tap skill, with the reused hub install control. */
function TapSkillRow({
  result,
  install,
  onInstall,
  onClearInstall,
}: {
  result: HermesHubSkillResult;
  install?: TapInstallState;
  onInstall: () => void;
  onClearInstall: () => void;
}) {
  const phase = install?.phase ?? "idle";
  return (
    <li className="team-taps-skill-row">
      <div className="team-taps-skill-main">
        <span className="team-taps-skill-name">{result.name}</span>
        {result.description ? (
          <p className="team-taps-skill-description">{result.description}</p>
        ) : null}
      </div>
      <div className="team-taps-skill-actions">
        {phase === "installing" ? (
          <span className="team-taps-skill-installing" role="status">
            Installing
          </span>
        ) : phase === "done" ? (
          <span className="team-taps-skill-done" role="status">
            <IconCircleCheck size={13} ariaHidden />
            Applies next session
          </span>
        ) : phase === "failed" ? (
          <span className="team-taps-skill-failed">
            <span className="team-taps-skill-failed-text" role="alert">
              <IconExclamationCircle size={13} ariaHidden />
              {install?.error ?? "Install failed."}
            </span>
            <button
              type="button"
              className="team-taps-skill-retry"
              onClick={onInstall}
            >
              Try again
            </button>
            <button
              type="button"
              className="team-taps-skill-dismiss"
              aria-label="Dismiss install error"
              onClick={onClearInstall}
            >
              <IconCrossSmall size={12} ariaHidden />
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="team-taps-skill-install"
            onClick={onInstall}
          >
            <IconArrowInbox size={13} ariaHidden />
            {result.installed ? "Reinstall" : "Install"}
          </button>
        )}
      </div>
    </li>
  );
}

/** The community/trusted badge for a tap. */
function TrustPill({ trust }: { trust: ReturnType<typeof tapTrustMeta> }) {
  return (
    <span
      className="team-taps-trust"
      data-tone={trust.tone}
      title={trust.advisory}
    >
      {trust.tone === "trusted" ? (
        <IconShieldCheck size={11} ariaHidden />
      ) : (
        <IconWarningSign size={11} ariaHidden />
      )}
      {trust.label}
    </span>
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
    <div className="team-taps-empty" role="status">
      <span className="team-taps-empty-icon" aria-hidden>
        <IconGithub size={22} />
      </span>
      <p className="team-taps-empty-title">{title}</p>
      <p className="team-taps-empty-description">{description}</p>
    </div>
  );
}
