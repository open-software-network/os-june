import { describe, expect, it } from "vitest";
import { positionSidebarContextMenu } from "../components/sidebar/sidebar-context-menu";
import appCss from "../styles/app.css?raw";

function cssRuleFor(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{`).exec(appCss);
  if (!match) throw new Error(`Missing CSS rule for ${selector}`);
  const openIndex = match.index + match[0].length - 1;
  const closeIndex = appCss.indexOf("}", openIndex);
  return appCss.slice(openIndex + 1, closeIndex);
}

describe("sidebar overflow containment", () => {
  it("lets completed sessions shrink without displacing the account footer", () => {
    expect(cssRuleFor(".sidebar-completed-section")).toContain("flex: 0 1 auto;");
    expect(cssRuleFor(".sidebar-completed-section")).toContain("overflow: hidden;");
    expect(cssRuleFor(".sidebar-completed-section .notes-nav.sidebar-completed-list")).toContain(
      "min-height: 0;",
    );
    expect(cssRuleFor(".sidebar-agent-section")).toContain("overflow: hidden;");
  });

  it("keeps a menu below its trigger when it fits", () => {
    expect(
      positionSidebarContextMenu(
        { top: 100, bottom: 128, right: 232 },
        { width: 156, height: 180 },
        { width: 800, height: 600 },
      ),
    ).toEqual({ right: 568, top: 132 });
  });

  it("flips a menu above a trigger near the viewport floor", () => {
    expect(
      positionSidebarContextMenu(
        { top: 548, bottom: 576, right: 232 },
        { width: 156, height: 220 },
        { width: 800, height: 600 },
      ),
    ).toEqual({ right: 568, top: 324 });
  });

  it("re-clamps an open menu when the viewport contracts", () => {
    const menu = { width: 156, height: 220 };

    expect(
      positionSidebarContextMenu({ top: 548, bottom: 576, right: 792 }, menu, {
        width: 900,
        height: 620,
      }),
    ).toEqual({ right: 108, top: 324 });
    expect(
      positionSidebarContextMenu({ top: 348, bottom: 376, right: 232 }, menu, {
        width: 640,
        height: 420,
      }),
    ).toEqual({ right: 408, top: 124 });
  });
});
