import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_SESSION_STATUS_EVENT } from "../lib/agent-events";

type TauriListener = (event: { payload: unknown }) => unknown;

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, TauriListener>(),
  hide: vi.fn().mockResolvedValue(undefined),
  emit: vi.fn().mockResolvedValue(undefined),
  invoke: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn((event: string, listener: TauriListener) => {
    mocks.listeners.set(event, listener);
    return Promise.resolve(vi.fn());
  }),
  startDragging: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: mocks.emit,
  listen: mocks.listen,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    hide: mocks.hide,
    startDragging: mocks.startDragging,
  }),
}));

describe("meeting detection HUD", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.hide.mockResolvedValue(undefined);
    mocks.emit.mockResolvedValue(undefined);
    mocks.invoke.mockResolvedValue(undefined);
    mocks.startDragging.mockResolvedValue(undefined);
    mocks.listeners.clear();
    document.body.innerHTML = hudMarkup();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the start transcription prompt when a meeting is detected", async () => {
    await loadHud();

    await emit("meeting-detection-event", {
      type: "meeting_detected",
      payload: { activeProcessCount: 1 },
    });

    expect(hudElement().dataset.state).toBe("meeting");
    expect(document.querySelector("#hud-meeting-label")).toHaveTextContent(
      "Meeting detected",
    );
    expect(document.querySelector("#hud-meeting-start")).toHaveTextContent(
      "Start transcription",
    );
    expect(hudShowCalls()).toBe(1);
    expect(mocks.invoke).toHaveBeenCalledWith("dictation_hud_set_stop_bounds", {
      rect: null,
    });
    // The window is resized to the measured pill (jsdom rects are zero).
    expect(mocks.invoke).toHaveBeenCalledWith("dictation_hud_set_size", {
      width: 0,
      height: 0,
      animate: true,
    });
  });

  it("emits a start transcription request when the button is clicked", async () => {
    vi.useFakeTimers();
    await loadHud();
    await emit("meeting-detection-event", { type: "meeting_detected" });

    document.querySelector<HTMLButtonElement>("#hud-meeting-start")?.click();

    await Promise.resolve();
    expect(mocks.emit).toHaveBeenCalledWith(
      "scribe://meeting-start-transcription",
    );
    // A bounded advance, not runAllTimersAsync: jsdom drives rAF off the
    // faked setTimeout while the alpha ramp measures real time, so running
    // "all" timers re-queues the ramp until sinon's 10000-timer abort.
    await vi.advanceTimersByTimeAsync(220);
    expect(mocks.hide).toHaveBeenCalledOnce();
    expect(
      document.querySelector<HTMLButtonElement>("#hud-meeting-start")?.disabled,
    ).toBe(false);
    vi.useRealTimers();
  });

  it("dismisses the prompt and stays quiet until the meeting clears", async () => {
    vi.useFakeTimers();
    await loadHud();
    await emit("meeting-detection-event", { type: "meeting_detected" });

    document.querySelector<HTMLButtonElement>("#hud-meeting-dismiss")?.click();
    await Promise.resolve();

    expect(hudElement().dataset.state).toBe("exiting");
    await vi.advanceTimersByTimeAsync(220);
    expect(mocks.hide).toHaveBeenCalledOnce();

    // Detection heartbeats keep arriving while the same meeting is live; the
    // dismissed prompt must not come back for any of them.
    mocks.invoke.mockClear();
    await emit("meeting-detection-event", { type: "meeting_detected" });
    expect(hudShowCalls()).toBe(0);

    // The next meeting prompts again.
    await emit("meeting-detection-event", { type: "meeting_cleared" });
    await emit("meeting-detection-event", { type: "meeting_detected" });
    expect(hudElement().dataset.state).toBe("meeting");
    expect(hudShowCalls()).toBe(1);
  });

  it("ignores a dismiss click outside the meeting prompt state", async () => {
    await loadHud();
    hudElement().dataset.state = "listening";
    mocks.hide.mockClear();

    document.querySelector<HTMLButtonElement>("#hud-meeting-dismiss")?.click();
    await Promise.resolve();

    expect(hudElement().dataset.state).toBe("listening");
    expect(mocks.hide).not.toHaveBeenCalled();
  });

  it("clears the prompt when microphone usage stops", async () => {
    vi.useFakeTimers();
    await loadHud();
    await emit("meeting-detection-event", { type: "meeting_detected" });

    await emit("meeting-detection-event", { type: "meeting_cleared" });

    expect(hudElement().dataset.state).toBe("exiting");
    // Drain the in-flight exit: on real timers its hide() fires ~220ms after
    // this test ends and lands mid-way through a later test's call counts.
    await vi.advanceTimersByTimeAsync(220);
    expect(mocks.hide).toHaveBeenCalledOnce();
  });

  it("hides and suppresses the prompt after 30 seconds without a click", async () => {
    vi.useFakeTimers();
    await loadHud();
    await emit("meeting-detection-event", { type: "meeting_detected" });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(hudElement().dataset.state).toBe("meeting");
    expect(mocks.hide).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(hudElement().dataset.state).toBe("exiting");
    // Exit completes via the timeout fallback (EXIT_TRANSITION_MS + 60) —
    // jsdom's rAF isn't driven by fake timers, so the alpha ramp never runs.
    await vi.advanceTimersByTimeAsync(220);
    expect(mocks.hide).toHaveBeenCalledOnce();

    mocks.invoke.mockClear();
    await emit("meeting-detection-event", { type: "meeting_detected" });

    expect(hudShowCalls()).toBe(0);
  });

  it("puts a re-shown window back down when a heartbeat arrives while suppressed", async () => {
    vi.useFakeTimers();
    await loadHud();
    await emit("meeting-detection-event", { type: "meeting_detected" });
    await vi.advanceTimersByTimeAsync(30_220);
    expect(mocks.hide).toHaveBeenCalledOnce();

    // While the prompt is suppressed, Rust may have re-shown the native
    // window before this event arrives. The pill renders nothing, so the HUD
    // must answer by hiding the window — a bare frosted window is otherwise
    // stuck on screen as an undraggable gray bar.
    mocks.invoke.mockClear();
    mocks.hide.mockClear();
    await emit("meeting-detection-event", { type: "meeting_detected" });

    expect(hudShowCalls()).toBe(0);
    expect(mocks.hide).toHaveBeenCalledOnce();
    expect(hudElement().dataset.state).not.toBe("meeting");
  });

  it("returns the pill to idle once the exit transition completes", async () => {
    vi.useFakeTimers();
    await loadHud();
    await emit("meeting-detection-event", { type: "meeting_detected" });
    await emit("meeting-detection-event", { type: "meeting_cleared" });

    expect(hudElement().dataset.state).toBe("exiting");
    await vi.advanceTimersByTimeAsync(220);
    expect(hudElement().dataset.state).toBe("idle");
  });

  it("hides a contentless window when the meeting clears", async () => {
    await loadHud();

    await emit("meeting-detection-event", { type: "meeting_cleared" });

    expect(mocks.hide).toHaveBeenCalledOnce();
  });

  it("allows the prompt again after a timed-out meeting clears", async () => {
    vi.useFakeTimers();
    await loadHud();
    await emit("meeting-detection-event", { type: "meeting_detected" });
    await vi.advanceTimersByTimeAsync(30_160);
    await emit("meeting-detection-event", { type: "meeting_cleared" });

    mocks.invoke.mockClear();
    await emit("meeting-detection-event", { type: "meeting_detected" });

    expect(hudElement().dataset.state).toBe("meeting");
    expect(hudShowCalls()).toBe(1);
  });

  it("does not override an active dictation HUD state", async () => {
    await loadHud();
    hudElement().dataset.state = "transcribing";
    mocks.invoke.mockClear();

    await emit("meeting-detection-event", { type: "meeting_detected" });

    expect(hudElement().dataset.state).toBe("transcribing");
    expect(hudShowCalls()).toBe(0);
  });

  it("surfaces silent dictation failures as nothing recorded", async () => {
    vi.useFakeTimers();
    await loadHud();

    await emit("dictation-event", {
      type: "error",
      payload: {
        code: "missing_recording",
        message: "No recorded audio was available to transcribe.",
        silent: true,
      },
    });

    expect(hudElement().dataset.state).toBe("silent-error");
    expect(document.querySelector("#hud-error-text")).toHaveTextContent(
      "Nothing recorded",
    );
    expect(hudShowCalls()).toBe(1);

    await vi.advanceTimersByTimeAsync(900);
    expect(hudElement().dataset.state).toBe("exiting");
    // Drain the in-flight exit. Its fallback timeout dies with the fake
    // clock, but the rAF alpha ramp keeps running on real time after this
    // test ends and would land its hide() inside the next test's counts.
    await vi.advanceTimersByTimeAsync(220);
    expect(mocks.hide).toHaveBeenCalledOnce();
  });

  it("hides when a Hey June prompt starts an agent session", async () => {
    vi.useFakeTimers();
    await loadHud();
    await emit("dictation-event", { type: "finalizing_transcript" });

    await emit("dictation-event", {
      type: "agent_session_prompt",
      payload: { prompt: "summarize the open document." },
    });

    expect(hudElement().dataset.state).toBe("exiting");
    await vi.advanceTimersByTimeAsync(220);
    expect(mocks.hide).toHaveBeenCalledOnce();
  });

  it("briefly acknowledges a Hey June agent handoff", async () => {
    vi.useFakeTimers();
    await loadHud();

    await emit(AGENT_SESSION_STATUS_EVENT, {
      status: "received",
      summary: "June is starting.",
    });

    expect(hudElement().dataset.state).toBe("agent-received");
    expect(document.querySelector("#hud-agent-label")).toHaveTextContent(
      "June is starting.",
    );
    expect(hudShowCalls()).toBe(1);

    await vi.advanceTimersByTimeAsync(4000);
    expect(hudElement().dataset.state).toBe("exiting");
    // Drain the in-flight exit so its hide() can't leak into a later test.
    await vi.advanceTimersByTimeAsync(220);
    expect(mocks.hide).toHaveBeenCalledOnce();
  });

  it("keeps the agent handoff visible when it races the dictation handoff hide", async () => {
    vi.useFakeTimers();
    await loadHud();
    await emit("dictation-event", { type: "finalizing_transcript" });

    await emit("dictation-event", {
      type: "agent_session_prompt",
      payload: { prompt: "open the browser." },
    });
    await emit(AGENT_SESSION_STATUS_EVENT, {
      status: "received",
      summary: "June is starting.",
    });
    await vi.advanceTimersByTimeAsync(160);

    expect(mocks.hide).not.toHaveBeenCalled();
    expect(hudElement().dataset.state).toBe("agent-received");

    await vi.advanceTimersByTimeAsync(4000);
    expect(hudElement().dataset.state).toBe("exiting");
    // Drain the in-flight exit so its hide() can't leak into a later test.
    await vi.advanceTimersByTimeAsync(220);
    expect(mocks.hide).toHaveBeenCalledOnce();
  });

  it("does not claim the HUD for ongoing agent progress", async () => {
    await loadHud();

    await emit(AGENT_SESSION_STATUS_EVENT, {
      status: "running",
      summary: "Using Filesystem.",
    });

    expect(hudElement().dataset.state).toBe("idle");
    expect(hudShowCalls()).toBe(0);
  });
});

