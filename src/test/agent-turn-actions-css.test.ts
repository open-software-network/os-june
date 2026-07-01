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
  it("reveals per-message controls without animating or changing row height", () => {
    const actions = cssRuleFor(".agent-turn-actions");
    expect(actions).toContain("position: absolute;");
    expect(actions).toContain("inset-block-start: 100%;");
    expect(actions).toContain("opacity: 0;");
    expect(actions).toContain("pointer-events: none;");
    expect(actions).toContain("transition: none;");
    expect(actions).not.toContain("grid-template-rows");

    expect(appCss).toContain(`.agent-user-turn:hover .agent-turn-actions,
.agent-user-turn:focus-within .agent-turn-actions,
.agent-assistant-turn:hover .agent-turn-actions,
.agent-assistant-turn:focus-within .agent-turn-actions {
  opacity: 1;
  pointer-events: auto;
}`);
  });

  it("styles the action row as a floating pill", () => {
    const inner = cssRuleFor(".agent-turn-actions-inner");
    expect(inner).toContain("background: var(--popover);");
    expect(inner).toContain("border: 1px solid var(--border);");
    expect(inner).toContain("width: fit-content;");
  });
});
