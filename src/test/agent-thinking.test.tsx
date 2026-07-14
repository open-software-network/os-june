import { render, screen } from "@testing-library/react";
import { MotionGlobalConfig } from "framer-motion";
import { expect, it } from "vitest";
import { AgentThinking } from "../components/agent/AgentThinking";

it("keeps the thinking status mounted for its exit handoff", () => {
  const skipAnimations = MotionGlobalConfig.skipAnimations;
  MotionGlobalConfig.skipAnimations = false;

  const { rerender, unmount } = render(<AgentThinking visible />);
  try {
    const indicator = screen.getByText("Thinking…");

    rerender(<AgentThinking visible />);
    expect(screen.getByText("Thinking…")).toBe(indicator);

    rerender(<AgentThinking visible={false} />);
    expect(indicator).toBeInTheDocument();
  } finally {
    MotionGlobalConfig.skipAnimations = skipAnimations;
    unmount();
  }
});
