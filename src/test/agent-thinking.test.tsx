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

it("renders an accessible, layout-stable three-dot typing bubble", () => {
  const { container } = render(<AgentThinking visible variant="typing-bubble" />);

  const status = screen.getByRole("status");
  expect(status).toHaveTextContent("June is typing");
  expect(status).toHaveAttribute("aria-live", "polite");
  expect(status).toHaveAttribute("aria-atomic", "true");
  expect(status).toHaveAttribute("data-variant", "typing-bubble");

  const dots = container.querySelector(".agent-typing-dots");
  expect(dots).toHaveAttribute("aria-hidden", "true");
  expect(dots?.children).toHaveLength(3);
});
