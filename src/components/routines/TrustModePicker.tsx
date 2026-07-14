import type { RoutineTrustMode } from "../../lib/tauri";
import {
  autonomyProgressLabel,
  autonomyUnlockHint,
  canSelectAutonomous,
  CONNECTOR_ACTION_TOOLS,
  TRUST_MODE_META,
} from "../../lib/connectors";
import { Checkbox } from "../ui/Checkbox";
import { SegmentedControl } from "../ui/SegmentedControl";

const TRUST_MODES: readonly RoutineTrustMode[] = ["read_only", "approval", "autonomous"];

const MODE_OPTIONS = TRUST_MODES.map((mode) => {
  const meta = TRUST_MODE_META[mode];
  const Icon = meta.icon;
  return {
    value: mode,
    label: (
      <>
        <Icon size={14} aria-hidden />
        {meta.label}
      </>
    ),
    ariaLabel: meta.label,
  };
});

/**
 * The per-routine trust choice for connector actions (read only, approval,
 * autonomous). Deliberately SEPARATE from RoutineModePicker: trust governs
 * what a routine may do with your Google account, the sandbox choice governs
 * what it may do to your machine — the two never merge.
 *
 * Autonomous is earned: it stays unselectable (the pick is ignored, with the
 * unlock hint explaining why) until `runCount` approval-mode runs completed.
 * When autonomous is active, the checklist selects exactly which connector
 * action tools the grant covers.
 */
export function TrustModePicker({
  value,
  runCount,
  autonomousTools,
  onChange,
  onAutonomousToolsChange,
}: {
  value: RoutineTrustMode;
  /** Completed approval-mode runs of this routine (0 for a new one). */
  runCount: number;
  /** Connector action tool names granted for autonomous runs. */
  autonomousTools: string[];
  onChange: (mode: RoutineTrustMode) => void;
  onAutonomousToolsChange: (tools: string[]) => void;
}) {
  const autonomousUnlocked = canSelectAutonomous(runCount);

  function pick(mode: RoutineTrustMode) {
    if (mode === "autonomous" && !autonomousUnlocked) return;
    onChange(mode);
  }

  function toggleTool(toolId: string, granted: boolean) {
    const next = new Set(autonomousTools);
    if (granted) next.add(toolId);
    else next.delete(toolId);
    onAutonomousToolsChange(CONNECTOR_ACTION_TOOLS.map((t) => t.id).filter((id) => next.has(id)));
  }

  return (
    <div className="trust-mode-picker">
      <SegmentedControl
        value={value}
        onValueChange={pick}
        options={MODE_OPTIONS}
        aria-label="What can this routine do with your Google account?"
      />
      <p className="routines-mode-hint">{TRUST_MODE_META[value].description}</p>
      {!autonomousUnlocked ? (
        <p className="routines-mode-hint trust-mode-locked-hint">
          {autonomyUnlockHint(runCount)} {autonomyProgressLabel(runCount)}
        </p>
      ) : null}
      {value === "autonomous" ? (
        <fieldset className="trust-mode-grants">
          <legend className="trust-mode-grants-legend">Tools this routine may run unasked</legend>
          {CONNECTOR_ACTION_TOOLS.map((tool) => (
            <label key={tool.id} className="trust-mode-grant" htmlFor={`trust-grant-${tool.id}`}>
              <Checkbox
                id={`trust-grant-${tool.id}`}
                checked={autonomousTools.includes(tool.id)}
                onChange={(event) => toggleTool(tool.id, event.currentTarget.checked)}
              />
              {tool.label}
            </label>
          ))}
        </fieldset>
      ) : null}
    </div>
  );
}
