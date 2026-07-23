import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeEvent, AgentSessionDto } from "../lib/agent-runtime-contract";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  runtimeListener: undefined as ((event: { payload: AgentRuntimeEvent }) => void) | undefined,
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: vi.fn((path: string) => path),
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(
    async (_name: string, listener: (event: { payload: AgentRuntimeEvent }) => void) => {
      mocks.runtimeListener = listener;
      return vi.fn();
    },
  ),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { AgentWorkspace } from "../components/agent/AgentWorkspace";

const session: AgentSessionDto = {
  id: "session-1",
  title: "Existing session",
  status: "idle",
  model: "auto",
  safetyMode: "sandboxed",
  workspacePath: "/tmp/session-1",
  source: "user",
  createdAt: "2026-07-22T12:00:00Z",
  updatedAt: "2026-07-22T12:00:00Z",
};

describe("AgentWorkspace runtime wiring", () => {
  beforeEach(() => {
    mocks.runtimeListener = undefined;
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "list_agent_sessions") return Promise.resolve([session]);
      if (command === "get_agent_session") return Promise.resolve(session);
      if (command === "list_agent_items") {
        return Promise.resolve([
          {
            id: "message-1",
            sessionId: session.id,
            sequence: 1,
            createdAt: session.createdAt,
            kind: "message",
            role: "assistant",
            text: "Earlier answer",
            status: "complete",
          },
        ]);
      }
      if (command === "list_agent_artifacts") return Promise.resolve([]);
      if (command === "list_venice_models") {
        return Promise.resolve({
          mode: "generation",
          selectedModel: "auto",
          models: [{ id: "fast", name: "Fast" }],
        });
      }
      if (command === "start_agent_run") {
        return Promise.resolve({
          id: "run-1",
          sessionId: session.id,
          status: "running",
          model: "auto",
        });
      }
      return Promise.resolve(undefined);
    });
  });

  it("hydrates history, shows an optimistic turn, and cancels", async () => {
    render(<AgentWorkspace initialSession={session} />);

    expect(await screen.findByText("Earlier answer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sandboxed" })).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "Model" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Sandboxed" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Model" }), {
      target: { value: "fast" },
    });
    expect(screen.getByRole("button", { name: "Unrestricted" })).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveValue("fast");
    const composer = screen.getByRole("textbox", { name: "Message June" });
    fireEvent.change(composer, { target: { value: "New request" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("New request")).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("start_agent_run", {
        request: expect.objectContaining({ model: "fast", safetyMode: "unrestricted" }),
      }),
    );
    expect(screen.getByRole("button", { name: "Unrestricted" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Model" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Stop June" }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("cancel_agent_run", { runId: "run-1" }),
    );

    act(() => {
      mocks.runtimeListener?.({
        payload: {
          protocolVersion: 1,
          eventId: "event-cancelled",
          sessionId: session.id,
          runId: "run-1",
          sequence: 3,
          method: "run.cancelled",
          data: { completedAt: "2026-07-22T12:01:00Z" },
        },
      });
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Unrestricted" })).toBeEnabled());
    expect(screen.getByRole("combobox", { name: "Model" })).toBeEnabled();
  });

  it("resolves clarification interruptions through the typed host command", async () => {
    render(<AgentWorkspace initialSession={session} />);
    await screen.findByText("Earlier answer");

    act(() => {
      mocks.runtimeListener?.({
        payload: {
          protocolVersion: 1,
          eventId: "event-2",
          sessionId: session.id,
          runId: "run-2",
          sequence: 2,
          method: "interruption.requested",
          data: {
            itemId: "clarify-item",
            interruption: {
              id: "clarify-1",
              kind: "clarification",
              sessionId: session.id,
              runId: "run-2",
              status: "pending",
              createdAt: "2026-07-22T12:00:02Z",
              question: "Which project?",
              choices: ["June", "Platform"],
            },
          },
        },
      });
    });

    fireEvent.click(await screen.findByRole("button", { name: /June/ }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("resolve_agent_interruption", {
        request: {
          interruptionId: "clarify-1",
          resolution: { kind: "clarification", answer: "June" },
        },
      }),
    );
  });
});
