import { IconShieldCheck } from "central-icons/IconShieldCheck";
import { IconShieldCrossed } from "central-icons/IconShieldCrossed";
import { SegmentedControl } from "../ui/SegmentedControl";

const MODE_OPTIONS = [
  {
    value: "sandboxed",
    label: (
      <>
        <IconShieldCheck size={14} aria-hidden />
        Sandboxed
      </>
    ),
    ariaLabel: "Sandboxed",
  },
  {
    value: "unrestricted",
    label: (
      <>
        <IconShieldCrossed size={14} aria-hidden />
        Unrestricted
      </>
    ),
    ariaLabel: "Unrestricted",
  },
] as const;

/** The per-routine sandbox choice. Like the chat picker, Unrestricted is a
 * deliberate opt-in per routine, never a sticky preference. */
export function RoutineModePicker({
  unrestricted,
  onChange,
}: {
  unrestricted: boolean;
  onChange: (unrestricted: boolean) => void;
}) {
  return (
    <>
      <SegmentedControl
        value={unrestricted ? "unrestricted" : "sandboxed"}
        onValueChange={(value) => onChange(value === "unrestricted")}
        options={MODE_OPTIONS}
        // The indicator goes terracotta while Unrestricted is armed, same
        // warm accent as the composer's sandbox trigger.
        className={unrestricted ? "segmented-warm" : undefined}
        aria-label="What can this routine change?"
      />
      <p className="routines-mode-hint">
        {unrestricted
          ? "When it fires, June can run commands and change any file your account can."
          : "The routine can read the web, use memory, and message you. It cannot run commands or change your files."}
      </p>
    </>
  );
}
