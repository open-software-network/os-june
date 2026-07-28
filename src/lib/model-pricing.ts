import type { VeniceModelDto } from "./tauri";

export function pricingLabel(model: VeniceModelDto) {
  const pricing = model.pricing;
  if (pricing && typeof pricing === "object") {
    const display = (pricing as Record<string, unknown>).display;
    if (typeof display === "string" && display.trim()) return display.trim();
    const input = priceForPath(pricing, ["input", "usd"]);
    const output = priceForPath(pricing, ["output", "usd"]);
    if (input !== undefined && output !== undefined) {
      return `$${formatUsd(input)} in / $${formatUsd(output)} out`;
    }
    const usdValues = collectUsdValues(pricing);
    if (usdValues.length === 1) return `$${formatUsd(usdValues[0])}`;
    if (usdValues.length > 1) {
      const min = Math.min(...usdValues);
      const max = Math.max(...usdValues);
      return min === max ? `$${formatUsd(min)}` : `$${formatUsd(min)}-$${formatUsd(max)}`;
    }
  }
  if (model.priceDescription?.trim()) return model.priceDescription.trim();
  if (model.priceUnit === "seconds" && typeof model.creditsPerMillionSeconds === "number") {
    return `${formatCreditsAsUsdPerUnit(model.creditsPerMillionSeconds, 1_000_000)} per second audio`;
  }
  if (
    model.priceUnit === "tokens" &&
    typeof model.inputCreditsPerMillionTokens === "number" &&
    typeof model.outputCreditsPerMillionTokens === "number"
  ) {
    return `${formatCreditsAsUsd(model.inputCreditsPerMillionTokens)} input / ${formatCreditsAsUsd(model.outputCreditsPerMillionTokens)} output per 1M tokens`;
  }
  return undefined;
}

function priceForPath(value: unknown, path: string[]) {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || !(key in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "number" ? current : undefined;
}

function collectUsdValues(value: unknown): number[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => {
    if (key === "usd" && typeof nested === "number") return [nested];
    return collectUsdValues(nested);
  });
}

function formatUsd(value: number) {
  return value >= 1 ? value.toFixed(2) : value.toFixed(4).replace(/0+$/, "0");
}

export function formatCreditsAsUsd(credits: number) {
  const cents = Math.round(credits / 10);
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function formatCreditsAsUsdPerUnit(credits: number, units: number) {
  if (units <= 0) return "$0.00";
  const microUsd = Math.round((credits * 1_000) / units);
  if (microUsd >= 1_000_000) {
    const cents = Math.round(microUsd / 10_000);
    return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
  }
  return `$0.${String(microUsd).padStart(6, "0").replace(/0+$/, "")}`;
}
