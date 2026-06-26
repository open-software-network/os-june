import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconCircleInfo } from "central-icons/IconCircleInfo";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconShield } from "central-icons/IconShield";
import { IconToolbox } from "central-icons/IconToolbox";
import { IconWarningSign } from "central-icons/IconWarningSign";
import { useMemo, useState } from "react";
import {
  explainSkill,
  filterToolsets,
  lastRefreshedLabel,
  toolsetLabel,
  toolsetMode,
  toolsetStatus,
  unmetRequirements,
  useToolsets,
  type HermesAdminMode,
  type HermesSkillInfo,
  type HermesToolsetInfo,
  type SkillExplanation,
  type ToolsetsState,
} from "../../lib/hermes-admin";
import { AdminNotifications } from "./AdminNotifications";

type ToolsetsSectionProps = {
  /** The write-access mode whose runtime this page inspects. Defaults to the
   * safe sandboxed runtime; the host can point it at Full mode explicitly. */
  mode?: HermesAdminMode;
};

/**
 * June's native Toolsets inventory and requirements page (spec 04). Explains
 * what June/Hermes can currently do and what setup is missing: every Hermes
 * toolset, its active / inactive / missing-setup state, its included tools, its
 * unmet prerequisites, and whether it is allowed in the sandboxed or Full mode
 * runtime. It also explains why an installed skill is visible, hidden, or not
 * yet useful, by evaluating the skill's declared requirements against the live
 * toolset inventory.
 *
 * This is a READ surface: it never invents state. Where Hermes does not report a
 * requirement, an allowance, or an activation reason, the UI marks it unknown.
 * Data lives entirely in {@link useToolsets}; this component is presentation +
 * local search state. The render-only {@link ToolsetsView} is split out so tests
 * can drive it with a stubbed state (no Tauri, no network).
 */
export function ToolsetsSection({ mode = "sandboxed" }: ToolsetsSectionProps) {
  const state = useToolsets(mode);
  return <ToolsetsView state={state} mode={mode} />;
}

