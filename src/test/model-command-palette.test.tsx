import { createRef, useRef, useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ModelCommandPalette } from "../components/settings/ModelPickerPopover";
import type { VeniceModelDto } from "../lib/tauri";

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
}: {
  model?: VeniceModelDto;
  options: VeniceModelDto[];
  onSelect?: (modelId: string) => void;
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
      onSearchChange={setSearch}
      onSelect={onSelect}
    />
  );
}

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
    expect(onSelect).toHaveBeenCalledWith("open-software/auto");
  });

  it("turns Auto off by selecting the leading concrete suggestion", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const auto = {
      provider: "venice",
      id: "open-software/auto",
      name: "OpenSoftware Auto",
      modelType: "text",
      traits: [],
      capabilities: [],
    } satisfies VeniceModelDto;

    render(
      <SearchablePalette
        model={auto}
        options={[auto, model("zai-org-glm-5-2", "GLM 5.2", "private")]}
        onSelect={onSelect}
      />,
    );

    const autoToggle = screen.getByRole("switch", { name: "Choose the model automatically" });
    expect(autoToggle).toBeChecked();
    await user.click(autoToggle);
    expect(onSelect).toHaveBeenCalledWith("zai-org-glm-5-2");
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
