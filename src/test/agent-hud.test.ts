import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_REPLY_EVENT,
  AGENT_SESSIONS_CHANGED_EVENT,
  AGENT_SESSION_STATUS_EVENT,
} from "../lib/agent-events";
import { AGENT_HUD_VISIBILITY_CHANGED_EVENT } from "../lib/agent-hud-settings";

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

describe("agent HUD", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.listeners.clear();
    vi.useRealTimers();
    localStorage.clear();
    document.body.innerHTML = agentHudMarkup();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays a collapsed pill with a running count when work starts", async () => {
    await loadAgentHud();

    emitStatus({
      status: "running",
      title: "Let's start a session.",
      summary: "Starting June.",
    });
    await flushPromises();

    expect(hudElement().dataset.expanded).toBe("false");
    expect(hudElement().dataset.hasEntries).toBe("true");
    expect(pillLabelElement()).toHaveTextContent("1 running");
    expect(markElement().dataset.status).toBe("running");
    // Rows stay in the DOM while collapsed (the expand reveal animates
    // them); they are hidden from assistive tech instead of removed.
    expect(stackElement().querySelector(".dot-spinner > span")).toBeTruthy();
    expect(stackElement()).toHaveAttribute("aria-hidden", "true");
    expect(mocks.invoke).toHaveBeenCalledWith("agent_hud_set_layout", {
      request: { expanded: false, cardCount: 0, replying: false },
    });
    expect(mocks.invoke).toHaveBeenCalledWith("agent_hud_show");
  });

  it("shortens the collapsed label when multiple agents are running", async () => {
    await loadAgentHud();

    emitSessionsChanged({
      sessions: [
        sessionFixture("session-1", "Sweep typographic dashes"),
        sessionFixture("session-2", "Refactor the trial gate copy"),
        sessionFixture("session-3", "Fix the flaky shortcut test"),
      ],
      workingSessionIds: ["session-1", "session-2", "session-3"],
      waitingSessionIds: [],
    });
    await flushPromises();

    expect(hudElement().dataset.expanded).toBe("false");
    expect(pillLabelElement()).toHaveTextContent("3");
    expect(pillLabelElement()).not.toHaveTextContent("running");
    expect(pillElement().dataset.countOnly).toBe("true");
  });

  it("hides the window when there is nothing to report", async () => {
    await loadAgentHud();

    expect(hudElement().dataset.hasEntries).toBe("false");
    expect(mocks.invoke).toHaveBeenCalledWith("agent_hud_hide");
    expect(mocks.invoke).not.toHaveBeenCalledWith("agent_hud_show");
  });

  it("does not resize the HUD on hover", async () => {
    await loadAgentHud();

    emitStatus({
      status: "running",
      title: "Review the branch.",
      summary: "Working.",
    });
    await flushPromises();

    mocks.invoke.mockClear();
    hudElement().dispatchEvent(new Event("pointerenter"));
    await flushPromises();

    expect(hudElement().dataset.expanded).toBe("false");
    expect(stackElement()).toHaveAttribute("aria-hidden", "true");
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "agent_hud_set_layout",
      expect.anything(),
    );

    hudElement().dispatchEvent(new Event("pointerleave"));
    await flushPromises();

    expect(hudElement().dataset.expanded).toBe("false");
  });

  it("pins the panel open from the pill and persists the choice", async () => {
    await loadAgentHud();

    emitStatus({
      status: "running",
      title: "Summarize this",
      summary: "Working",
    });
    await flushPromises();

    pillElement().dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
    );
    await flushPromises();

    expect(hudElement().dataset.expanded).toBe("true");
    expect(localStorage.getItem("scribe:agent-hud:expanded")).toBe("true");

    pillElement().dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
    );
    await flushPromises();

    expect(hudElement().dataset.expanded).toBe("false");
    expect(localStorage.getItem("scribe:agent-hud:expanded")).toBe("false");
  });

  it("does not re-show the native window when expanding an already visible HUD", async () => {
    await loadAgentHud();

    emitStatus({
      status: "running",
      title: "Summarize this",
      summary: "Working",
    });
    await flushPromises();

    expect(mocks.invoke).toHaveBeenCalledWith("agent_hud_show");
    mocks.invoke.mockClear();

    pillElement().dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
    );
    await flushPromises();

    expect(mocks.invoke).toHaveBeenCalledWith("agent_hud_set_layout", {
      request: { expanded: true, cardCount: 1, replying: false },
    });
    expect(mocks.invoke).not.toHaveBeenCalledWith("agent_hud_show");
  });

  it("expands on its own when a session needs input", async () => {
    await loadAgentHud();

    emitStatus({
      status: "waitingForUser",
      title: "Need approval",
      summary: "Review this step.",
    });
    await flushPromises();

    expect(hudElement().dataset.expanded).toBe("true");
    expect(pillLabelElement()).toHaveTextContent("1 needs input");
    expect(markElement().dataset.status).toBe("waitingForUser");
    expect(stackElement()).toHaveTextContent("Need approval");
    expect(document.querySelector(".agent-hud-status svg")).toBeTruthy();
    expect(document.querySelector(".agent-hud-chevron svg")).toBeTruthy();
    expect(document.querySelector(".agent-hud-reply svg")).toBeTruthy();
  });

  it("stays collapsed after an explicit collapse while a session still needs input", async () => {
    await loadAgentHud();

    emitSessionsChanged({
      sessions: [sessionFixture("session-1", "Need approval")],
      workingSessionIds: [],
      waitingSessionIds: ["session-1"],
    });
    await flushPromises();

    // The new attention event auto-expands the panel.
    expect(hudElement().dataset.expanded).toBe("true");

    // Clicking the pill to collapse must stick even though the session is
    // still waiting for the user.
    pillElement().dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
    );
    await flushPromises();

    expect(hudElement().dataset.expanded).toBe("false");
    // The collapsed pill still advertises the pending attention.
    expect(hudElement().dataset.hasAction).toBe("true");
    expect(pillLabelElement()).toHaveTextContent("1 needs input");

    // A repeat status burst for the same waiting session does not re-expand
    // the panel the user just collapsed.
    emitSessionsChanged({
      sessions: [sessionFixture("session-1", "Need approval")],
      workingSessionIds: [],
      waitingSessionIds: ["session-1"],
    });
    await flushPromises();

    expect(hudElement().dataset.expanded).toBe("false");
  });

  it("auto-expands again when a different session newly needs input", async () => {
    await loadAgentHud();

    emitSessionsChanged({
      sessions: [sessionFixture("session-1", "Need approval")],
      workingSessionIds: [],
      waitingSessionIds: ["session-1"],
    });
    await flushPromises();

    pillElement().dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
    );
    await flushPromises();
    expect(hudElement().dataset.expanded).toBe("false");

    // A second, different session needing input is a fresh attention event.
    emitSessionsChanged({
      sessions: [
        sessionFixture("session-1", "Need approval"),
        sessionFixture("session-2", "Confirm the deletion"),
      ],
      workingSessionIds: [],
      waitingSessionIds: ["session-1", "session-2"],
    });
    await flushPromises();

    expect(hudElement().dataset.expanded).toBe("true");
  });

  it("opens the context menu from a right-click on the expanded surface", async () => {
    await loadAgentHud();

    emitSessionsChanged({
      sessions: [sessionFixture("session-1", "Need approval")],
      workingSessionIds: [],
      waitingSessionIds: ["session-1"],
    });
    await flushPromises();

    expect(hudElement().dataset.expanded).toBe("true");

    // Right-clicking a row inside the expanded surface (not the pill) must
    // still open the HUD's own menu rather than the native one.
    const rowEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    document
      .querySelector<HTMLElement>(".agent-hud-row-body")
      ?.dispatchEvent(rowEvent);
    await flushPromises();

    expect(rowEvent.defaultPrevented).toBe(true);
    expect(menuElement().hidden).toBe(false);

    hideHudButton().click();
    await flushPromises();

    expect(localStorage.getItem("scribe:agent-hud:enabled")).toBe("false");
    expect(hudElement().dataset.visible).toBe("false");
    expect(mocks.invoke).toHaveBeenCalledWith("agent_hud_hide");
  });

  it("opens the context menu when the native panel reports a context click", async () => {
    await loadAgentHud();

    emitSessionsChanged({
      sessions: [sessionFixture("session-1", "Need approval")],
      workingSessionIds: [],
      waitingSessionIds: ["session-1"],
    });
    await flushPromises();

    expect(menuElement().hidden).toBe(true);

    // The native panel swallows the right-/ctrl-click and emits this event;
    // the webview never sees a contextmenu event in the real app.
    const openMenuFromNative = mocks.listeners.get(
      "scribe:agent-hud:context-menu",
    );
    expect(openMenuFromNative).toBeDefined();
    openMenuFromNative?.({ payload: undefined });
    await flushPromises();

    expect(menuElement().hidden).toBe(false);
    expect(menuElement()).toHaveAttribute("aria-hidden", "false");

    hideHudButton().click();
    await flushPromises();

    expect(localStorage.getItem("scribe:agent-hud:enabled")).toBe("false");
    expect(hudElement().dataset.visible).toBe("false");
    expect(mocks.invoke).toHaveBeenCalledWith("agent_hud_hide");
  });

  it("shows an active-count badge when sessions work behind a needs-input one", async () => {
    await loadAgentHud();

    emitStatus({
      status: "running",
      title: "Sweep typographic dashes",
      summary: "Checking files.",
    });
    await flushPromises();

    const badge = document.querySelector<HTMLElement>("#agent-hud-pill-badge");
    expect(badge?.hidden).toBe(true);

    emitStatus({
      status: "running",
      title: "Refactor the trial gate copy",
      summary: "Rewriting the paywall states.",
    });
    await flushPromises();

    emitStatus({
      status: "waitingForUser",
      title: "Need approval",
      summary: "Review this step.",
    });
    await flushPromises();

    expect(pillLabelElement()).toHaveTextContent("1 needs input");
    expect(badge?.hidden).toBe(false);
    expect(badge).toHaveTextContent("3");
    expect(badge).toHaveAttribute("aria-label", "3 active agents");
  });

  it("does not repeat generic status text in expanded rows", async () => {
    await loadAgentHud();

    emitStatus({
      status: "running",
      title: "Review the branch",
      summary: "June is working.",
    });
    await flushPromises();

    pillElement().dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
    );
    await flushPromises();

    expect(pillLabelElement()).toHaveTextContent("1 running");
    expect(stackElement()).toHaveTextContent("Review the branch");
    expect(stackElement()).not.toHaveTextContent("June is working.");
  });

  it("opens a reply form and requests the taller reply layout", async () => {
    await loadAgentHud();

    emitStatus({
      status: "waitingForUser",
      title: "Need approval",
      summary: "Review this step.",
    });
    await flushPromises();

    replyButton().click();
    await flushPromises();

    expect(document.querySelector(".agent-hud-reply-input")).toBeTruthy();
    expect(mocks.invoke).toHaveBeenCalledWith("agent_hud_set_layout", {
      request: { expanded: true, cardCount: 1, replying: true },
    });
  });

  it("asks the native panel for key focus when a reply opens", async () => {
    await loadAgentHud();

    emitStatus({
      status: "waitingForUser",
      title: "Need approval",
      summary: "Review this step.",
    });
    await flushPromises();

    replyButton().click();
    await flushPromises();

    expect(mocks.invoke).toHaveBeenCalledWith("agent_hud_focus_reply");
  });

  it("keeps the reply draft when a status burst re-renders the rows", async () => {
    await loadAgentHud();

    emitStatus({
      status: "waitingForUser",
      title: "Need approval",
      summary: "Review this step.",
    });
    await flushPromises();

    replyButton().click();
    await flushPromises();

    const input = document.querySelector<HTMLInputElement>(
      ".agent-hud-reply-input",
    );
    expect(input).toBeTruthy();
    input!.value = "Working on it";

    emitStatus({
      status: "waitingForUser",
      title: "Need approval",
      summary: "Still waiting on you.",
    });
    await flushPromises();

    const inputs = document.querySelectorAll<HTMLInputElement>(
      ".agent-hud-reply-input",
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toBe(input);
    expect(inputs[0].value).toBe("Working on it");
  });

  it("keeps the panel open under the pointer after the work resolves", async () => {
    await loadAgentHud();

    emitStatus({
      status: "waitingForUser",
      title: "Need approval",
      summary: "Review this step.",
    });
    await flushPromises();

    expect(hudElement().dataset.expanded).toBe("true");

    hudElement().dispatchEvent(new Event("pointerenter"));
    emitStatus({
      status: "completed",
      title: "Need approval",
      summary: "Done",
    });
    await flushPromises();

    expect(hudElement().dataset.expanded).toBe("true");
    expect(stackElement()).toHaveTextContent("Need approval");

    hudElement().dispatchEvent(new Event("pointerleave"));
    await flushPromises();

    expect(hudElement().dataset.expanded).toBe("false");
    expect(hudElement().dataset.hasEntries).toBe("true");
  });

  it("does not expire terminal rows while hovered", async () => {
    vi.useFakeTimers();
    await loadAgentHud();

    emitStatus({
      status: "completed",
      title: "Summarize this",
      summary: "Done",
    });
    await flushPromises();

    hudElement().dispatchEvent(new Event("pointerenter"));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(hudElement().dataset.hasEntries).toBe("true");
    expect(pillLabelElement()).toHaveTextContent("Done");

    hudElement().dispatchEvent(new Event("pointerleave"));
    await vi.advanceTimersByTimeAsync(2_450);

    expect(hudElement().dataset.hasEntries).toBe("false");
  });

  it("sends the HUD reply to the row session", async () => {
    await loadAgentHud();

    const session = {
      id: "session-1",
      title: "Need approval",
      preview: "Review this step.",
      started_at: new Date().toISOString(),
      last_active: new Date().toISOString(),
      message_count: 2,
    };

    emitSessionsChanged({
      sessions: [session],
      workingSessionIds: [],
      waitingSessionIds: ["session-1"],
    });
    await flushPromises();

    replyButton().click();
    await flushPromises();

    const input = document.querySelector<HTMLInputElement>(
      ".agent-hud-reply-input",
    );
    expect(input).toBeTruthy();
    input!.value = "Approved.";
    document
      .querySelector<HTMLFormElement>(".agent-hud-reply-form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flushPromises();

    expect(mocks.invoke).toHaveBeenCalledWith("agent_hud_open_agent", {
      session,
    });
    expect(mocks.emit).toHaveBeenCalledWith(
      AGENT_REPLY_EVENT,
      expect.objectContaining({
        session,
        text: "Approved.",
      }),
    );
  });

  it("briefly shows Done before hiding when the agent completes", async () => {
    vi.useFakeTimers();
    await loadAgentHud();

    emitStatus({
      status: "running",
      title: "Summarize this",
      summary: "Working",
    });
    await flushPromises();

    expect(pillLabelElement()).toHaveTextContent("1 running");

    emitStatus({
      status: "completed",
      title: "Summarize this",
      summary: "Done",
    });
    await flushPromises();

    expect(hudElement().dataset.hasEntries).toBe("true");
    expect(pillLabelElement()).toHaveTextContent("Done");
    expect(markElement().dataset.status).toBe("completed");

    mocks.invoke.mockClear();
    await vi.advanceTimersByTimeAsync(2250);

    expect(hudElement().dataset.hasEntries).toBe("false");
    expect(hudElement().dataset.visible).toBe("false");
    expect(mocks.invoke).not.toHaveBeenCalledWith("agent_hud_hide");

    // The pill keeps showing "Done" under the fade instead of blanking.
    expect(pillLabelElement()).toHaveTextContent("Done");

    await vi.advanceTimersByTimeAsync(300);

    expect(mocks.invoke).toHaveBeenCalledWith("agent_hud_hide");
  });

  it("turns a pending running entry into Done when the completed session title differs", async () => {
    vi.useFakeTimers();
    await loadAgentHud();

    emitStatus({
      status: "running",
      title: "Let's start a session.",
      summary: "Thinking.",
    });
    await flushPromises();

    expect(pillLabelElement()).toHaveTextContent("1 running");

    emitStatus({
      activeCount: 0,
      sessionId: "session-1",
      status: "completed",
      title: "Generated session title",
      summary: "June finished.",
    });
    await flushPromises();

    expect(pillLabelElement()).toHaveTextContent("Done");

    await vi.advanceTimersByTimeAsync(2450);

    expect(hudElement().dataset.hasEntries).toBe("false");
  });

  it("clears active session records when session state reports no active work", async () => {
    await loadAgentHud();

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

    expect(hudElement().dataset.hasEntries).toBe("true");
    expect(pillLabelElement()).toHaveTextContent("1 running");

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

    expect(hudElement().dataset.hasEntries).toBe("false");
    expect(mocks.invoke).toHaveBeenCalledWith("agent_hud_hide");
  });

  it("opens the agent when a session row is clicked", async () => {
    await loadAgentHud();

    emitStatus({
      status: "waitingForUser",
      title: "Need approval",
      summary: "Review this step.",
    });
    await flushPromises();

    document.querySelector<HTMLButtonElement>(".agent-hud-row-body")?.click();
    await flushPromises();

    expect(mocks.invoke).toHaveBeenCalledWith("agent_hud_open_agent", {
      session: undefined,
    });
  });

  it("hides the HUD from the pill context menu action", async () => {
    await loadAgentHud();

    emitStatus({
      status: "running",
      title: "Summarize this",
      summary: "Working",
    });
    await flushPromises();

    pillElement().dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
    await flushPromises();

    expect(menuElement().hidden).toBe(false);
    expect(menuElement()).toHaveAttribute("aria-hidden", "false");
    expect(hideHudButton()).toHaveTextContent("Hide agent HUD");

    hideHudButton().click();
    await flushPromises();

    expect(localStorage.getItem("scribe:agent-hud:enabled")).toBe("false");
    expect(hudElement().dataset.visible).toBe("false");
    expect(mocks.emit).toHaveBeenCalledWith(
      AGENT_HUD_VISIBILITY_CHANGED_EVENT,
      {
        enabled: false,
      },
    );
    expect(mocks.invoke).toHaveBeenCalledWith("agent_hud_hide");
  });

  it("honors a disabled flag saved under the legacy mascot key", async () => {
    localStorage.setItem("scribe:mascot:enabled", "false");
    await loadAgentHud();

    emitStatus({
      status: "running",
      title: "Summarize this",
      summary: "Working",
    });
    await flushPromises();

    expect(mocks.invoke).toHaveBeenCalledWith("agent_hud_hide");
    expect(mocks.invoke).not.toHaveBeenCalledWith("agent_hud_show");
  });
});

