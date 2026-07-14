import { IconCheckmark2Medium } from "central-icons/IconCheckmark2Medium";
import type { ComponentPropsWithoutRef } from "react";

type CheckboxProps = Omit<ComponentPropsWithoutRef<"input">, "type" | "className">;

/**
 * The house checkbox: the notes list's rounded-square select box
 * (.folder-note-select-box) promoted to a shared primitive. A visually hidden
 * native input keeps the semantics and stays the click target; the box carries
 * the visual — outline when unchecked, brand fill + checkmark when checked.
 * Place inside a <label> next to the option copy.
 */
export function Checkbox({ checked, ...rest }: CheckboxProps) {
  return (
    <span className="checkbox-control">
      <input type="checkbox" checked={checked} {...rest} />
      <span className="checkbox-box" aria-hidden>
        {checked ? <IconCheckmark2Medium size={10} /> : null}
      </span>
    </span>
  );
}
