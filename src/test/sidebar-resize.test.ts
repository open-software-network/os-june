import type { PointerEvent as ReactPointerEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { handleSidebarResizeStart } from "../app/sidebar-resize";
import appCss from "../styles/app.css?raw";

function setupResizeDom(
  sidebarState: "collapsed" | "expanded",
  composerAttrs = "",
) {
  document.body.innerHTML = `
    <main class="app-shell" data-sidebar="${sidebarState}">
      <aside class="sidebar"></aside>
      <div class="sidebar-resize-handle"></div>
      <section class="main-panel"><div class="agent-composer" ${composerAttrs}></div></section>
    </main>
  `;
  return {
    shell: document.querySelector(".app-shell") as HTMLElement,
    handle: document.querySelector(".sidebar-resize-handle") as HTMLElement,
    mainPanel: document.querySelector(".main-panel") as HTMLElement,
    composer: document.querySelector(".agent-composer") as HTMLElement,
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

function loadAppStyles() {
  const style = document.createElement("style");
  style.textContent = appCss.replace(/^@import[^\n]+\n/gm, "");
  document.head.append(style);
}

describe("handleSidebarResizeStart", () => {
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

    window.dispatchEvent(pointerEvent("pointerup", 100));

    expect(onEnd).toHaveBeenCalledWith(0);
    expect(shell.dataset.sidebarPreview).toBeUndefined();
    expect(shell.style.getPropertyValue("--main-gutter")).toBe("");
    expect(mainPanel.style.marginLeft).toBe("");
  });

  it("keeps an opening preview when dragging back out of collapsed width", () => {
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

    expect(shell.dataset.sidebarPreview).toBe("opening");
    expect(shell.style.getPropertyValue("--sidebar-w-current")).toBe("220px");
    expect(shell.style.getPropertyValue("--main-gutter")).toBe("0px");
    expect(mainPanel.style.marginLeft).toBe("0px");

    window.dispatchEvent(pointerEvent("pointermove", 240));

    expect(shell.dataset.sidebarPreview).toBe("opening");
    expect(shell.style.getPropertyValue("--sidebar-w-current")).toBe("240px");

    window.dispatchEvent(pointerEvent("pointerup", 220));

    expect(onEnd).toHaveBeenCalledWith(240);
    expect(shell.dataset.sidebarPreview).toBeUndefined();
  });

  it("keeps the snap tween alive (retargeting) instead of killing it on the next move", () => {
    const { shell, handle, composer } = setupResizeDom("expanded");

    handleSidebarResizeStart(reactPointerEvent(handle, 240), 240, {
      collapseWidth: 160,
      minWidth: 188,
      maxWidth: () => 320,
      onStart: vi.fn(),
      onEnd: vi.fn(),
      commit: (fn) => fn(),
    });

    // Collapse, then drag straight back out past the min width.
    window.dispatchEvent(pointerEvent("pointermove", 100));
    window.dispatchEvent(pointerEvent("pointermove", 220));

    const tween = "grid-template-columns var(--t-med) var(--ease-out)";
    expect(shell.style.transition).toBe(tween);
    // Fixed agent UI tweens in lockstep instead of teleporting to the far
    // offset at the crossing.
    expect(composer.style.transition).toBe("left var(--t-med) var(--ease-out)");

    // Further moves while the tween is in flight retarget it (the width var
    // updates) but must not reset the transition to "none" — that teleports
    // the sidebar from the interpolated width to the cursor in one frame.
    window.dispatchEvent(pointerEvent("pointermove", 260));
    expect(shell.style.transition).toBe(tween);
    expect(shell.style.getPropertyValue("--sidebar-w-current")).toBe("260px");

    // Once the grid tween completes, tracking goes back to transition-less.
    const end = new Event("transitionend") as TransitionEvent;
    Object.defineProperty(end, "propertyName", {
      value: "grid-template-columns",
    });
    shell.dispatchEvent(end);
    expect(shell.style.transition).toBe("none");
    expect(composer.style.transition).toBe("none");

    window.dispatchEvent(pointerEvent("pointerup", 260));
    expect(shell.style.transition).toBe("");
    expect(composer.style.transition).toBe("");
  });

  it("does not apply docked composer transitions to the new-session hero composer", () => {
    const { shell, handle, composer } = setupResizeDom(
      "expanded",
      'data-hero="true"',
    );

    handleSidebarResizeStart(reactPointerEvent(handle, 240), 240, {
      collapseWidth: 160,
      minWidth: 188,
      maxWidth: () => 320,
      onStart: vi.fn(),
      onEnd: vi.fn(),
      commit: (fn) => fn(),
    });

    window.dispatchEvent(pointerEvent("pointermove", 100));

    expect(shell.dataset.sidebarPreview).toBe("collapsed");
    expect(composer.style.transition).toBe("");

    window.dispatchEvent(pointerEvent("pointerup", 100));
  });

  it("keeps hero composer offsets auto under sidebar preview CSS", () => {
    setupResizeDom("expanded", 'data-hero="true"');
    const shell = document.querySelector(".app-shell") as HTMLElement;
    const composer = document.querySelector(".agent-composer") as HTMLElement;

    shell.dataset.sidebarPreview = "expanded";
    loadAppStyles();

    const styles = getComputedStyle(composer);
    expect(styles.position).toBe("relative");
    expect(styles.left).toBe("auto");
    expect(styles.right).toBe("auto");
    expect(styles.bottom).toBe("auto");
    expect(styles.top).toBe("auto");
  });
});
