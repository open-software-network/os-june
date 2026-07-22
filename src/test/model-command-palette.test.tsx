import { createRef, useRef, useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ModelCommandPalette } from "../components/settings/ModelPickerPopover";
import { DEFAULT_GENERATION_SUGGESTION_ID } from "../lib/suggested-models";
import type { VeniceModelDto } from "../lib/tauri";
import type { ThinkingLevel } from "../lib/thinking-level";

const model = (id: string, name: string, privacy: string): VeniceModelDto => ({
  provider: "venice",
  id,
  name,
  modelType: "text",
  privacy,
  traits: [],
  capabilities: ["supportsFunctionCalling"],
});

function SearchablePalette({
  model: selected,
  options,
  onSelect = vi.fn(),
  costQuality,
  onCostQualityChange,
  thinkingLevel,
  onSelectThinking,
}: {
  model?: VeniceModelDto;
  options: VeniceModelDto[];
  onSelect?: (modelId: string, selectOptions?: { keepOpen?: boolean }) => void;
  costQuality?: number;
  onCostQualityChange?: (value: number) => void;
  thinkingLevel?: ThinkingLevel;
  onSelectThinking?: (level: ThinkingLevel) => void;
}) {
  const [search, setSearch] = useState("");
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  return (
    <ModelCommandPalette
      model={selected}
      options={options}
      search={search}
      popoverRef={popoverRef}
      searchRef={searchRef}
      costQuality={costQuality}
      onCostQualityChange={onCostQualityChange}
      thinkingLevel={thinkingLevel}
      onSelectThinking={onSelectThinking}
      onSearchChange={setSearch}
      onSelect={onSelect}
    />
  );
}

const autoModel = {
  provider: "venice",
  id: "open-software/auto",
  name: "OpenSoftware Auto",
  modelType: "text",
  traits: [],
  capabilities: [],
} satisfies VeniceModelDto;

