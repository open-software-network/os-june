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
  it("keeps an asynchronously growing menu above a short viewport composer", async () => {
    const user = userEvent.setup();
    const innerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 174 });
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains("agent-composer-box")) {
          return new DOMRect(20, 80, 600, 80);
        }
        // WKWebView can report a zero-height portal on the synchronous first
        // placement pass, before React has painted the suggestion rows.
        if (this.classList.contains("agent-category-menu-host")) {
          return new DOMRect(20, 0, 600, 0);
        }
        return new DOMRect();
      });

    try {
      const composer = (availableSkills: HermesSkillInfo[] | null) => (
        <div className="agent-composer-box">
          <ComposerEditor
            placeholder="Message June"
            skills={availableSkills}
            onChange={vi.fn()}
            onSubmit={vi.fn()}
          />
        </div>
      );
      const view = render(composer(null));

      await user.type(await screen.findByRole("textbox", { name: "Message June" }), "/");
      const host = await waitFor(() => {
        const element = document.querySelector<HTMLElement>(".agent-category-menu-host");
        expect(element).toBeTruthy();
        return element as HTMLElement;
      });
      view.rerender(
        composer(
          Array.from({ length: 12 }, (_, index) => ({
            name: `skill-${index}`,
            description: `Skill ${index}`,
            enabled: true,
          })),
        ),
      );
      await screen.findByRole("option", { name: "skill-11" });

      expect(host.style.top).toBe("");
      expect(host.style.bottom).toBe("100px");
      expect(host.style.getPropertyValue("--agent-category-menu-max-height")).toBe("66px");
    } finally {
      rect.mockRestore();
      if (innerHeight) Object.defineProperty(window, "innerHeight", innerHeight);
    }
  });

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
    await waitFor(() => expect(document.querySelector(".agent-category-menu-host")).toBeTruthy());
    expect(screen.getByRole("option", { name: "Model" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "File" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "skill-creator" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Bug report" })).toBeNull();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));

    await waitFor(() => expect(document.querySelector(".agent-category-menu-host")).toBeNull());
    expect(textbox).toHaveTextContent("/");

    await user.click(textbox);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(document.querySelector(".agent-category-menu-host")).toBeNull();
    expect(textbox).toHaveTextContent("/");
  });
});
