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

describe("download toast styles", () => {
  it("keeps the status on one line and gives overflow space to the filename", () => {
    const message = cssRuleFor(".june-download-toast-message");
    expect(message).toContain("width: 100%;");

    const action = cssRuleFor(".june-download-toast-action");
    expect(action).toContain("flex-shrink: 0;");
    expect(action).toContain("white-space: nowrap;");

    const file = cssRuleFor(".june-download-toast-file");
    expect(file).toContain("flex: 1;");
    expect(file).toContain("min-width: 0;");
    expect(file).toContain("overflow: hidden;");
    expect(file).toContain("text-overflow: ellipsis;");
    expect(file).toContain("white-space: nowrap;");
  });
});
