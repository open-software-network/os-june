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
  it("keeps hidden per-message controls compact in flow", () => {
    expect(cssRuleFor(".agent-turn-actions")).toContain(
      "margin-top: var(--sp-px);",
    );
    expect(cssRuleFor(".agent-turn-action")).toContain(
      "padding: var(--sp-px) var(--sp-1);",
    );
  });
});
