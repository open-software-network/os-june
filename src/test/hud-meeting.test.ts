import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_SESSION_STATUS_EVENT } from "../lib/agent-events";
import {
  markOnboardingComplete,
  resetOnboardingForReplay,
} from "../lib/onboarding";

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

  it("shows the take notes prompt when a meeting is detected", async () => {
    await loadHud();

    await emit("meeting-detection-event", {
      type: "meeting_detected",
      payload: { activeProcessCount: 1, appLabels: ["Zoom"] },
    });

    expect(hudElement().dataset.state).toBe("meeting");
    expect(document.querySelector("#hud-meeting-label")).toHaveTextContent(
      "Meeting detected",
    );
    expect(document.querySelector("#hud-meeting-app")).toHaveTextContent(
      "Zoom",
    );
    expect(document.querySelector("#hud-meeting-start")).toHaveTextContent(
      "Record",
    );
    expect(hudShowCalls()).toBe(1);
    expect(mocks.invoke).toHaveBeenCalledWith("dictation_hud_set_stop_bounds", {
      rect: null,
    });
    // The window is resized to the measured pill (jsdom rects are zero)
    // plus the meeting card's transparent gutter on each side.
    expect(mocks.invoke).toHaveBeenCalledWith("dictation_hud_set_size", {
      width: 32,
      height: 32,
      animate: true,
    });
  });

  it("delays the meeting prompt while onboarding is active", async () => {
    resetOnboardingForReplay();
    await loadHud();

    await emit("meeting-detection-event", {
      type: "meeting_detected",
      payload: { activeProcessCount: 1, appLabels: ["Zoom"] },
    });

    expect(hudElement().dataset.state).toBe("idle");
    expect(hudShowCalls()).toBe(0);
    expect(mocks.hide).toHaveBeenCalledOnce();

    markOnboardingComplete();
    await Promise.resolve();
    await Promise.resolve();

    expect(hudElement().dataset.state).toBe("meeting");
    expect(document.querySelector("#hud-meeting-app")).toHaveTextContent(
      "Zoom",
    );
    await vi.waitFor(() => expect(hudShowCalls()).toBe(1));
  });

  it("drops a delayed meeting prompt if the meeting clears during onboarding", async () => {
    resetOnboardingForReplay();
    await loadHud();

    await emit("meeting-detection-event", {
      type: "meeting_detected",
      payload: { activeProcessCount: 1, appLabels: ["Zoom"] },
    });
    await emit("meeting-detection-event", { type: "meeting_cleared" });

    markOnboardingComplete();
    await Promise.resolve();
    await Promise.resolve();

    expect(hudElement().dataset.state).toBe("idle");
    expect(hudShowCalls()).toBe(0);
  });

  it("joins multiple app labels and falls back when none arrive", async () => {
    await loadHud();

    await emit("meeting-detection-event", {
      type: "meeting_detected",
      payload: { activeProcessCount: 2, appLabels: ["Zoom", "Chrome"] },
    });
    expect(document.querySelector("#hud-meeting-app")).toHaveTextContent(
      "Zoom, Chrome",
    );

    await emit("meeting-detection-event", { type: "meeting_detected" });
    expect(document.querySelector("#hud-meeting-app")).toHaveTextContent(
      "Microphone in use",
    );
  });

  it("accepts local window events from the demo driver", async () => {
    await loadHud();

    window.dispatchEvent(
      new CustomEvent("meeting-detection-event", {
        detail: {
          type: "meeting_detected",
          payload: { activeProcessCount: 1, appLabels: ["Teams"] },
        },
      }),
    );
    await Promise.resolve();

    expect(hudElement().dataset.state).toBe("meeting");
    expect(document.querySelector("#hud-meeting-app")).toHaveTextContent(
      "Teams",
    );
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

    // The meeting exit is native motion (dictation_hud_exit resolves when
    // the window is hidden), so the pill lands back on idle immediately
    // under the mocked invoke.
    expect(mocks.hide).toHaveBeenCalledOnce();
    expect(hudElement().dataset.state).toBe("idle");
    expect(chromeCalls()).toEqual([true, false]);
  });

  it("hides and suppresses the prompt after 30 seconds without a click", async () => {
    vi.useFakeTimers();
    await loadHud();
    await emit("meeting-detection-event", { type: "meeting_detected" });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(hudElement().dataset.state).toBe("meeting");
    expect(mocks.hide).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    // The native exit (mocked invoke) completes immediately.
    expect(mocks.hide).toHaveBeenCalledOnce();
    expect(hudElement().dataset.state).toBe("idle");

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

  it("returns the pill to idle once the exit completes", async () => {
    vi.useFakeTimers();
    await loadHud();
    await emit("meeting-detection-event", { type: "meeting_detected" });
    await emit("meeting-detection-event", { type: "meeting_cleared" });

    expect(mocks.hide).toHaveBeenCalledOnce();
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

  it("silently dismisses the HUD when nothing was recorded", async () => {
    vi.useFakeTimers();
    await loadHud();
    await emit("dictation-event", { type: "finalizing_transcript" });
    mocks.invoke.mockClear();

    await emit("dictation-event", {
      type: "error",
      payload: {
        code: "missing_recording",
        message: "No recorded audio was available to transcribe.",
        silent: true,
      },
    });

    // No "Nothing recorded" toast: a silent end takes the normal exit fade
    // and says nothing, never surfacing the error treatment.
    expect(hudElement().dataset.state).toBe("exiting");
    expect(document.querySelector("#hud-error-text")).toHaveTextContent("");
    expect(hudShowCalls()).toBe(0);

    // Drain the in-flight exit. Its fallback timeout dies with the fake
    // clock, but the rAF alpha ramp keeps running on real time after this
    // test ends and would land its hide() inside the next test's counts.
    await vi.advanceTimersByTimeAsync(220);
    expect(mocks.hide).toHaveBeenCalledOnce();
  });

  it("quietly dismisses the HUD when stop finds nothing listening", async () => {
    vi.useFakeTimers();
    await loadHud();
    await emit("dictation-event", { type: "listening_started" });
    mocks.invoke.mockClear();

    await emit("dictation-event", {
      type: "error",
      payload: {
        code: "not_listening",
        message: "Dictation is not listening.",
      },
    });

    // The desired end state (not listening) already holds, so no toast:
    // the pill takes the same quiet exit as a silent end.
    expect(hudElement().dataset.state).toBe("exiting");
    expect(document.querySelector("#hud-error-text")).toHaveTextContent("");

    await vi.advanceTimersByTimeAsync(220);
    expect(mocks.hide).toHaveBeenCalledOnce();
  });

  it("shakes the listening pill instead of toasting when dictation is already listening", async () => {
    await loadHud();
    await emit("dictation-event", { type: "listening_started" });
    mocks.invoke.mockClear();

    await emit("dictation-event", {
      type: "error",
      payload: {
        code: "already_listening",
        message: "Dictation is already listening.",
      },
    });

    // The pill stays in its listening state — no toast, no show/hide cycle.
    expect(hudElement().dataset.state).toBe("listening");
    expect(document.querySelector("#hud-error-text")).toHaveTextContent("");
    expect(mocks.invoke).toHaveBeenCalledWith("dictation_hud_shake", undefined);
    expect(hudShowCalls()).toBe(0);
  });

  it("falls back to the error toast for already_listening outside the listening state", async () => {
    await loadHud();

    await emit("dictation-event", {
      type: "error",
      payload: {
        code: "already_listening",
        message: "Dictation is already listening.",
      },
    });

    expect(hudElement().dataset.state).toBe("error");
    expect(document.querySelector("#hud-error-text")).toHaveTextContent(
      "Dictation is already listening.",
    );
    expect(hudShowCalls()).toBe(1);
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

  it("does not claim the HUD for an agent handoff (the agent HUD announces it)", async () => {
    await loadHud();

    await emit(AGENT_SESSION_STATUS_EVENT, {
      status: "received",
      summary: "June is starting.",
    });

    expect(hudElement().dataset.state).toBe("idle");
    expect(hudShowCalls()).toBe(0);
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

function chromeCalls() {
  return mocks.invoke.mock.calls
    .filter(([command]) => command === "dictation_hud_set_chrome")
    .map(([, args]) => (args as { meeting: boolean }).meeting);
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
      <span class="hud-meeting-body">
        <span class="hud-meeting-mark" aria-hidden="true"></span>
        <span class="hud-meeting-text">
          <span id="hud-meeting-label" class="hud-meeting-label">Meeting detected</span>
          <span id="hud-meeting-app" class="hud-meeting-app"></span>
        </span>
      </span>
      <button id="hud-meeting-start" class="hud-meeting-start" type="button">
        <span class="hud-meeting-start-icon" aria-hidden="true"></span>
        Record
      </button>
      <button id="hud-meeting-dismiss" class="hud-meeting-dismiss" type="button" aria-label="Dismiss meeting prompt"></button>
      <button id="hud-stop" class="hud-stop" type="button" aria-label="Stop dictation">
        <span class="hud-stop-glyph" aria-hidden="true"></span>
      </button>
      <span id="hud-status" class="hud-status">Idle</span>
    </div>
  `;
}
