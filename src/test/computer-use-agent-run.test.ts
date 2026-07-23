import { describe, expect, it } from "vitest";
import {
  COMPUTER_USE_AGENT_RUN_TOOLSETS,
  toolsetsForComputerUseAgentRun,
} from "../lib/computer-use-agent-run";

describe("Computer use agent-run tool scope", () => {
  it.each([
    "Use Computer use to open Calculator and click 7.",
    "Please open Calculator using computer-use.",
    "With the Computer use tool: enter 42.",
    "Go through computer use to press equals.",
    "Computer use, open Calculator.",
    "Computer use please open Calculator.",
    "Can you use Computer use to open Calculator?",
  ])("narrows an explicit desktop-control request: %s", (prompt) => {
    expect(toolsetsForComputerUseAgentRun(prompt)).toEqual(COMPUTER_USE_AGENT_RUN_TOOLSETS);
  });

  it.each([
    "What is Computer use?",
    "How do I use Computer use?",
    "Does June use Computer use?",
    "Should I use Computer use to open Calculator?",
    "Tell me whether Computer use is enabled.",
    "Do not use Computer use for this.",
    "Open Calculator without Computer use.",
    "Use the web to find a calculator.",
    "",
  ])("keeps the normal tool surface for a non-request: %s", (prompt) => {
    expect(toolsetsForComputerUseAgentRun(prompt)).toBeNull();
  });
});
