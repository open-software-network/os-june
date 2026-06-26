import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconArrowUpRight } from "central-icons/IconArrowUpRight";
import { IconCircleInfo } from "central-icons/IconCircleInfo";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { IconLock } from "central-icons/IconLock";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconPlugin2 } from "central-icons/IconPlugin2";
import { IconWarningSign } from "central-icons/IconWarningSign";
import { useMemo, useState } from "react";
import {
  categoriesOf,
  filterSkills,
  platformRestrictions,
  skillActivation,
  skillCategory,
  skillPath,
  sourceMeta,
  useInstalledSkills,
  type HermesAdminMode,
  type HermesSkillInfo,
  type InstalledSkillsState,
} from "../../lib/hermes-admin";
import { Switch } from "../ui/Switch";

/** Sentinel for the "all categories" filter chip. */
const ALL_CATEGORIES = "__all__";

type InstalledSkillsSectionProps = {
  /** The write-access mode whose runtime this page targets. Defaults to the
   * safe sandboxed runtime; the host can point it at Full mode explicitly. */
  mode?: HermesAdminMode;
  /** Opens the skill detail surface for a given skill name. Wired by the host
   * (Track 04 owns the detail page); when omitted the "Open" affordance is
   * hidden so the page never offers a dead link. */
  onOpenSkill?: (name: string) => void;
};

/**
 * June's native installed Skills page (spec 03). Lists the skills Hermes has
 * installed for the targeted profile, with search, category filters,
 * source/status metadata, and an enable/disable toggle — all through the typed
 * `hermes-admin` client, the shared cache, and the gateway lifecycle (so the
 * apply-timing copy is honest and consistent with every other admin surface).
 *
 * This is a settings SURFACE: it renders inside the settings panel exactly like
 * the other sections and reuses the same `settings-*` chrome, so it sits next to
 * the chat without looking out of place. The data lives entirely in
 * {@link useInstalledSkills}; this component is presentation + local filter
 * state.
 */
export function InstalledSkillsSection({
  mode = "sandboxed",
  onOpenSkill,
}: InstalledSkillsSectionProps) {
  const state = useInstalledSkills(mode);
  return (
    <InstalledSkillsView state={state} mode={mode} onOpenSkill={onOpenSkill} />
  );
}

/**
 * The render-only view, split out so component tests can drive it with a stubbed
 * {@link InstalledSkillsState} (no Tauri, no network) and assert search /
 * filtering / toggle wiring. Owns only the local search + category filter state.
 */
