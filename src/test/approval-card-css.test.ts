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

describe("approval card styles", () => {
  it("keeps long links inside approval cards", () => {
    expect(cssRuleFor(".agent-approval-card > div")).toContain("min-width: 0;");
    expect(cssRuleFor(".agent-approval-card p")).toContain(
      "overflow-wrap: anywhere;",
    );
    expect(cssRuleFor(".agent-approval-card pre")).toContain(
      "max-width: 100%;",
    );
    expect(cssRuleFor(".agent-approval-card pre")).toContain(
      "overflow-wrap: anywhere;",
    );
  });
});
