import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderLogo } from "../components/settings/ProviderLogo";

describe("ProviderLogo", () => {
  it("uses the June mark for Auto regardless of its routing provider", () => {
    render(<ProviderLogo provider="venice" id="open-software/auto" name="Auto" />);

    const juneMark = screen.getByRole("img", { name: "June" });
    expect(juneMark).toBeInTheDocument();
    expect(juneMark.querySelector("rect")).toHaveAttribute("fill", "var(--brand)");
    expect(screen.queryByLabelText("OpenSoftware")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Venice")).not.toBeInTheDocument();
  });

  it("does not classify broad Anthropic family words as Claude", () => {
    render(<ProviderLogo provider="venice" id="poetry-haiku" name="Haiku" />);

    expect(screen.queryByLabelText("Claude")).not.toBeInTheDocument();
  });

  it("classifies xAI providers as Grok", () => {
    render(<ProviderLogo provider="xai" id="grok-4" name="Grok 4" />);

    expect(screen.getByLabelText("Grok")).toBeInTheDocument();
  });
});
