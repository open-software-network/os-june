import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners = new Map<string, (event: { payload: unknown }) => void>();
const invokeMock = vi.fn(() => Promise.resolve(undefined));
const showMock = vi.fn(() => Promise.resolve(undefined));
const hideMock = vi.fn(() => Promise.resolve(undefined));
const startDraggingMock = vi.fn(() => Promise.resolve(undefined));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    (event: string, handler: (event: { payload: unknown }) => void) => {
      listeners.set(event, handler);
      return Promise.resolve(() => listeners.delete(event));
    },
  ),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    show: showMock,
    hide: hideMock,
    startDragging: startDraggingMock,
  }),
}));

describe("HUD meeting prompt", () => {
  beforeEach(async () => {
    vi.resetModules();
    listeners.clear();
    invokeMock.mockClear();
    showMock.mockClear();
    hideMock.mockClear();
    document.body.innerHTML = hudMarkup();
    await import("../hud");
    await Promise.resolve();
    invokeMock.mockClear();
  });

  it("renders meeting prompt events", async () => {
    await emitMeeting({
      type: "detected",
      payload: {
        detectionId: "meeting-1",
        appName: "Zoom",
        bundleId: "us.zoom.xos",
        pid: 42,
      },
    });

    await waitFor(() =>
      expect(document.querySelector("#hud")?.getAttribute("data-state")).toBe(
        "meeting-prompt",
      ),
    );
    expect(screen.getByText("Zoom")).toBeInTheDocument();
    expect(
      screen.getAllByText("Transcribe this meeting?").length,
    ).toBeGreaterThan(0);
    expect(invokeMock).toHaveBeenCalledWith(
      "meeting_detection_hud_prepare_prompt",
    );
  });

  it("starts detected meeting recording from the prompt", async () => {
    await emitMeeting({
      type: "detected",
      payload: {
        detectionId: "meeting-2",
        appName: "Teams",
        bundleId: "com.microsoft.teams2",
        pid: 77,
      },
    });
    invokeMock.mockClear();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Start meeting transcription",
      }),
    );
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledWith(
      "start_detected_meeting_recording",
      { detectionId: "meeting-2" },
    );
  });

  it("dismisses detected meeting prompts", async () => {
    await emitMeeting({
      type: "detected",
      payload: {
        detectionId: "meeting-3",
        appName: "FaceTime",
        bundleId: "com.apple.FaceTime",
        pid: 12,
      },
    });
    invokeMock.mockClear();

    fireEvent.click(
      await screen.findByRole("button", { name: "Dismiss meeting prompt" }),
    );
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledWith("dismiss_detected_meeting", {
      detectionId: "meeting-3",
    });
  });

  it("keeps dictation states working", async () => {
    await emitDictation({ type: "listening_started" });

    expect(document.querySelector("#hud")?.getAttribute("data-state")).toBe(
      "listening",
    );
    expect(screen.getByText("Listening")).toBeInTheDocument();
  });
});

async function emitMeeting(payload: unknown) {
  listeners.get("meeting-detection-event")?.({ payload });
  await Promise.resolve();
}

async function emitDictation(payload: unknown) {
  listeners.get("dictation-event")?.({ payload });
  await Promise.resolve();
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
        </div>
        <span id="hud-braille" class="hud-braille" aria-hidden="true"></span>
        <span class="hud-error-mark" aria-hidden="true"></span>
      </div>
      <span id="hud-error-text" class="hud-error-text" aria-hidden="true"></span>
      <div id="hud-meeting" class="hud-meeting" aria-live="polite">
        <div class="hud-meeting-copy">
          <span id="hud-meeting-app" class="hud-meeting-app">Meeting app</span>
          <span class="hud-meeting-question">Transcribe this meeting?</span>
        </div>
        <div class="hud-meeting-actions">
          <button id="hud-meeting-start" type="button" aria-label="Start meeting transcription"></button>
          <button id="hud-meeting-dismiss" type="button" aria-label="Dismiss meeting prompt"></button>
        </div>
      </div>
      <button id="hud-stop" class="hud-stop" type="button" aria-label="Stop dictation"></button>
      <span id="hud-status" class="hud-status">Idle</span>
    </div>
  `;
}
