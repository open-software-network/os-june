import { describe, expect, it } from "vitest";
import {
  installNativeContextMenuGuard,
  isEditableContextMenuTarget,
} from "../lib/native-context-menu";

function dispatchContextMenu(target: Element) {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

describe("native context menu guard", () => {
  it("suppresses unhandled native context menus in production", () => {
    const cleanup = installNativeContextMenuGuard({ isDev: false });

    const event = dispatchContextMenu(document.body);

    expect(event.defaultPrevented).toBe(true);
    cleanup();
  });

  it("leaves development context menus alone", () => {
    const cleanup = installNativeContextMenuGuard({ isDev: true });

    const event = dispatchContextMenu(document.body);

    expect(event.defaultPrevented).toBe(false);
    cleanup();
  });

  it("does not override app-owned context menus", () => {
    const cleanup = installNativeContextMenuGuard({ isDev: false });
    const button = document.createElement("button");
    document.body.append(button);
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
    });

    const event = dispatchContextMenu(button);

    expect(event.defaultPrevented).toBe(true);
    cleanup();
    button.remove();
  });

  it("allows editable-field native context menus", () => {
    const cleanup = installNativeContextMenuGuard({ isDev: false });
    const input = document.createElement("input");
    document.body.append(input);

    const event = dispatchContextMenu(input);

    expect(event.defaultPrevented).toBe(false);
    cleanup();
    input.remove();
  });

  it("does not treat readonly inputs as editable context menu targets", () => {
    const input = document.createElement("input");
    input.readOnly = true;

    expect(isEditableContextMenuTarget(input)).toBe(false);
  });
});
