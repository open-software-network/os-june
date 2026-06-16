import { describe, expect, it } from "vitest";
import appCss from "../styles/app.css?raw";

function zIndexFor(selector: string) {
  const escaped = selector.replace(/\./g, "\\.");
  const match = appCss.match(
    new RegExp(`${escaped}\\s*\\{[\\s\\S]*?z-index:\\s*(\\d+)`),
  );
  if (!match) throw new Error(`Missing z-index for ${selector}`);
  return Number(match[1]);
}

describe("dialog layering", () => {
  it("keeps modal dialogs above the titlebar tab strip", () => {
    expect(zIndexFor(".dialog-backdrop")).toBeGreaterThan(
      zIndexFor(".tab-bar"),
    );
  });

  it("keeps modal dialogs above the sidebar toggle", () => {
    expect(zIndexFor(".dialog-backdrop")).toBeGreaterThan(
      zIndexFor(".chrome-sidebar-toggle"),
    );
  });

  it("keeps hover tips above dialogs", () => {
    expect(zIndexFor(".hover-tip")).toBeGreaterThan(
      zIndexFor(".dialog-backdrop"),
    );
  });
});
