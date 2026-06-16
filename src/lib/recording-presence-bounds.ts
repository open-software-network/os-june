import { useEffect, useId, type RefObject } from "react";
import { setRecordingPresenceBounds } from "./tauri";

export function useRecordingPresenceBounds(
  ref: RefObject<HTMLElement>,
  enabled = true,
) {
  const ownerId = useId();

  useEffect(() => {
    if (!enabled) {
      void setRecordingPresenceBounds(null, ownerId);
      return;
    }

    const element = ref.current;
    if (!element) {
      void setRecordingPresenceBounds(null, ownerId);
      return;
    }

    const update = () => {
      const rect = element.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0;
      void setRecordingPresenceBounds(
        visible
          ? {
              x: rect.left,
              y: rect.top,
              width: rect.width,
              height: rect.height,
            }
          : null,
        ownerId,
      );
    };

    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(update);
    observer?.observe(element);

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      void setRecordingPresenceBounds(null, ownerId);
    };
  }, [enabled, ownerId, ref]);
}
