import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Select } from "../components/ui/Select";

describe("Select", () => {
  it("does not mount a popover when the viewport has no usable width", () => {
    vi.stubGlobal("innerWidth", 20);

    try {
      render(
        <Select
          ariaLabel="Accent color"
          onChange={vi.fn()}
          options={[{ color: "#b5551f", label: "Clay", value: "clay" }]}
          placeholder="Clay"
          value="clay"
        />,
      );
      const trigger = screen.getByRole("button", { name: "Accent color" });
      const control = trigger.parentElement;
      if (!control) throw new Error("Select trigger is missing its control wrapper");
      vi.spyOn(control, "getBoundingClientRect").mockReturnValue({
        bottom: 82,
        left: 0,
        top: 50,
        width: 128,
      } as DOMRect);

      fireEvent.click(trigger);

      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
