import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CategorySuggestionList } from "../components/agent/composer/CategorySuggestionList";

describe("category suggestion list", () => {
  it("keeps rows compact and moves skill descriptions to hover detail", () => {
    const command = vi.fn();

    render(
      <CategorySuggestionList
        command={command}
        items={[
          {
            kind: "skill",
            skill: {
              name: "skill-creator",
              description: "Create new skills and improve existing skills.",
              category: "Personal",
              enabled: true,
            },
          },
        ]}
      />,
    );

    expect(screen.getByText("Skills")).toBeInTheDocument();
    expect(screen.getByText("skill-creator")).toBeInTheDocument();
    expect(
      screen.queryByText("Create new skills and improve existing skills."),
    ).not.toBeInTheDocument();

    fireEvent.focus(screen.getByRole("option", { name: /skill-creator/i }));

    expect(screen.getByText("Create new skills and improve existing skills.")).toBeInTheDocument();
  });

  it("keeps the hover detail matched to the active skill row", () => {
    vi.useFakeTimers();
    try {
      render(
        <CategorySuggestionList
          command={vi.fn()}
          items={[
            {
              kind: "skill",
              skill: {
                name: "airtable",
                description: "Manage Airtable records.",
                enabled: true,
              },
            },
            {
              kind: "skill",
              skill: {
                name: "apple-notes",
                description: "Manage Apple Notes via memo CLI.",
                enabled: true,
              },
            },
          ]}
        />,
      );

      fireEvent.mouseEnter(screen.getByRole("option", { name: /apple-notes/i }));
      act(() => vi.advanceTimersByTime(150));
      expect(screen.getByText("Manage Apple Notes via memo CLI.")).toBeInTheDocument();

      fireEvent.mouseEnter(screen.getByRole("option", { name: /airtable/i }));
      act(() => vi.advanceTimersByTime(150));
      expect(screen.getByText("Manage Airtable records.")).toBeInTheDocument();
      expect(screen.queryByText("Manage Apple Notes via memo CLI.")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows edge fades only where the skills list has hidden scroll content", () => {
    render(
      <CategorySuggestionList
        command={vi.fn()}
        items={Array.from({ length: 12 }, (_, index) => ({
          kind: "skill" as const,
          skill: {
            name: `skill-${index}`,
            description: `Skill ${index}`,
            enabled: true,
          },
        }))}
      />,
    );

    const list = screen.getByRole("listbox", { name: "Slash commands" });
    const wrap = list.parentElement;
    expect(wrap).toHaveClass("agent-category-menu-scroll-wrap");

    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 120 },
      scrollHeight: { configurable: true, value: 360 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });

    fireEvent.scroll(list);
    expect(wrap).not.toHaveAttribute("data-fade-top");
    expect(wrap).toHaveAttribute("data-fade-bottom", "true");

    list.scrollTop = 80;
    fireEvent.scroll(list);
    expect(wrap).toHaveAttribute("data-fade-top", "true");
    expect(wrap).toHaveAttribute("data-fade-bottom", "true");

    list.scrollTop = 240;
    fireEvent.scroll(list);
    expect(wrap).toHaveAttribute("data-fade-top", "true");
    expect(wrap).not.toHaveAttribute("data-fade-bottom");
  });
});
