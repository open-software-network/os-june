import { IconArrowInbox } from "central-icons/IconArrowInbox";
import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconArrowRotateCounterClockwise } from "central-icons/IconArrowRotateCounterClockwise";
import { IconCircleInfo } from "central-icons/IconCircleInfo";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { IconShield } from "central-icons/IconShield";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { useState } from "react";
import {
  availableActions,
  lifecycleActionLabel,
  type HermesSkillInfo,
  type SkillActionAvailability,
  type SkillLifecycleAction,
  type SkillLifecycleActionState,
  type SkillLifecyclePolicy,
  type SkillLifecycleState,
} from "../../lib/hermes-admin";

/** The icon for each lifecycle action, outlined per the structural-UI rule. */
function actionIcon(action: SkillLifecycleAction) {
  switch (action) {
    case "check":
      return <IconArrowRotateClockwise size={13} ariaHidden />;
    case "update":
      return <IconArrowInbox size={13} ariaHidden />;
    case "audit":
      return <IconShield size={13} ariaHidden />;
    case "uninstall":
    case "delete":
      return <IconTrashCan size={13} ariaHidden />;
    case "reset":
      return <IconArrowRotateCounterClockwise size={13} ariaHidden />;
    case "restore":
      return <IconArrowRotateCounterClockwise size={13} ariaHidden />;
  }
}

/**
 * The shared skill lifecycle action surface (spec 08). Given a skill, its
 * lifecycle policy, and the {@link SkillLifecycleState}, it renders the VALID
 * actions as buttons and, in the detail variant, lists the invalid ones with
 * their honest reason so an unavailable action explains itself rather than just
 * vanishing. A destructive action (uninstall / delete) and an action that would
 * overwrite local edits both go through an inline confirm so nothing is removed
 * or clobbered by a single click.
 *
 * Presentation only: every action routes through the state's `run`, and progress
 * / failure is read from `state.actions`. No network, no Tauri.
 */