export function InstalledSkillsView({
  state,
  mode = "sandboxed",
  onOpenSkill,
}: {
  state: InstalledSkillsState;
  mode?: HermesAdminMode;
  onOpenSkill?: (name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>(ALL_CATEGORIES);

  const categories = useMemo(() => categoriesOf(state.skills), [state.skills]);
  const visible = useMemo(
    () =>
      filterSkills(state.skills, {
        query,
        category: category === ALL_CATEGORIES ? undefined : category,
      }),
    [state.skills, query, category],
  );

  // A category that vanished after a refresh should not strand the filter.
  const activeCategory =
    category !== ALL_CATEGORIES && !categories.includes(category)
      ? ALL_CATEGORIES
      : category;

  const isUnavailable = state.status === "unavailable";
  const isErrored = state.status === "error";
  const isLoadingFirst = state.status === "loading";
  const hasSkills = state.skills.length > 0;

  return (
    <section
      className="settings-group installed-skills"
      aria-labelledby="installed-skills-heading"
    >
      <h2 id="installed-skills-heading" className="settings-group-heading">
        Installed skills
      </h2>
      <p className="settings-group-description">
        Browse the skills Hermes has installed and choose which ones future
        sessions can use. Changes apply to new sessions.{" "}
        <ModeNote
          mode={state.mode ?? mode}
          profile={state.profile}
          show={!isUnavailable}
        />
      </p>

      <LifecycleBanner state={state} />
      <Notifications state={state} />

      <div className="settings-card installed-skills-card">
        <div className="installed-skills-toolbar">
          <div className="installed-skills-search">
            <IconMagnifyingGlass
              size={15}
              ariaHidden
              className="installed-skills-search-icon"
            />
            <input
              type="search"
              value={query}
              placeholder="Filter skills"
              aria-label="Filter installed skills"
              disabled={isUnavailable}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </div>
          <button
            type="button"
            className="installed-skills-refresh"
            disabled={isUnavailable || isLoadingFirst}
            onClick={state.refresh}
          >
            <IconArrowRotateClockwise size={14} ariaHidden />
            Refresh
          </button>
        </div>

        {categories.length > 1 && !isUnavailable ? (
          <div
            className="installed-skills-filters"
            role="group"
            aria-label="Filter by category"
          >
            <CategoryChip
              label="All"
              count={state.skills.length}
              active={activeCategory === ALL_CATEGORIES}
              onSelect={() => setCategory(ALL_CATEGORIES)}
            />
            {categories.map((name) => (
              <CategoryChip
                key={name}
                label={name}
                count={
                  state.skills.filter((skill) => skillCategory(skill) === name)
                    .length
                }
                active={activeCategory === name}
                onSelect={() => setCategory(name)}
              />
            ))}
          </div>
        ) : null}

        {state.error && hasSkills ? (
          <p className="settings-row-error installed-skills-inline-error">
            <IconExclamationCircle size={14} ariaHidden />
            {state.error}
          </p>
        ) : null}

        <div className="installed-skills-body">
          {isUnavailable ? (
            <EmptyState
              title="Hermes is not running"
              description="Start Hermes to see and manage the skills installed for your sessions."
            />
          ) : isErrored ? (
            <ErrorState
              message={state.error ?? "Could not load skills from Hermes."}
              retryable={state.retryable}
              onRetry={state.refresh}
            />
          ) : isLoadingFirst ? (
            <SkillsLoading />
          ) : !hasSkills ? (
            <EmptyState
              title="No skills installed"
              description="Skills you install from the Skills Hub or load from a directory will appear here."
            />
          ) : visible.length === 0 ? (
            <EmptyState
              title="No matching skills"
              description="No installed skill matches your search. Try a different term or clear the filters."
            />
          ) : (
            <ul className="installed-skills-list" aria-busy={isLoadingFirst}>
              {visible.map((skill) => (
                <SkillRow
                  key={skill.name}
                  skill={skill}
                  pending={state.pending.has(skill.name)}
                  onToggle={(enabled) => state.toggle(skill.name, enabled)}
                  onOpen={
                    onOpenSkill ? () => onOpenSkill(skill.name) : undefined
                  }
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

/** The sandbox/full-mode + profile context line, so a write's blast radius is
 * never ambiguous. */
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
    <span className="installed-skills-mode-note">
      Targeting the {modeLabel} runtime
      {profile ? ` (profile ${profile})` : ""}.
    </span>
  );
}

/** The shared gateway-lifecycle banner. Only shown when there is something to
 * say (a pending next-session change or a restart state) so a clean page is not
 * cluttered. Skill toggles are next-session, so this stays informational. */
function LifecycleBanner({ state }: { state: InstalledSkillsState }) {
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
    <div className="installed-skills-lifecycle" data-tone={tone} role="status">
      <span className="installed-skills-lifecycle-eyebrow">
        <IconCircleInfo size={15} ariaHidden />
        {snapshot.label}
      </span>
      <span className="installed-skills-lifecycle-body">{snapshot.detail}</span>
    </div>
  );
}

/** The durable admin notifications ("Skill updated. New sessions can use it.").
 * Dismissible, newest first. Errors render with a destructive tone. */
function Notifications({ state }: { state: InstalledSkillsState }) {
  if (state.notifications.length === 0) return null;
  const newestFirst = [...state.notifications].reverse();
  return (
    <ul className="installed-skills-notifications" aria-label="Recent changes">
      {newestFirst.map((note) => (
        <li
          key={note.id}
          className="installed-skills-notification"
          data-tone={note.isError ? "destructive" : "info"}
          role="status"
        >
          <span className="installed-skills-notification-text">
            {note.message}
          </span>
          <button
            type="button"
            className="installed-skills-notification-dismiss"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() => state.dismissNotification(note.id)}
          >
            <IconCrossSmall size={13} ariaHidden />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A category filter chip. */
function CategoryChip({
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
      className="installed-skills-chip"
      aria-pressed={active}
      onClick={onSelect}
    >
      {label}
      <span className="installed-skills-chip-count">{count}</span>
    </button>
  );
}

/** One skill row: name + source pill, description, metadata (path / platform
 * restrictions / conditional activation), an optional open-detail action, and
 * the enable/disable toggle. Read-only (external) skills show a lock and a
 * disabled switch. */
function SkillRow({
  skill,
  pending,
  onToggle,
  onOpen,
}: {
  skill: HermesSkillInfo;
  pending: boolean;
  onToggle: (enabled: boolean) => void;
  onOpen?: () => void;
}) {
  const meta = sourceMeta(skill.source);
  const restrictions = platformRestrictions(skill);
  const activation = skillActivation(skill);
  const path = skillPath(skill);
  const readOnly = Boolean(skill.readOnly);
  const labelId = `installed-skill-${cssId(skill.name)}`;

  return (
    <li className="installed-skill-row" data-enabled={skill.enabled}>
      <div className="installed-skill-main">
        <div className="installed-skill-headline">
          <span className="installed-skill-name" id={labelId}>
            {skill.name}
          </span>
          <SourcePill source={skill.source} label={meta.label} />
          {skill.version ? (
            <span className="installed-skill-version">v{skill.version}</span>
          ) : null}
          {readOnly ? (
            <span className="installed-skill-readonly" title={meta.blurb}>
              <IconLock size={12} ariaHidden />
              Read only
            </span>
          ) : null}
        </div>

        {skill.description ? (
          <p className="installed-skill-description">{skill.description}</p>
        ) : (
          <p className="installed-skill-description installed-skill-description-muted">
            {meta.blurb}
          </p>
        )}

        <div className="installed-skill-meta">
          {path ? (
            <span className="installed-skill-meta-item" title={path}>
              {path}
            </span>
          ) : null}
          {activation?.requires ? (
            <span className="installed-skill-meta-item">
              Requires {activation.requires.join(", ")}
            </span>
          ) : null}
          {activation?.fallback ? (
            <span className="installed-skill-meta-item">
              Falls back to {activation.fallback.join(", ")}
            </span>
          ) : null}
          {restrictions ? (
            <span className="installed-skill-restriction">
              <IconWarningSign size={12} ariaHidden />
              {restrictions.join(", ")} only
            </span>
          ) : null}
        </div>

        {readOnly ? (
          <p className="installed-skill-note">
            Loaded from an external directory. It may be shared with other tools
            and cannot be changed from June.
          </p>
        ) : null}
      </div>

      <div className="installed-skill-actions">
        {onOpen ? (
          <button
            type="button"
            className="installed-skill-open"
            aria-label={`Open ${skill.name}`}
            title="Open skill"
            onClick={onOpen}
          >
            <IconArrowUpRight size={14} ariaHidden />
          </button>
        ) : null}
        <span className="installed-skill-toggle">
          <Switch
            checked={skill.enabled}
            disabled={pending || readOnly}
            aria-labelledby={labelId}
            onCheckedChange={onToggle}
          />
          <span className="installed-skill-timing" aria-hidden>
            {pending ? "Saving" : "Next session"}
          </span>
        </span>
      </div>
    </li>
  );
}

/** The colored source pill (bundled / hub / external / unknown). */
function SourcePill({ source, label }: { source: string; label: string }) {
  return (
    <span className="installed-skill-source" data-source={source}>
      {label}
    </span>
  );
}

function SkillsLoading() {
  return (
    <ul className="installed-skills-list" aria-hidden>
      {[0, 1, 2].map((index) => (
        <li
          key={index}
          className="installed-skill-row installed-skill-skeleton"
        >
          <div className="installed-skill-main">
            <span className="installed-skill-skeleton-line installed-skill-skeleton-title" />
            <span className="installed-skill-skeleton-line" />
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
    <div className="installed-skills-empty" role="status">
      <span className="installed-skills-empty-icon" aria-hidden>
        <IconPlugin2 size={22} />
      </span>
      <p className="installed-skills-empty-title">{title}</p>
      <p className="installed-skills-empty-description">{description}</p>
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
    <div className="installed-skills-error" role="alert">
      <span className="installed-skills-empty-icon" aria-hidden>
        <IconExclamationCircle size={22} />
      </span>
      <p className="installed-skills-empty-title">Couldn't load skills</p>
      <p className="installed-skills-empty-description">{message}</p>
      {retryable ? (
        <button
          type="button"
          className="installed-skills-retry"
          onClick={onRetry}
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}

/** A DOM-id-safe slug of a skill name for `aria-labelledby` wiring. */
function cssId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-");
}
