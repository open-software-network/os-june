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

describe("agent turn action styles", () => {
  it("collapses hidden per-message controls to zero height so non-hovered rows stay tight", () => {
    // opacity alone (the JUN-114 regression) left the row in flow and reserved
    // its full height under every message. Collapse it to a 0fr grid row when
    // hidden so non-hovered messages sit tight; hover opens it to 1fr.
    expect(cssRuleFor(".agent-turn-actions")).toContain(
      "grid-template-rows: 0fr;",
    );
    // The inner row is clipped so the collapse actually hides the buttons.
    const inner = cssRuleFor(".agent-turn-actions-inner");
    expect(inner).toContain("min-height: 0;");
    expect(inner).toContain("overflow: hidden;");
    // Hover reveals it without reserving space when hidden.
    expect(appCss).toContain("grid-template-rows: 1fr;");
  });
});
