import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_SESSIONS_CHANGED_EVENT,
  AGENT_SESSION_STATUS_EVENT,
} from "../lib/agent-events";

type TauriListener = (event: { payload: unknown }) => unknown;

const mocks = vi.hoisted(() => ({
  emit: vi.fn().mockResolvedValue(undefined),
  invoke: vi.fn().mockResolvedValue(undefined),
  listeners: new Map<string, TauriListener>(),
  listen: vi.fn((event: string, listener: TauriListener) => {
    mocks.listeners.set(event, listener);
    return Promise.resolve(vi.fn());
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: mocks.emit,
  listen: mocks.listen,
}));

describe("desktop mascot", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.listeners.clear();
    vi.useRealTimers();
    localStorage.clear();
    document.body.innerHTML = mascotMarkup();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("collapses an active bubble when the arrow button is pressed", async () => {
    await loadMascot();

    emitStatus({
      status: "running",
      title: "Let's start a session.",
      summary: "Starting June.",
    });
    await flushPromises();

    expect(mascotElement().dataset.expanded).toBe("true");
    expect(stackElement()).toHaveTextContent("Let's start a session.");

    toggleElement().dispatchEvent(
      new Event("pointerdown", { bubbles: true, cancelable: true }),
    );
    await flushPromises();

    expect(mascotElement().dataset.expanded).toBe("false");
    expect(stackElement()).toBeEmptyDOMElement();
    expect(localStorage.getItem("scribe:mascot:expanded")).toBe("false");
    expect(toggleElement().hidden).toBe(false);
    expect(mocks.invoke).toHaveBeenCalledWith("mascot_set_layout", {
      request: { expanded: false, cardCount: 0, replying: false },
    });
  });

  it("hides the arrow button when there are no active bubbles", async () => {
    await loadMascot();

    expect(toggleElement().hidden).toBe(true);
    expect(mascotElement().dataset.hasEntries).toBe("false");
  });

  it("briefly shows Done before removing the bubble when the agent completes", async () => {
    vi.useFakeTimers();
    await loadMascot();

    emitStatus({
      status: "running",
      title: "Summarize this",
      summary: "Working",
    });
    await flushPromises();

    expect(mascotElement().dataset.expanded).toBe("true");
    expect(stackElement()).toHaveTextContent("Summarize this");

    emitStatus({
      status: "completed",
      title: "Summarize this",
      summary: "Done",
    });
    await flushPromises();

    expect(mascotElement().dataset.expanded).toBe("true");
    expect(stackElement()).toHaveTextContent("Summarize this");
    expect(stackElement()).toHaveTextContent("Done");

    await vi.advanceTimersByTimeAsync(12_050);

    expect(mascotElement().dataset.expanded).toBe("false");
    expect(stackElement()).toBeEmptyDOMElement();
    expect(toggleElement().hidden).toBe(true);
  });

  it("turns a pending running bubble into Done when the completed session title differs", async () => {
    vi.useFakeTimers();
    await loadMascot();

    emitStatus({
      status: "running",
      title: "Let's start a session.",
      summary: "Thinking.",
    });
    await flushPromises();

    expect(stackElement()).toHaveTextContent("Let's start a session.");

    emitStatus({
      activeCount: 0,
      sessionId: "session-1",
      status: "completed",
      title: "Generated session title",
      summary: "June finished.",
    });
    await flushPromises();

    expect(mascotElement().dataset.expanded).toBe("true");
    expect(stackElement()).toHaveTextContent("Let's start a session.");
    expect(stackElement()).toHaveTextContent("June finished.");

    await vi.advanceTimersByTimeAsync(12_050);

    expect(mascotElement().dataset.expanded).toBe("false");
    expect(stackElement()).toBeEmptyDOMElement();
    expect(toggleElement().hidden).toBe(true);
  });

  it("clears active session records when session state reports no active work", async () => {
    await loadMascot();

    emitStatus({
      sessionId: "session-1",
      status: "running",
      title: "Active session",
      summary: "Thinking.",
    });
    emitSessionsChanged({
      sessions: [
        {
          id: "session-1",
          title: "Active session",
          preview: "Earlier prompt",
          started_at: new Date().toISOString(),
          last_active: new Date().toISOString(),
          message_count: 2,
        },
      ],
      workingSessionIds: ["session-1"],
      waitingSessionIds: [],
    });
    await flushPromises();

    expect(stackElement()).toHaveTextContent("Active session");

    emitSessionsChanged({
      sessions: [
        {
          id: "session-1",
          title: "Active session",
          preview: "Earlier prompt",
          started_at: new Date().toISOString(),
          last_active: new Date().toISOString(),
          message_count: 2,
        },
      ],
      workingSessionIds: [],
      waitingSessionIds: [],
    });
    await flushPromises();

    expect(mascotElement().dataset.expanded).toBe("false");
    expect(stackElement()).toBeEmptyDOMElement();
  });

  it("opens a compact reply form and requests the taller reply layout", async () => {
    await loadMascot();

    emitStatus({
      status: "waitingForUser",
      title: "Need approval",
      summary: "Review this step.",
    });
    await flushPromises();

    replyButton().click();
    await flushPromises();

    expect(document.querySelector(".mascot-reply-input")).toBeTruthy();
    expect(mocks.invoke).toHaveBeenCalledWith("mascot_set_layout", {
      request: { expanded: true, cardCount: 1, replying: true },
    });
  });
});

async function loadMascot() {
  await import("../mascot");
  await flushPromises();
}

function emitStatus(detail: {
  activeCount?: number;
  sessionId?: string;
  status: string;
  title: string;
  summary: string;
}) {
  window.dispatchEvent(
    new CustomEvent(AGENT_SESSION_STATUS_EVENT, { detail }),
  );
}

function emitSessionsChanged(detail: {
  sessions: Array<{
    id: string;
    title?: string;
    preview?: string;
    started_at?: string;
    last_active?: string;
    message_count?: number;
  }>;
  workingSessionIds: string[];
  waitingSessionIds: string[];
}) {
  window.dispatchEvent(
    new CustomEvent(AGENT_SESSIONS_CHANGED_EVENT, { detail }),
  );
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

function mascotElement() {
  const mascot = document.querySelector<HTMLElement>("#mascot");
  expect(mascot).toBeTruthy();
  return mascot as HTMLElement;
}

function stackElement() {
  const stack = document.querySelector<HTMLElement>("#mascot-stack");
  expect(stack).toBeTruthy();
  return stack as HTMLElement;
}

function toggleElement() {
  const toggle = document.querySelector<HTMLButtonElement>("#mascot-toggle");
  expect(toggle).toBeTruthy();
  return toggle as HTMLButtonElement;
}

function replyButton() {
  const reply = document.querySelector<HTMLButtonElement>(".mascot-reply");
  expect(reply).toBeTruthy();
  return reply as HTMLButtonElement;
}

function mascotMarkup() {
  return `
    <main id="mascot" class="mascot" data-expanded="false">
      <section
        id="mascot-stack"
        class="mascot-stack"
        aria-label="Agent sessions"
      ></section>
      <button
        id="mascot-toggle"
        class="mascot-toggle"
        type="button"
        aria-label="Expand June mascot"
        aria-expanded="false"
      >
        <span class="mascot-chevron" aria-hidden="true"></span>
      </button>
      <button
        id="mascot-avatar"
        class="mascot-avatar"
        type="button"
        aria-label="Open Agent"
      >
        <img id="mascot-image" alt="" />
      </button>
    </main>
  `;
}
