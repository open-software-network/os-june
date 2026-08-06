import { afterEach, describe, expect, it } from "vitest";
import { applyBrandVar, BRAND_PRESETS } from "../lib/brand";
import appCss from "../styles/app.css?raw";
import tokensCss from "../styles/tokens.css?raw";

function cssRuleFor(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{`).exec(css);
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

describe("Clovy theme-state parity", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-brand");
    document.documentElement.style.removeProperty("--brand");
    document.documentElement.style.removeProperty("--brand-wash");
  });

  it("lifts the semantic accent and flips its foreground in dark mode", () => {
    const darkTokens = cssRuleFor(tokensCss, '[data-theme="dark"]');

    expect(darkTokens).toContain("--primary: var(--brand-bright);");
    expect(darkTokens).toContain("--primary-foreground: var(--clovy-ink);");
  });

  it("routes onboarding progress and checked switches through the semantic accent", () => {
    const progress = cssRuleFor(appCss, '.onboarding-progress-seg[data-state="current"]');
    const checkedSwitch = cssRuleFor(appCss, '.switch[data-state="checked"]');

    expect(progress).toContain("background: var(--primary);");
    expect(checkedSwitch).toContain("background: var(--primary);");
  });

  it("clears the active highlight from dormant send controls", () => {
    const send = cssRuleFor(appCss, ".agent-composer-send:disabled");
    const steerSend = cssRuleFor(appCss, ".agent-composer-steer-send:disabled");

    expect(send).toContain("box-shadow: none;");
    expect(steerSend).toContain("box-shadow: none;");
  });

  it("routes active composer sends through the selected Appearance accent", () => {
    const send = cssRuleFor(appCss, ".agent-composer-send");
    const steerSend = cssRuleFor(appCss, ".agent-composer-steer-send");

    for (const rule of [send, steerSend]) {
      expect(rule).toContain("background: var(--primary);");
      expect(rule).toContain("color: var(--primary-foreground);");
      expect(rule).not.toContain("var(--primary-action-background)");
    }
  });

  it("uses the active Appearance accent for home shortcut icons", () => {
    const icon = cssRuleFor(appCss, ".agent-hero-chip-icon");

    expect(icon).toContain("color: var(--primary);");
  });

  it("themes the living Home character without changing its identity default", () => {
    const identityCharacter = cssRuleFor(appCss, ".clovy-alive");
    const homeCharacter = cssRuleFor(appCss, '.clovy-alive[data-palette="appearance"]');
    const sageCharacter = cssRuleFor(
      appCss,
      ':root[data-brand="sage"] .clovy-alive[data-palette="appearance"]',
    );

    expect(identityCharacter).toContain("--clovy-alive-fill-bottom: var(--clovy-glow);");
    expect(homeCharacter).toContain("--clovy-alive-fill-bottom: var(--primary);");
    expect(homeCharacter).toContain("--clovy-alive-depth-color: color-mix(");
    expect(homeCharacter).toContain("var(--primary) 68%");
    expect(homeCharacter).toContain("var(--clovy-ink)");
    expect(sageCharacter).toContain("--clovy-alive-fill-bottom: var(--clovy-glow);");
    expect(sageCharacter).toContain("--clovy-alive-sheen-color: var(--clovy-lime-top);");
  });

  it.each(BRAND_PRESETS)("exposes $id as the active Appearance preset", ({ id }) => {
    applyBrandVar(id);

    expect(document.documentElement).toHaveAttribute("data-brand", id);
  });
});
