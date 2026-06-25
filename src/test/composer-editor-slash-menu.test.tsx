import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ComposerEditor } from "../components/agent/composer/ComposerEditor";
import type { HermesSkillInfo } from "../lib/tauri";

const skills: HermesSkillInfo[] = [
  {
    name: "skill-creator",
    description: "Create or update a skill.",
    category: "productivity",
    enabled: true,
  },
];

describe("composer slash menu", () => {
  it("dismisses on outside click without removing or retriggering the slash", async () => {
    const user = userEvent.setup();
    render(
      <>
        <ComposerEditor
          placeholder="Message June"
          skills={skills}
          onChange={vi.fn()}
          onSubmit={vi.fn()}
        />
        <button type="button">Outside</button>
      </>,
    );

    const textbox = await screen.findByRole("textbox", {
      name: "Message June",
    });
    await user.type(textbox, "/");
    await waitFor(() =>
      expect(document.querySelector(".agent-category-menu-host")).toBeTruthy(),
    );
    expect(screen.getByRole("option", { name: "Model" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "File" })).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));

    await waitFor(() =>
      expect(document.querySelector(".agent-category-menu-host")).toBeNull(),
    );
    expect(textbox).toHaveTextContent("/");

    await user.click(textbox);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(document.querySelector(".agent-category-menu-host")).toBeNull();
    expect(textbox).toHaveTextContent("/");
  });
});
