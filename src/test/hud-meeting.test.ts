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
  show: vi.fn().mockResolvedValue(undefined),
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
    show: mocks.show,
    startDragging: mocks.startDragging,
  }),
}));

describe("meeting detection HUD", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
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
    expect(mocks.show).toHaveBeenCalledOnce();
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
    await vi.runAllTimersAsync();
    expect(mocks.hide).toHaveBeenCalledOnce();
    expect(
      document.querySelector<HTMLButtonElement>("#hud-meeting-start")?.disabled,
    ).toBe(false);
    vi.useRealTimers();
  });

  it("clears the prompt when microphone usage stops", async () => {
    await loadHud();
    await emit("meeting-detection-event", { type: "meeting_detected" });

    await emit("meeting-detection-event", { type: "meeting_cleared" });

    expect(hudElement().dataset.state).toBe("exiting");
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

    mocks.show.mockClear();
    await emit("meeting-detection-event", { type: "meeting_detected" });

    expect(mocks.show).not.toHaveBeenCalled();
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
    mocks.show.mockClear();
    mocks.hide.mockClear();
    await emit("meeting-detection-event", { type: "meeting_detected" });

    expect(mocks.show).not.toHaveBeenCalled();
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

    mocks.show.mockClear();
    await emit("meeting-detection-event", { type: "meeting_detected" });

    expect(hudElement().dataset.state).toBe("meeting");
    expect(mocks.show).toHaveBeenCalledOnce();
  });

  it("does not override an active dictation HUD state", async () => {
    await loadHud();
    hudElement().dataset.state = "transcribing";
    mocks.show.mockClear();

    await emit("meeting-detection-event", { type: "meeting_detected" });

    expect(hudElement().dataset.state).toBe("transcribing");
    expect(mocks.show).not.toHaveBeenCalled();
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
    expect(mocks.show).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(900);
    expect(hudElement().dataset.state).toBe("exiting");
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
    expect(mocks.show).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4000);
    expect(hudElement().dataset.state).toBe("exiting");
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
  });

  it("does not claim the HUD for ongoing agent progress", async () => {
    await loadHud();

    await emit(AGENT_SESSION_STATUS_EVENT, {
      status: "running",
      summary: "Using Filesystem.",
    });

    expect(hudElement().dataset.state).toBe("idle");
    expect(mocks.show).not.toHaveBeenCalled();
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
      <button id="hud-stop" class="hud-stop" type="button" aria-label="Stop dictation">
        <span class="hud-stop-glyph" aria-hidden="true"></span>
      </button>
      <span id="hud-status" class="hud-status">Idle</span>
    </div>
  `;
}
