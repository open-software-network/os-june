import { useEffect } from "react";
import type { useComposerMenuDismissDependencies } from "./use-composer-menu-dismiss-types";

export function useComposerMenuDismiss(dependencies: useComposerMenuDismissDependencies) {
  const {
    composerEditorRef,
    composerModelFlyout,
    composerModelFromSlash,
    composerModelOpen,
    composerModelPopoverRef,
    composerModelTriggerRef,
    modelRootSearch,
    setComposerModelFlyout,
    setComposerModelOpen,
    setModelRootSearch,
    setModelSearch,
  } = dependencies;

  useEffect(() => {
    if (!composerModelOpen) return;
    function onPointer(event: MouseEvent) {
      const target = event.target as Node;
      if (composerModelPopoverRef.current?.contains(target)) return;
      if (composerModelTriggerRef.current?.contains(target)) return;
      // The hover detail cards are portaled to document.body, so a click inside
      // one (its "Show more" toggle) lands outside the popover — treat it as in.
      if (target instanceof Element && target.closest(".agent-composer-model-hovercard")) return;
      setComposerModelOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        // Escape peels one layer at a time: a nested model control or the
        // all-models panel first, then an active root query, then the popover.
        if (
          composerModelFlyout?.kind === "all" ||
          composerModelFlyout?.kind === "auto" ||
          composerModelFlyout?.kind === "effort"
        ) {
          setComposerModelFlyout(null);
          setModelSearch("");
        } else if (modelRootSearch) {
          setModelRootSearch("");
        } else {
          setComposerModelOpen(false);
          if (composerModelFromSlash) composerEditorRef.current?.focus();
        }
      }
    }
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [composerModelFromSlash, composerModelOpen, composerModelFlyout, modelRootSearch]);
}
