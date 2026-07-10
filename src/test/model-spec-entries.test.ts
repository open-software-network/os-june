import { describe, expect, it } from "vitest";
import { modelSpecEntries } from "../components/settings/ModelPickerDialog";
import type { VeniceModelDto } from "../lib/tauri";

function model(overrides: Partial<VeniceModelDto>): VeniceModelDto {
  return {
    provider: "venice",
    id: "test-model",
    name: "Test model",
    modelType: "text",
    traits: [],
    capabilities: [],
    ...overrides,
  } as VeniceModelDto;
}

describe("modelSpecEntries", () => {
  it("shows June's billed credit price, never the raw upstream pricing", () => {
    // Raw upstream pricing ($2/$6) is present but must be ignored: the backend
    // keeps `pricing` as reference metadata and bills from the credit price
    // (with margin), which here formats to $30 / $60.
    const entries = modelSpecEntries(
      model({
        priceUnit: "tokens",
        pricing: { input: { usd: 2 }, output: { usd: 6 } },
        inputCreditsPerMillionTokens: 30_000,
        outputCreditsPerMillionTokens: 60_000,
      }),
    );
    expect(entries).toContainEqual({ label: "Input", value: "$30.00 /1M" });
    expect(entries).toContainEqual({ label: "Output", value: "$60.00 /1M" });
    const joined = entries.map((entry) => entry.value).join(" ");
    expect(joined).not.toContain("$2.00");
    expect(joined).not.toContain("$6.00");
  });

  it("falls back to the shared pricing label when there is no credit split", () => {
    const entries = modelSpecEntries(
      model({ priceUnit: "images", priceDescription: "$0.01 per image" }),
    );
    expect(entries).toContainEqual({ label: "Pricing", value: "$0.01 per image" });
  });

  it("appends a formatted context window", () => {
    const entries = modelSpecEntries(model({ contextTokens: 128_000 }));
    expect(entries).toContainEqual({ label: "Context", value: "128K tokens" });
  });
});
