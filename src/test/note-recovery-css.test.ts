import { describe, expect, it } from "vitest";
import appCss from "../styles/app.css?raw";

function cssRuleFor(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{`).exec(appCss);
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

describe("note recovery prompt alignment", () => {
  it("centers only the explicit measured single-line variant", () => {
    expect(cssRuleFor(".inline-notice.note-recovery-prompt-single-line")).toContain(
      "align-items: center;",
    );
    expect(cssRuleFor(".note-recovery-prompt-single-line .inline-notice-icon")).toContain(
      "align-self: center;",
    );
  });

  it("keeps wrapped and funding-blocked prompts on the shared first-line alignment", () => {
    expect(cssRuleFor(".inline-notice")).toContain("align-items: first baseline;");
    expect(cssRuleFor(".inline-notice-icon")).toContain("align-self: flex-start;");
    expect(appCss).not.toContain(".inline-notice.note-recovery-prompt-blocked {");
    expect(appCss).not.toContain("container-name: note-editor;");
    expect(appCss).not.toContain("@container note-editor");
  });
});
