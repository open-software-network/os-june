import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HoverTip } from "../components/ui/HoverTip";

describe("HoverTip", () => {
  it("programmatically links the anchor to the tooltip", () => {
    render(
      <HoverTip tip="Private model with zero data retention." tabIndex={0}>
        Private mode
      </HoverTip>,
    );

    const anchor = screen.getByText("Private mode");
    fireEvent.focus(anchor);

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("Private model with zero data retention.");
    expect(anchor).toHaveAttribute("aria-describedby", tooltip.id);
  });

  it("preserves existing described-by references", () => {
    render(
      <>
        <span id="existing-help">Existing help</span>
        <HoverTip tip="Extra tooltip help." tabIndex={0} aria-describedby="existing-help">
          Unrestricted
        </HoverTip>
      </>,
    );

    const anchor = screen.getByText("Unrestricted");
    fireEvent.focus(anchor);

    const tooltip = screen.getByRole("tooltip");
    expect(anchor.getAttribute("aria-describedby")?.split(" ")).toEqual([
      "existing-help",
      tooltip.id,
    ]);
  });
});