async function loadHud() {
  await import("../hud");
  await Promise.resolve();
}

async function emit(event: string, payload: unknown) {
  const listener = mocks.listeners.get(event);
  expect(listener).toBeDefined();
  await listener?.({
    payload: JSON.stringify(payload),
  });
}

// The pill shows itself via the dictation_hud_show command (Rust positions
// the hidden window, then makes it visible) rather than appWindow.show().
function hudShowCalls() {
  return mocks.invoke.mock.calls.filter(
    ([command]) => command === "dictation_hud_show",
  ).length;
}

function hudElement() {
  const hud = document.querySelector<HTMLDivElement>("#hud");
  expect(hud).toBeTruthy();
  return hud as HTMLDivElement;
}

function hudMarkup() {
  return `
    <div id="hud" class="hud" data-state="idle">
      <span id="hud-handle" class="hud-handle" aria-label="Drag dictation HUD"></span>
      <div class="hud-viz">
        <div class="hud-bars" aria-hidden="true">
          <span class="hud-bar"></span>
          <span class="hud-bar"></span>
          <span class="hud-bar"></span>
          <span class="hud-bar"></span>
          <span class="hud-bar"></span>
          <span class="hud-bar"></span>
          <span class="hud-bar"></span>
        </div>
        <span id="hud-braille" class="hud-braille" aria-hidden="true"></span>
        <span class="hud-error-mark" aria-hidden="true"></span>
      </div>
      <span id="hud-error-text" class="hud-error-text" aria-hidden="true"></span>
      <span id="hud-agent-label" class="hud-agent-label" aria-hidden="true"></span>
      <span id="hud-meeting-label" class="hud-meeting-label">Meeting detected</span>
      <button id="hud-meeting-start" class="hud-meeting-start" type="button">Start transcription</button>
      <button id="hud-meeting-dismiss" class="hud-meeting-dismiss" type="button" aria-label="Dismiss meeting prompt"></button>
      <button id="hud-stop" class="hud-stop" type="button" aria-label="Stop dictation">
        <span class="hud-stop-glyph" aria-hidden="true"></span>
      </button>
      <span id="hud-status" class="hud-status">Idle</span>
    </div>
  `;
}
