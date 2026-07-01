import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccentWheel } from "../components/settings/AccentWheel";
import type { BrandId } from "../lib/brand";

function Harness() {
  const [value, setValue] = useState<BrandId>("rose");
  return <AccentWheel value={value} onChange={setValue} />;
}

describe("AccentWheel", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the trigger dot persistent while the wheel closes", () => {
    vi.useFakeTimers();
    render(<Harness />);

    fireEvent.click(
      screen.getByRole("button", { name: "Accent color: Rose. Change" }),
    );

    const openGroup = screen.getByRole("radiogroup", {
      name: "Accent color",
    });
    expect(
      within(openGroup).getByRole("radio", { name: "Rose" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      within(openGroup).getByRole("radio", { name: "Clay" }),
    ).toHaveAttribute("aria-checked", "false");

    fireEvent.click(within(openGroup).getByRole("radio", { name: "Blue" }));

    expect(
      screen.getByRole("button", { name: "Accent color: Blue. Change" }),
    ).toBeInTheDocument();
    expect(
      screen
        .getByRole("button", { name: "Accent color: Blue. Change" })
        .style.getPropertyValue("--swatch"),
    ).toBe("#597893");

    const closingGroup = screen.getByRole("radiogroup", {
      name: "Accent color",
    });
    expect(closingGroup).toHaveAttribute("data-phase", "closing");
    expect(
      within(closingGroup).getByRole("radio", { name: "Rose" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      within(closingGroup).getByRole("radio", { name: "Blue" }),
    ).toHaveAttribute("aria-checked", "false");

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(
      screen.queryByRole("radiogroup", { name: "Accent color" }),
    ).not.toBeInTheDocument();
  });

  it("waits to commit the app theme until the wheel has closed", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<AccentWheel value="rose" onChange={onChange} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Accent color: Rose. Change" }),
    );
    fireEvent.click(screen.getByRole("radio", { name: "Blue" }));

    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("radiogroup", { name: "Accent color" }),
    ).toHaveAttribute("data-phase", "closing");

    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("radiogroup", { name: "Accent color" }),
    ).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(onChange).toHaveBeenCalledWith("blue");
    expect(
      screen.queryByRole("radiogroup", { name: "Accent color" }),
    ).not.toBeInTheDocument();
  });

  it("clicking the center trigger again closes the wheel", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<AccentWheel value="rose" onChange={onChange} />);

    const trigger = screen.getByRole("button", {
      name: "Accent color: Rose. Change",
    });
    fireEvent.click(trigger);
    expect(
      screen.getByRole("radiogroup", { name: "Accent color" }),
    ).toHaveAttribute("data-phase", "open");

    fireEvent.click(trigger);
    expect(
      screen.getByRole("radiogroup", { name: "Accent color" }),
    ).toHaveAttribute("data-phase", "closing");

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("radiogroup", { name: "Accent color" }),
    ).not.toBeInTheDocument();
  });
});
