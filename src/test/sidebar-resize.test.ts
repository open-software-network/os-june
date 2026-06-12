import type { PointerEvent as ReactPointerEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { handleSidebarResizeStart } from "../app/sidebar-resize";
import appCss from "../styles/app.css?raw";

function setupResizeDom(sidebarState: "collapsed" | "expanded") {
  document.body.innerHTML = `
    <main class="app-shell" data-sidebar="${sidebarState}">
      <aside class="sidebar"></aside>
      <div class="sidebar-resize-handle"></div>
      <section class="main-panel"></section>
    </main>
  `;
  return {
    shell: document.querySelector(".app-shell") as HTMLElement,
    handle: document.querySelector(".sidebar-resize-handle") as HTMLElement,
    mainPanel: document.querySelector(".main-panel") as HTMLElement,
  };
}

function pointerEvent(type: string, clientX: number) {
  return new MouseEvent(type, { clientX }) as unknown as PointerEvent;
}

function reactPointerEvent(
  handle: HTMLElement,
  clientX: number,
): ReactPointerEvent<HTMLDivElement> {
  return {
    button: 0,
    clientX,
    currentTarget: handle,
    preventDefault: vi.fn(),
  } as unknown as ReactPointerEvent<HTMLDivElement>;
}

describe("handleSidebarResizeStart", () => {
  it("does not hide the sidebar element during collapsed drag preview", () => {
    expect(appCss).not.toMatch(
      /\.app-shell\[data-sidebar-preview="collapsed"\]\s+\.sidebar\s*\{[^}]*display:\s*none/,
    );
  });

  it("sets collapsed preview state as soon as a drag crosses the collapse threshold", () => {
    const { shell, handle, mainPanel } = setupResizeDom("expanded");
    const onStart = vi.fn();
    const onEnd = vi.fn();

    handleSidebarResizeStart(reactPointerEvent(handle, 240), 240, {
      collapseWidth: 160,
      minWidth: 188,
      maxWidth: () => 320,
      onStart,
      onEnd,
      commit: (fn) => fn(),
    });

    expect(onStart).toHaveBeenCalledOnce();
    expect(shell.dataset.sidebarPreview).toBe("expanded");

    window.dispatchEvent(pointerEvent("pointermove", 100));

    expect(shell.dataset.sidebarPreview).toBe("collapsed");
    expect(shell.style.getPropertyValue("--sidebar-w-current")).toBe("0px");
    expect(shell.style.getPropertyValue("--main-gutter")).toBe("var(--sp-3)");
    expect(mainPanel.style.marginLeft).toBe("var(--sp-3)");
    expect(document.querySelector(".sidebar")).toBeInTheDocument();

    window.dispatchEvent(pointerEvent("pointerup", 100));

    expect(onEnd).toHaveBeenCalledWith(0);
    expect(shell.dataset.sidebarPreview).toBeUndefined();
    expect(shell.style.getPropertyValue("--main-gutter")).toBe("");
    expect(mainPanel.style.marginLeft).toBe("");
  });

  it("sets expanded preview state when dragging back out of collapsed width", () => {
    const { shell, handle, mainPanel } = setupResizeDom("collapsed");
    const onEnd = vi.fn();

    handleSidebarResizeStart(reactPointerEvent(handle, 0), 0, {
      collapseWidth: 160,
      minWidth: 188,
      maxWidth: () => 320,
      onStart: vi.fn(),
      onEnd,
      commit: (fn) => fn(),
    });

    expect(shell.dataset.sidebarPreview).toBe("collapsed");

    window.dispatchEvent(pointerEvent("pointermove", 220));

    expect(shell.dataset.sidebarPreview).toBe("expanded");
    expect(shell.style.getPropertyValue("--sidebar-w-current")).toBe("220px");
    expect(shell.style.getPropertyValue("--main-gutter")).toBe("0px");
    expect(mainPanel.style.marginLeft).toBe("0px");

    window.dispatchEvent(pointerEvent("pointerup", 220));

    expect(onEnd).toHaveBeenCalledWith(220);
    expect(shell.dataset.sidebarPreview).toBeUndefined();
  });
});
