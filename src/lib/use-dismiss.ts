import { type RefObject, useEffect } from "react";

/**
 * Dismisses an open popover or menu on an outside pointer press or the Escape
 * key, with the window listeners gated on `open`. This is the canonical dismiss
 * for anchored popovers and menus (see docs/design/components.md "Menus and
 * popovers"). Pass a wrapper `ref` for containment-checked dismissal, or omit it
 * (with `pointerEvent: "click"`) for coordinate-positioned menus that close on
 * any click.
 */
export function useDismiss(
  ref: RefObject<HTMLElement | null> | null,
  open: boolean,
  onClose: () => void,
  options?: {
    /** Pointer event to listen for. Defaults to "mousedown". */
    pointerEvent?: "mousedown" | "click";
  },
) {
  const pointerEvent = options?.pointerEvent ?? "mousedown";

  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      if (ref?.current?.contains(event.target as Node)) return;
      onClose();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener(pointerEvent, onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(pointerEvent, onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [ref, open, onClose, pointerEvent]);
}
