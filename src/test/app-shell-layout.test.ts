import { describe, expect, it } from "vitest";
import appSrc from "../app/App.tsx?raw";
import mainSrc from "../main.tsx?raw";
import appCss from "../styles/app.css?raw";

// JUN-237: with the sidebar collapsed (display: none), the shell grid lost the
// 100vh sidebar that propped its single implicit row up to full height. Any
// stray in-flow child of .app-shell (the sonner toast host <section> at the
// time) then wrapped into a second implicit row, and the row split left a
// blank strip under the main panel. Two guards keep that from coming back:
// the shell pins itself to one full-height row, and the toast host stays
// mounted outside App's shell grid.

function cssRuleFor(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{`).exec(appCss);
  if (!match) throw new Error(`Missing CSS rule for ${selector}`);
  const openIndex = match.index + match[0].length - 1;
  const closeIndex = appCss.indexOf("}", openIndex);
  return appCss.slice(openIndex + 1, closeIndex);
}

describe("app shell layout (JUN-237)", () => {
  it("pins the shell grid to one full-height row", () => {
    const rule = cssRuleFor(".app-shell");
    expect(rule).toContain("grid-template-rows: minmax(0, 100%);");
  });

  it("keeps the toast host out of the app shell grid", () => {
    // The sonner host renders a real in-flow <section>; inside .app-shell it
    // becomes a grid item and re-opens the bottom gap. It mounts in main.tsx,
    // beside <App />, never inside it.
    expect(appSrc).not.toContain("<Toaster");
    expect(mainSrc).toContain("<Toaster />");
  });
});
