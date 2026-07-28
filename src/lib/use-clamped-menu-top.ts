import { useLayoutEffect, useRef, useState } from "react";

const VIEWPORT_INSET = 8;

/**
 * Keeps a fixed-position context menu inside the viewport. The sessions-page
 * row menu opens at `anchor.bottom + 4` with no knowledge of its own height, so
 * one opened near the bottom of the window runs off screen; this measures the
 * mounted menu and pulls its top up just enough to fit (macOS-style clamp, not
 * a flip). Attach `ref` to the menu element and position with `clampedTop`.
 */
export function useClampedMenuTop<T extends HTMLElement>(top: number) {
  const ref = useRef<T | null>(null);
  const [clampedTop, setClampedTop] = useState(top);

  useLayoutEffect(() => {
    const updateClampedTop = () => {
      const el = ref.current;
      const height = el?.offsetHeight ?? 0;
      const maxTop = window.innerHeight - height - VIEWPORT_INSET;
      setClampedTop(Math.min(top, Math.max(VIEWPORT_INSET, maxTop)));
    };

    updateClampedTop();
    window.addEventListener("resize", updateClampedTop);
    return () => window.removeEventListener("resize", updateClampedTop);
  }, [top]);

  return { ref, clampedTop };
}
