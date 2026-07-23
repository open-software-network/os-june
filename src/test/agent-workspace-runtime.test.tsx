import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { markAgentNewSessionPending } from "../components/agent/session-persistence";
import { agentComposerClearance } from "../components/agent/composer/layout";
import { AGENT_NEW_SESSION_EVENT } from "../lib/agent-events";

const session: AgentSessionDto = {
  id: "session-1",
  title: "Existing session",
  status: "idle",
  model: "fast",
  safetyMode: "sandboxed",
  workspacePath: "/tmp/session-1",
  source: "user",
  createdAt: "2026-07-22T12:00:00Z",
  updatedAt: "2026-07-22T12:00:00Z",
};

const newSession: AgentSessionDto = {
  ...session,
  id: "session-2",
  title: "Fresh request",
  workspacePath: "/tmp/session-2",
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
          modelType: "text",
          models: [
            {
              provider: "june",
              id: "fast",
              name: "Fast",
              modelType: "text",
              traits: [],
              capabilities: ["tools"],
            },
          ],
        });
      }
      if (command === "create_agent_session") return Promise.resolve(newSession);
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

  it("reserves the overlap between the transcript and fixed composer", () => {
    expect(agentComposerClearance(800, 620)).toBe(180);
    expect(agentComposerClearance(600, 620)).toBe(0);
  });

  it("hydrates history, shows an optimistic turn, and cancels", async () => {
    const user = userEvent.setup();
    const { container } = render(<AgentWorkspace initialSession={session} />);

    expect(await screen.findByText("Earlier answer")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sandboxed" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Model: Fast" })).toBeEnabled();
    expect(container.querySelector(".agent-scroll .agent-main > .agent-composer")).not.toBeNull();
    const composer = screen.getByRole("textbox", { name: "Message June" });
    await user.click(composer);
    await user.type(composer, "New request");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("New request")).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("start_agent_run", {
        request: expect.objectContaining({ model: "fast", safetyMode: "sandboxed" }),
      }),
    );
    expect(screen.queryByRole("button", { name: "Model: Fast" })).not.toBeInTheDocument();
    expect(screen.getByText("Fast")).toBeInTheDocument();

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

    await waitFor(() => expect(screen.getByRole("button", { name: "Model: Fast" })).toBeEnabled());
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

  it("resets an open conversation when a new session is requested", async () => {
    const user = userEvent.setup();
    const onSessionSelected = vi.fn();
    const { container } = render(
      <AgentWorkspace initialSession={session} onSessionSelected={onSessionSelected} />,
    );
    await screen.findByText("Earlier answer");

    act(() => {
      markAgentNewSessionPending();
      window.dispatchEvent(new CustomEvent(AGENT_NEW_SESSION_EVENT));
    });

    expect(await screen.findByRole("heading", { level: 2 })).toBeVisible();
    expect(screen.queryByText("Earlier answer")).not.toBeInTheDocument();
    expect(onSessionSelected).toHaveBeenLastCalledWith(undefined);
    expect(
      container.querySelector(".agent-workspace > .agent-main[data-hero='true']"),
    ).not.toBeNull();
    expect(container.querySelector(".agent-scroll")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Add files or notes" }));
    expect(screen.getByRole("menuitem", { name: "Attach files" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Reference a note" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Add files or notes" }));

    await user.click(screen.getByRole("button", { name: "Sandboxed" }));
    await user.click(screen.getByRole("menuitemradio", { name: /Unrestricted/ }));
    expect(screen.getByRole("dialog", { name: "Turn on Unrestricted?" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    const composer = screen.getByRole("textbox", { name: "Message June" });
    await user.click(composer);
    await user.type(composer, "Fresh request");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("create_agent_session", {
        request: expect.objectContaining({ title: "Fresh request" }),
      }),
    );
    expect(onSessionSelected).toHaveBeenLastCalledWith(newSession);
  });
});
