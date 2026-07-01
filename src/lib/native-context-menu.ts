const EDITABLE_CONTEXT_MENU_SELECTOR =
  "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

type NativeContextMenuGuardOptions = {
  isDev?: boolean;
  allowEditableFields?: boolean;
};

export function installNativeContextMenuGuard({
  isDev = import.meta.env.DEV,
  allowEditableFields = false,
}: NativeContextMenuGuardOptions = {}) {
  if (isDev) {
    return () => {};
  }

  const handleContextMenu = (event: MouseEvent) => {
    if (event.defaultPrevented) {
      return;
    }

    if (allowEditableFields && isEditableContextMenuTarget(event.target)) {
      return;
    }

    event.preventDefault();
  };

  window.addEventListener("contextmenu", handleContextMenu);

  return () => {
    window.removeEventListener("contextmenu", handleContextMenu);
  };
}

export function isEditableContextMenuTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return false;
  }

  const editable = target.closest(EDITABLE_CONTEXT_MENU_SELECTOR);
  if (!editable) {
    return false;
  }

  if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
    return !editable.disabled && !editable.readOnly;
  }

  if (editable instanceof HTMLSelectElement) {
    return !editable.disabled;
  }

  return editable instanceof HTMLElement && editable.isContentEditable;
}