export function SkillLifecycleActions({
  skill,
  policy,
  state,
  variant = "row",
}: {
  skill: HermesSkillInfo;
  policy: SkillLifecyclePolicy;
  state: SkillLifecycleState;
  /** `row` shows only valid actions compactly; `detail` also lists the disabled
   * actions with their reasons. */
  variant?: "row" | "detail";
}) {
  const valid = availableActions(policy);
  const invalid =
    variant === "detail"
      ? (
          [
            "update",
            "audit",
            "uninstall",
            "delete",
            "reset",
            "restore",
          ] as SkillLifecycleAction[]
        )
          .map((action) => policy.actions[action])
          .filter((a) => !a.available && a.reason)
      : [];

  if (valid.length === 0 && invalid.length === 0) return null;

  return (
    <div className="skill-lifecycle" data-variant={variant}>
      <div
        className="skill-lifecycle-actions"
        role="group"
        aria-label="Skill actions"
      >
        {valid.map((availability) => (
          <LifecycleActionButton
            key={availability.action}
            skill={skill}
            availability={availability}
            actionState={state.actions.get(
              `${skill.name}::${availability.action}`,
            )}
            onRun={(acceptDivergence) =>
              state.run(skill, availability.action, { acceptDivergence })
            }
            onClear={() => state.clearAction(skill.name, availability.action)}
          />
        ))}
      </div>

      {invalid.length > 0 ? (
        <ul className="skill-lifecycle-unavailable">
          {invalid.map((availability) => (
            <li
              key={availability.action}
              className="skill-lifecycle-unavailable-item"
            >
              <IconCircleInfo size={12} ariaHidden />
              <span>
                <strong>{lifecycleActionLabel(availability.action)}: </strong>
                {availability.reason}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** One lifecycle action button with its progress / failure / confirm state. */
function LifecycleActionButton({
  skill,
  availability,
  actionState,
  onRun,
  onClear,
}: {
  skill: HermesSkillInfo;
  availability: SkillActionAvailability;
  actionState?: SkillLifecycleActionState;
  onRun: (acceptDivergence: boolean) => void;
  onClear: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const { action } = availability;
  const phase = actionState?.phase ?? "idle";
  const running = phase === "running";
  const needsConfirm =
    availability.destructive || Boolean(availability.divergenceWarning);

  if (phase === "failed") {
    return (
      <span className="skill-lifecycle-action-failed" role="alert">
        <IconExclamationCircle size={13} ariaHidden />
        {actionState?.error ?? `Could not ${action} ${skill.name}.`}
        <button
          type="button"
          className="skill-lifecycle-retry"
          onClick={() => {
            onClear();
            onRun(Boolean(availability.divergenceWarning));
          }}
        >
          Try again
        </button>
      </span>
    );
  }

  if (phase === "done") {
    return (
      <span className="skill-lifecycle-action-done">
        {doneLabel(action)}
        <button
          type="button"
          className="skill-lifecycle-clear"
          aria-label={`Dismiss ${action} result`}
          onClick={onClear}
        >
          Dismiss
        </button>
      </span>
    );
  }

  return (
    <span className="skill-lifecycle-action">
      <button
        type="button"
        className="skill-lifecycle-action-button"
        data-destructive={availability.destructive ? "true" : undefined}
        disabled={running}
        aria-busy={running}
        onClick={() => {
          if (needsConfirm) setConfirming(true);
          else onRun(false);
        }}
      >
        {actionIcon(action)}
        {running
          ? runningLabel(action, actionState?.progress)
          : lifecycleActionLabel(action)}
      </button>

      {confirming ? (
        <ConfirmAction
          skill={skill.name}
          availability={availability}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            onRun(true);
          }}
        />
      ) : null}
    </span>
  );
}

/** The inline confirmation for a destructive or divergent action. It states the
 * consequence (removal, or overwriting local edits) before the user commits. */
function ConfirmAction({
  skill,
  availability,
  onCancel,
  onConfirm,
}: {
  skill: string;
  availability: SkillActionAvailability;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const message =
    availability.divergenceWarning ??
    (availability.action === "delete"
      ? `Delete ${skill}? This removes the skill from this machine. New sessions will not load it.`
      : `Uninstall ${skill}? New sessions will not load it.`);
  return (
    <div
      className="skill-lifecycle-confirm"
      role="dialog"
      aria-label={`Confirm ${availability.action}`}
      aria-modal="false"
    >
      <p className="skill-lifecycle-confirm-message">
        <IconExclamationCircle size={13} ariaHidden />
        {message}
      </p>
      <div className="skill-lifecycle-confirm-actions">
        <button
          type="button"
          className="skill-lifecycle-confirm-cancel"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="skill-lifecycle-confirm-go"
          data-destructive={availability.destructive ? "true" : undefined}
          onClick={onConfirm}
        >
          {availability.action === "delete"
            ? "Delete"
            : availability.action === "uninstall"
              ? "Uninstall"
              : lifecycleActionLabel(availability.action)}
        </button>
      </div>
    </div>
  );
}

/** The in-progress label for an action, with optional percentage. */
function runningLabel(action: SkillLifecycleAction, progress?: number): string {
  const verb =
    action === "update"
      ? "Updating"
      : action === "uninstall"
        ? "Uninstalling"
        : action === "delete"
          ? "Deleting"
          : action === "audit"
            ? "Auditing"
            : action === "check"
              ? "Checking"
              : action === "reset"
                ? "Resetting"
                : "Restoring";
  return progress !== undefined
    ? `${verb} ${Math.round(progress)}%`
    : `${verb}...`;
}

/** The terminal "done" label for an action. */
function doneLabel(action: SkillLifecycleAction): string {
  switch (action) {
    case "update":
      return "Updated";
    case "uninstall":
      return "Uninstalled";
    case "delete":
      return "Deleted";
    case "audit":
      return "Audited";
    case "check":
      return "Checked";
    case "reset":
      return "Reset";
    case "restore":
      return "Restored";
  }
}
