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

describe("Home polish styles", () => {
  it("gives the Home thread room at the top edge", () => {
    const timeline = cssRuleFor('.agent-timeline[data-home="true"]');

    expect(timeline).toContain("padding-top: var(--sp-8);");
  });

  it("aligns idle suggestions with the composer and keeps the pending mark bare", () => {
    const nudges = cssRuleFor(".agent-home-nudges-idle");
    const pending = cssRuleFor(".agent-home-task-pending");

    expect(nudges).toContain("padding-inline: 0;");
    expect(pending).not.toMatch(/^\s*width:/m);
    expect(pending).not.toMatch(/^\s*height:/m);
    expect(pending).not.toMatch(/^\s*padding:/m);
    expect(pending).toContain("justify-self: start;");
  });

  it("keeps the editor width stable when a draft wraps", () => {
    const editor = cssRuleFor('.agent-workspace[data-home="true"] .agent-composer-editor-root');
    const multiline = cssRuleFor(
      '.agent-workspace[data-home="true"] .agent-composer-box[data-multiline]',
    );
    const multilineEditor = cssRuleFor(
      '.agent-workspace[data-home="true"] .agent-composer-box[data-multiline] .agent-composer-editor-root',
    );
    const multilineAttach = cssRuleFor(
      '.agent-workspace[data-home="true"] .agent-composer-box[data-multiline] .agent-composer-attach',
    );

    expect(editor).toContain("grid-column: 2;");
    expect(multiline).toContain("align-items: end;");
    expect(multilineEditor).toContain("grid-row: 1;");
    expect(multilineEditor).toContain("grid-column: 1 / -1;");
    expect(multilineAttach).toContain("grid-row: 2;");
  });

  it("aligns a wrapped Home draft with the conversation rail", () => {
    const timeline = cssRuleFor('.agent-timeline[data-home="true"]');
    const multilineEditor = cssRuleFor(
      '.agent-workspace[data-home="true"] .agent-composer-box[data-multiline] .agent-composer-editor',
    );

    expect(timeline).toContain("padding-inline: calc(var(--sp-px) + var(--sp-1) + var(--sp-2));");
    expect(multilineEditor).toContain("padding-inline: var(--sp-2);");
  });

  it("preserves whole words when markdown tables calculate column widths", () => {
    const cells = cssRuleFor(".agent-md-table th,\n.agent-md-table td");

    expect(cells).toContain("overflow-wrap: break-word;");
    expect(cells).toContain("vertical-align: top;");
  });

  it("lets the small Home character acknowledge hover with a wink", () => {
    const character = cssRuleFor(".agent-home-listening");
    const wink = cssRuleFor(".agent-home-listening:hover .june-bloom-wink");

    expect(character).toContain("pointer-events: auto;");
    expect(wink).toContain("opacity: 1;");
    expect(appCss).toContain(
      "animation: june-bloom-hover-eyes-wink calc(var(--t-slow) * 2) step-end 1;",
    );
  });

  it("drops a composer edge fade immediately when it reaches the visible caret", () => {
    const endCaret = cssRuleFor('.agent-composer-editor-root[data-caret-edge="end"]::after');

    expect(endCaret).toContain("opacity: 0;");
    expect(endCaret).toContain("transition: none;");
  });
});
