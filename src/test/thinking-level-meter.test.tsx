import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ThinkingLevelMeter } from "../components/ui/ThinkingLevelMeter";

describe("ThinkingLevelMeter", () => {
  it.each([
    { level: "instant", segments: "1" },
    { level: "medium", segments: "2" },
    { level: "hard", segments: "3" },
  ] as const)("shows $segments active segments for $level effort", ({ level, segments }) => {
    const { container } = render(<ThinkingLevelMeter level={level} />);
    const meter = container.querySelector(".thinking-level-meter");

    expect(meter).toHaveAttribute("data-segments", segments);
    expect(meter).toHaveAttribute("aria-hidden", "true");
    // The full three-bar silhouette always renders; data-segments drives
    // which bars light up via CSS.
    expect(meter?.querySelectorAll("rect")).toHaveLength(3);
  });
});
