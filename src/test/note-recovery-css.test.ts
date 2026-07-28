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
  it("centers an unblocked prompt only when the editor is wide enough for one line", () => {
    const editor = cssRuleFor(".editor-content");
    expect(editor).toContain("container-name: note-editor;");
    expect(editor).toContain("container-type: inline-size;");

    const centeredPrompt = ".inline-notice.note-recovery-prompt:not(.note-recovery-prompt-blocked)";
    const centeredIcon =
      ".note-recovery-prompt:not(.note-recovery-prompt-blocked) .inline-notice-icon";
    const wideEditor = cssRuleFor("@container note-editor (min-width: 43em)");

    expect(wideEditor).toContain(`${centeredPrompt} {`);
    expect(wideEditor).toContain("align-items: center;");
    expect(wideEditor).toContain(`${centeredIcon} {`);
    expect(wideEditor).toContain("align-self: center;");
    expect(appCss.split(centeredPrompt)).toHaveLength(2);
    expect(appCss.split(centeredIcon)).toHaveLength(2);
  });

  it("keeps narrow and funding-blocked prompts on the shared first-line alignment", () => {
    expect(cssRuleFor(".inline-notice")).toContain("align-items: first baseline;");
    expect(cssRuleFor(".inline-notice-icon")).toContain("align-self: flex-start;");
    expect(appCss).not.toContain(".inline-notice.note-recovery-prompt-blocked {");
  });
});