describe("ModelCommandPalette", () => {
  it("pins the Auto router as a separate toggle when its catalog entry has no capability flags", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const current = model("zai-org-glm-5-2", "GLM 5.2", "private");

    render(
      <SearchablePalette
        model={current}
        options={[
          {
            provider: "venice",
            id: "open-software/auto",
            name: "OpenSoftware Auto",
            modelType: "text",
            traits: [],
            capabilities: [],
          },
          current,
        ]}
        onSelect={onSelect}
      />,
    );

    const autoToggle = screen.getByRole("switch", { name: "Choose the model automatically" });
    const autoSection = autoToggle.closest(".agent-composer-model-command-auto");
    expect(autoToggle).not.toBeChecked();
    expect(autoSection).toHaveTextContent(/^Auto$/);
    expect(autoSection?.querySelector("svg")).toBeNull();
    expect(screen.getByRole("group", { name: "Suggested" })).not.toHaveTextContent("Auto");

    await user.click(screen.getByRole("switch", { name: "Only show private models" }));
    expect(autoToggle).toBeInTheDocument();

    await user.type(screen.getByRole("combobox", { name: "Search models" }), "auto");
    expect(screen.queryByRole("group", { name: "Suggested" })).not.toBeInTheDocument();
    expect(screen.queryByText("No private models match your search.")).not.toBeInTheDocument();
    await user.click(autoToggle);
    expect(onSelect).toHaveBeenCalledWith("open-software/auto", { keepOpen: true });
  });

  it("turns Auto off by selecting the leading concrete suggestion", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(
      <SearchablePalette
        model={autoModel}
        options={[autoModel, model("zai-org-glm-5-2", "GLM 5.2", "private")]}
        onSelect={onSelect}
      />,
    );

    const autoToggle = screen.getByRole("switch", { name: "Choose the model automatically" });
    expect(autoToggle).toBeChecked();
    await user.click(autoToggle);
    expect(onSelect).toHaveBeenCalledWith("zai-org-glm-5-2", { keepOpen: true });
  });

  it("disables Auto off when a loaded catalog has no eligible concrete model", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const toollessConcrete: VeniceModelDto = {
      ...model("toolless", "Toolless", "private"),
      capabilities: [],
    };

    render(
      <SearchablePalette
        model={autoModel}
        options={[autoModel, toollessConcrete]}
        onSelect={onSelect}
      />,
    );

    const autoToggle = screen.getByRole("switch", { name: "Choose the model automatically" });
    expect(autoToggle).toBeChecked();
    expect(autoToggle).toBeDisabled();
    await user.click(autoToggle);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps Auto off actionable on the curated default while the catalog is unloaded", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(<SearchablePalette model={autoModel} options={[autoModel]} onSelect={onSelect} />);

    const autoToggle = screen.getByRole("switch", { name: "Choose the model automatically" });
    expect(autoToggle).toBeChecked();
    expect(autoToggle).toBeEnabled();
    await user.click(autoToggle);
    expect(onSelect).toHaveBeenCalledWith(DEFAULT_GENERATION_SUGGESTION_ID, { keepOpen: true });
  });

  it("shows inline Preference and Effort rows while Auto is on and hides them during search", async () => {
    const user = userEvent.setup();
    const onCostQualityChange = vi.fn();
    const onSelectThinking = vi.fn();

    render(
      <SearchablePalette
        model={autoModel}
        options={[autoModel, model("zai-org-glm-5-2", "GLM 5.2", "private")]}
        costQuality={50}
        onCostQualityChange={onCostQualityChange}
        thinkingLevel="medium"
        onSelectThinking={onSelectThinking}
      />,
    );

    const preference = screen.getByRole("radiogroup", { name: "Auto preference" });
    const effort = screen.getByRole("radiogroup", { name: "Thinking level" });
    expect(within(preference).getByRole("radio", { name: "Balanced" })).toBeChecked();
    expect(within(effort).getByRole("radio", { name: "Medium" })).toBeChecked();
    // Each effort chip carries its own meter state for carryover with the
    // composer trigger.
    expect(effort.querySelectorAll(".thinking-level-meter")).toHaveLength(3);

    await user.click(within(preference).getByRole("radio", { name: "Quality" }));
    expect(onCostQualityChange).toHaveBeenCalledWith(100);
    await user.click(within(effort).getByRole("radio", { name: "High" }));
    expect(onSelectThinking).toHaveBeenCalledWith("hard");

    await user.type(screen.getByRole("combobox", { name: "Search models" }), "glm");
    expect(screen.queryByRole("radiogroup", { name: "Auto preference" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Thinking level" })).not.toBeInTheDocument();
  });

  it("omits the Preference row while a concrete model is selected", () => {
    render(
      <SearchablePalette
        model={model("zai-org-glm-5-2", "GLM 5.2", "private")}
        options={[autoModel, model("zai-org-glm-5-2", "GLM 5.2", "private")]}
        costQuality={50}
        onCostQualityChange={vi.fn()}
        thinkingLevel="medium"
        onSelectThinking={vi.fn()}
      />,
    );

    expect(screen.queryByRole("radiogroup", { name: "Auto preference" })).not.toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Thinking level" })).toBeInTheDocument();
  });

  it("renders the catalog before a current selection is resolved", () => {
    render(
      <ModelCommandPalette
        options={[model("zai-org-glm-5-2", "GLM 5.2", "private")]}
        search=""
        popoverRef={createRef<HTMLDivElement>()}
        searchRef={createRef<HTMLInputElement>()}
        onSearchChange={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Choose text model" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /GLM 5\.2/ })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("filters suggested and catalog rows to private models", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ModelCommandPalette
        model={model("zai-org-glm-5-2", "GLM 5.2", "private")}
        options={[
          model("zai-org-glm-5-2", "GLM 5.2", "private"),
          model("kimi-k3", "Kimi K3", "anonymized"),
          model("kimi-k2-6", "Kimi K2.6", "private"),
          model("private-extra", "Private Extra", "private"),
          model("anonymous-extra", "Anonymous Extra", "anonymized"),
        ]}
        search=""
        popoverRef={createRef<HTMLDivElement>()}
        searchRef={createRef<HTMLInputElement>()}
        onSearchChange={vi.fn()}
        onSelect={onSelect}
      />,
    );

    expect(screen.getByRole("option", { name: /Kimi K3/ })).toBeInTheDocument();
    expect(screen.getAllByRole("option", { name: /Kimi K3/ })).toHaveLength(1);
    expect(screen.getByRole("option", { name: /Kimi K2\.6/ })).toBeInTheDocument();
    expect(screen.getAllByRole("option", { name: /Kimi K2\.6/ })).toHaveLength(1);
    expect(screen.getByRole("option", { name: /Anonymous Extra/ })).toBeInTheDocument();
    expect(screen.getByText("All models")).toBeInTheDocument();

    const search = screen.getByRole("combobox", { name: "Search models" });
    await user.click(search);
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledWith("kimi-k2-6");

    await user.click(screen.getByRole("switch", { name: "Only show private models" }));

    expect(screen.getByRole("option", { name: /GLM 5\.2/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Kimi K2\.6/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Private Extra/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Kimi K3/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Anonymous Extra/ })).not.toBeInTheDocument();
  });

  it("matches natural queries across punctuation and separated terms", async () => {
    const user = userEvent.setup();
    render(
      <SearchablePalette
        options={[
          model("openai-gpt-54", "GPT-5.4", "anonymized"),
          model("openai-gpt-55", "GPT-5.5", "anonymized"),
          model("claude-opus-4-8-fast", "Claude Opus 4.8 Fast", "anonymized"),
        ]}
      />,
    );

    const search = screen.getByRole("combobox", { name: "Search models" });
    await user.type(search, "gpt 5.4");

    expect(screen.getByRole("option", { name: /GPT-5\.4/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /GPT-5\.5/ })).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "opus fast");

    expect(screen.getByRole("option", { name: /Claude Opus 4\.8 Fast/ })).toBeInTheDocument();
  });
});
