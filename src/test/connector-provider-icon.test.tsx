import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConnectorProviderIcon } from "../components/connectors/ConnectorProviderIcon";

describe("ConnectorProviderIcon", () => {
  it("renders the GitHub mark with the Google mark's decorative semantics", () => {
    const google = render(<ConnectorProviderIcon provider="google" />).container.querySelector(
      "svg",
    );
    const github = render(<ConnectorProviderIcon provider="github" />).container.querySelector(
      "svg",
    );

    expect(google).toHaveAttribute("aria-hidden", "true");
    expect(google).not.toHaveAttribute("role");
    expect(github).toHaveAttribute("aria-hidden", "true");
    expect(github).not.toHaveAttribute("role");
    expect(github?.innerHTML).not.toBe(google?.innerHTML);
  });
});
