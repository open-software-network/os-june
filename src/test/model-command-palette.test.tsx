import { createRef } from "react";
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

describe("ModelCommandPalette", () => {
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
});
