import { describe, expect, it } from "vitest";
import appCss from "../styles/app.css?raw";

function cssRuleFor(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{`).exec(appCss);
  if (!match) throw new Error(`Missing CSS rule for ${selector}`);
  const openIndex = match.index + match[0].length - 1;
  let depth = 0;
  for (let index = openIndex; index < appCss.length; index += 1) {
    if (appCss[index] === "{") depth += 1;
    if (appCss[index] === "}") {
      depth -= 1;
      if (depth === 0) return appCss.slice(openIndex + 1, index);
    }
  }
  throw new Error(`Unclosed CSS rule for ${selector}`);
}

describe("agent scroll-to-latest styles", () => {
  it("floats the pill absolutely (never fixed) above the composer", () => {
    const rule = cssRuleFor(".agent-scroll-to-latest");
    // WKWebView clips composited fixed elements to the overflow-hidden card.
    expect(rule).toContain("position: absolute;");
    expect(rule).not.toContain("position: fixed;");
    // Rides the fixed composer's top edge so a growing box pushes it up.
    expect(rule).toContain("bottom: calc(100% + var(--sp-2));");
    expect(rule).toContain("border-radius: var(--r-pill);");
    expect(rule).toContain("background: var(--popover);");
    expect(rule).toContain("box-shadow: var(--shadow-sm);");
    // Inert at rest: no stray click target or tab stop when hidden.
    expect(rule).toContain("opacity: 0;");
    expect(rule).toContain("pointer-events: none;");
  });

  it("reveals and re-enables the pill only when visible", () => {
    const rule = cssRuleFor('.agent-scroll-to-latest[data-visible="true"]');
    expect(rule).toContain("opacity: 1;");
    expect(rule).toContain("pointer-events: auto;");
  });
});