async function loadAgentHud() {
  await import("../agent-hud");
  await flushPromises();
}

function emitStatus(detail: {
  activeCount?: number;
  sessionId?: string;
  status: string;
  title: string;
  summary: string;
}) {
  window.dispatchEvent(new CustomEvent(AGENT_SESSION_STATUS_EVENT, { detail }));
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

function sessionFixture(id: string, title: string) {
  const now = new Date().toISOString();
  return {
    id,
    title,
    preview: title,
    started_at: now,
    last_active: now,
    message_count: 2,
  };
}

async function flushPromises() {
  // The layout sync awaits set_layout before show, so a couple of extra
  // microtask turns are needed for the whole chain to settle.
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
}

function hudElement() {
  const hud = document.querySelector<HTMLElement>("#agent-hud");
  expect(hud).toBeTruthy();
  return hud as HTMLElement;
}

function pillElement() {
  const pill = document.querySelector<HTMLButtonElement>("#agent-hud-pill");
  expect(pill).toBeTruthy();
  return pill as HTMLButtonElement;
}

function pillLabelElement() {
  const label = document.querySelector<HTMLElement>("#agent-hud-pill-label");
  expect(label).toBeTruthy();
  return label as HTMLElement;
}

function markElement() {
  const mark = document.querySelector<HTMLElement>("#agent-hud-mark");
  expect(mark).toBeTruthy();
  return mark as HTMLElement;
}

function stackElement() {
  const stack = document.querySelector<HTMLElement>("#agent-hud-stack");
  expect(stack).toBeTruthy();
  return stack as HTMLElement;
}

function replyButton() {
  const reply = document.querySelector<HTMLButtonElement>(".agent-hud-reply");
  expect(reply).toBeTruthy();
  return reply as HTMLButtonElement;
}

function menuElement() {
  const menu = document.querySelector<HTMLElement>("#agent-hud-menu");
  expect(menu).toBeTruthy();
  return menu as HTMLElement;
}

function hideHudButton() {
  const hide = document.querySelector<HTMLButtonElement>("#agent-hud-hide");
  expect(hide).toBeTruthy();
  return hide as HTMLButtonElement;
}

function agentHudMarkup() {
  return `
    <main id="agent-hud" class="agent-hud" data-expanded="false">
      <section class="agent-hud-surface" aria-label="Agent activity">
        <button
          id="agent-hud-pill"
          class="agent-hud-pill"
          type="button"
          aria-expanded="false"
          aria-label="Expand agent activity"
        >
          <span
            id="agent-hud-mark"
            class="agent-hud-mark"
            aria-hidden="true"
          ></span>
          <span id="agent-hud-pill-label" class="agent-hud-pill-label"></span>
          <span class="agent-hud-pill-end">
            <span
              id="agent-hud-pill-badge"
              class="agent-hud-pill-badge"
              hidden
            ></span>
            <span
              id="agent-hud-chevron"
              class="agent-hud-chevron"
              aria-hidden="true"
            ></span>
          </span>
        </button>
        <div class="agent-hud-reveal">
          <ul
            id="agent-hud-stack"
            class="agent-hud-stack"
            role="list"
            aria-label="Agent sessions"
          ></ul>
        </div>
      </section>
      <div
        id="agent-hud-menu"
        class="agent-hud-menu"
        role="menu"
        aria-hidden="true"
        hidden
      >
        <button id="agent-hud-hide" type="button" role="menuitem">
          Hide agent HUD
        </button>
      </div>
    </main>
  `;
}
