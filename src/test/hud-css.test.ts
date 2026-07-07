import { describe, expect, it } from "vitest";
import hudCss from "../styles/hud.css?raw";
import tokensCss from "../styles/tokens.css?raw";

function cssRuleFor(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{`).exec(css);
  if (!match) throw new Error(`Missing CSS rule for ${selector}`);
  const openIndex = match.index + match[0].length - 1;
  let depth = 0;
  for (let index = openIndex; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(openIndex + 1, index);
    }
  }
  throw new Error(`Unclosed CSS rule for ${selector}`);
}

describe("dictation HUD styles", () => {
  it("uses a compact overlay shadow that fits the HUD window gutter", () => {
    expect(tokensCss).toContain("--shadow-hud:");
    expect(cssRuleFor(hudCss, ".hud")).toContain("box-shadow: var(--shadow-hud);");
    expect(cssRuleFor(hudCss, ".hud-error-layer")).toContain("box-shadow: var(--shadow-hud);");
    expect(cssRuleFor(hudCss, ".hud")).not.toContain("box-shadow: var(--shadow-md);");
  });
});