export function ToolsetsView({
  state,
  mode = "sandboxed",
}: {
  state: ToolsetsState;
  mode?: HermesAdminMode;
}) {
  const [query, setQuery] = useState("");

  const visible = useMemo(
    () => filterToolsets(state.toolsets, query),
    [state.toolsets, query],
  );

  // Only skills that declare requirement metadata get an explanation row — the
  // spec is explicit that unknown metadata is not fabricated.
  const explained = useMemo(
    () => skillsWithExplanations(state.skills, state.toolsets),
    [state.skills, state.toolsets],
  );

  const isUnavailable = state.status === "unavailable";
  const isErrored = state.status === "error";
  const isLoadingFirst = state.status === "loading";
  const hasToolsets = state.toolsets.length > 0;

  return (
    <section
      className="settings-group toolsets"
      aria-labelledby="toolsets-heading"
    >
      <h2 id="toolsets-heading" className="settings-group-heading">
        Toolsets
      </h2>
      <p className="settings-group-description">
        See which capabilities Hermes can use and what setup is still missing.
        Toolsets are read only here. Install skills or MCP servers to add more.{" "}
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

      <div className="settings-card toolsets-card">
        <div className="toolsets-toolbar">
          <div className="toolsets-search">
            <IconMagnifyingGlass
              size={15}
              ariaHidden
              className="toolsets-search-icon"
            />
            <input
              type="search"
              value={query}
              placeholder="Filter toolsets"
              aria-label="Filter toolsets"
              disabled={isUnavailable}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </div>
          <button
            type="button"
            className="toolsets-refresh"
            disabled={isUnavailable || isLoadingFirst}
            onClick={state.refresh}
          >
            <IconArrowRotateClockwise size={14} ariaHidden />
            Refresh
          </button>
        </div>

        {!isUnavailable ? (
          <p className="toolsets-refreshed" aria-live="polite">
            {lastRefreshedLabel(state.lastRefreshedAt)}
          </p>
        ) : null}

        {state.error && hasToolsets ? (
          <p className="settings-row-error toolsets-inline-error">
            <IconExclamationCircle size={14} ariaHidden />
            {state.error}
          </p>
        ) : null}

        <div className="toolsets-body">
          {isUnavailable ? (
            <EmptyState
              title="Hermes is not running"
              description="Start Hermes to see which toolsets and tools your sessions can use."
            />
          ) : isErrored ? (
            <ErrorState
              message={state.error ?? "Could not load toolsets from Hermes."}
              retryable={state.retryable}
              onRetry={state.refresh}
            />
          ) : isLoadingFirst ? (
            <ToolsetsLoading />
          ) : !hasToolsets ? (
            <EmptyState
              title="No toolsets reported"
              description="Hermes did not report any toolsets for this runtime. Tools from MCP servers appear here after the gateway restarts."
            />
          ) : visible.length === 0 ? (
            <EmptyState
              title="No matching toolsets"
              description="No toolset matches your search. Try a different term or clear the filter."
            />
          ) : (
            <ul className="toolsets-list">
              {visible.map((toolset) => (
                <ToolsetRow key={toolset.name} toolset={toolset} />
              ))}
            </ul>
          )}
        </div>
      </div>

      {!isUnavailable && explained.length > 0 ? (
        <SkillExplanations entries={explained} />
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
    <span className="toolsets-mode-note">
      Showing the {modeLabel} runtime
      {profile ? ` (profile ${profile})` : ""}.
    </span>
  );
}

/** One toolset row: name + status pill, description, mode allowance, included
 * tools, and unmet requirements. */
function ToolsetRow({ toolset }: { toolset: HermesToolsetInfo }) {
  const status = toolsetStatus(toolset);
  const mode = toolsetMode(toolset.modes);
  const tools = toolset.tools ?? [];
  const unmet = unmetRequirements(toolset);

  return (
    <li className="toolset-row" data-status={status.status}>
      <div className="toolset-main">
        <div className="toolset-headline">
          <span className="toolset-name">{toolsetLabel(toolset)}</span>
          <span className="toolset-status" data-tone={status.tone}>
            {status.label}
          </span>
          <span
            className="toolset-mode"
            data-unknown={mode.unknown || undefined}
            title={mode.detail}
          >
            <IconShield size={11} ariaHidden />
            {mode.label}
          </span>
        </div>

        {toolset.description ? (
          <p className="toolset-description">{toolset.description}</p>
        ) : null}

        {tools.length > 0 ? (
          <div className="toolset-tools" aria-label="Included tools">
            {tools.map((tool) => (
              <span key={tool} className="toolset-tool">
                {tool}
              </span>
            ))}
          </div>
        ) : (
          <p className="toolset-tools-empty">
            Hermes did not list the tools in this toolset.
          </p>
        )}

        {unmet.length > 0 ? (
          <div className="toolset-requirements">
            <span className="toolset-requirements-eyebrow">
              <IconWarningSign size={12} ariaHidden />
              Needs setup
            </span>
            <ul className="toolset-requirements-list">
              {unmet.map((requirement) => (
                <li key={requirement.label} className="toolset-requirement">
                  {requirement.label}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </li>
  );
}

type ExplainedSkill = {
  skill: HermesSkillInfo;
  explanation: SkillExplanation;
};

/** Pairs each skill that declares requirement metadata with its explanation,
 * dropping skills with `unknown` status so the section shows only skills June
 * can honestly speak about. */
function skillsWithExplanations(
  skills: readonly HermesSkillInfo[],
  toolsets: readonly HermesToolsetInfo[],
): ExplainedSkill[] {
  const out: ExplainedSkill[] = [];
  for (const skill of skills) {
    const explanation = explainSkill(skill, toolsets);
    if (explanation.status === "unknown") continue;
    out.push({ skill, explanation });
  }
  return out;
}

/** The "why is this skill on/off" section, wired to the live toolset inventory.
 * Only rendered when at least one skill declares requirement metadata. */
function SkillExplanations({ entries }: { entries: ExplainedSkill[] }) {
  return (
    <div className="settings-card toolsets-skills-card">
      <div className="toolsets-skills-header">
        <span className="toolsets-skills-eyebrow">
          <IconToolbox size={15} ariaHidden />
          Skill availability
        </span>
        <p className="toolsets-skills-description">
          Why these skills are visible, hidden, or waiting on setup, based on
          the toolsets above.
        </p>
      </div>
      <ul className="toolsets-skills-list">
        {entries.map(({ skill, explanation }) => (
          <li
            key={skill.name}
            className="toolsets-skill-row"
            data-status={explanation.status}
          >
            <span className="toolsets-skill-name">{skill.name}</span>
            <span className="toolsets-skill-explanation">
              {explanation.message}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The shared gateway-lifecycle banner. Only shown when there is something to
 * say so a clean page is not cluttered. */
function LifecycleBanner({ state }: { state: ToolsetsState }) {
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
    <div className="toolsets-lifecycle" data-tone={tone} role="status">
      <span className="toolsets-lifecycle-eyebrow">
        <IconCircleInfo size={15} ariaHidden />
        {snapshot.label}
      </span>
      <span className="toolsets-lifecycle-body">{snapshot.detail}</span>
    </div>
  );
}

function ToolsetsLoading() {
  return (
    <ul className="toolsets-list" aria-hidden>
      {[0, 1, 2].map((index) => (
        <li key={index} className="toolset-row toolset-skeleton">
          <div className="toolset-main">
            <span className="toolset-skeleton-line toolset-skeleton-title" />
            <span className="toolset-skeleton-line" />
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
    <div className="toolsets-empty" role="status">
      <span className="toolsets-empty-icon" aria-hidden>
        <IconToolbox size={22} />
      </span>
      <p className="toolsets-empty-title">{title}</p>
      <p className="toolsets-empty-description">{description}</p>
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
    <div className="toolsets-error" role="alert">
      <span className="toolsets-empty-icon" aria-hidden>
        <IconExclamationCircle size={22} />
      </span>
      <p className="toolsets-empty-title">Couldn't load toolsets</p>
      <p className="toolsets-empty-description">{message}</p>
      {retryable ? (
        <button type="button" className="toolsets-retry" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
