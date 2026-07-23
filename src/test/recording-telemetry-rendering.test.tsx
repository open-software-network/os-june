import { act, render, screen, waitFor } from "@testing-library/react";
import { useReducer, useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRecordingTelemetry } from "../app/use-recording-telemetry";
import { createInitialState, notesReducer } from "../app/state/app-state";
import {
  createRecordingTelemetryStore,
  RecordingTelemetryProvider,
  useRecordingElapsedMs,
} from "../lib/recording-telemetry-store";
import type { RecordingStatusDto, RecordingTelemetryDto } from "../lib/tauri";

type TauriListener = (event: { payload: RecordingTelemetryDto }) => unknown;

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, TauriListener>(),
  listen: vi.fn((event: string, listener: TauriListener) => {
    mocks.listeners.set(event, listener);
    return Promise.resolve(() => mocks.listeners.delete(event));
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

function status(): RecordingStatusDto {
  return {
    sessionId: "session-1",
    state: "recording",
    elapsedMs: 0,
    level: { peak: 0, rms: 0, recentPeaks: [] },
    silenceWarning: false,
    bytesWritten: 1024,
    sources: [
      {
        source: "microphone",
        state: "recording",
        elapsedMs: 0,
        bytesWritten: 1024,
        level: { peak: 0, rms: 0, recentPeaks: [] },
        silenceWarning: false,
        pathFinalized: false,
      },
    ],
    warnings: [],
  };
}

function telemetry(overrides: Partial<RecordingTelemetryDto> = {}): RecordingTelemetryDto {
  return {
    sessionId: "session-1",
    state: "recording",
    elapsedMs: 1500,
    level: { peak: 0.4, rms: 0.2, recentPeaks: [0.3, 0.4] },
    silenceWarning: false,
    sources: [
      {
        source: "microphone",
        state: "recording",
        elapsedMs: 1500,
        level: { peak: 0.4, rms: 0.2, recentPeaks: [0.3, 0.4] },
        silenceWarning: false,
      },
    ],
    warnings: [],
    ...overrides,
  };
}

function AppLevelProbe({ onRender }: { onRender: () => void }) {
  onRender();
  return null;
}

function ElapsedProbe({
  fallback,
  onRender,
}: {
  fallback: RecordingStatusDto;
  onRender: () => void;
}) {
  onRender();
  const elapsedMs = useRecordingElapsedMs(fallback.sessionId, fallback.elapsedMs);
  return <output aria-label="Elapsed seconds">{Math.floor(elapsedMs / 1000)}</output>;
}

function RecordingHarness({
  onAppRender,
  onElapsedRender,
}: {
  onAppRender: () => void;
  onElapsedRender: () => void;
}) {
  const initialStatusRef = useRef(status());
  const [state, dispatch] = useReducer(notesReducer, {
    ...createInitialState(),
    recordingStatus: initialStatusRef.current,
  });
  const recordingStatusRef = useRef<RecordingStatusDto | undefined>(initialStatusRef.current);
  const storeRef = useRef(createRecordingTelemetryStore(initialStatusRef.current));

  useRecordingTelemetry({
    dispatch,
    recordingTelemetryStore: storeRef.current,
    recordingStatusRef,
  });

  const currentStatus = state.recordingStatus;
  if (!currentStatus) return null;

  return (
    <RecordingTelemetryProvider store={storeRef.current}>
      <AppLevelProbe onRender={onAppRender} />
      <span data-testid="recording-state">{currentStatus.state}</span>
      <span data-testid="recording-warning">{currentStatus.warnings?.[0]?.message}</span>
      <ElapsedProbe fallback={currentStatus} onRender={onElapsedRender} />
    </RecordingTelemetryProvider>
  );
}

describe("recording telemetry render isolation", () => {
  beforeEach(() => {
    mocks.listeners.clear();
    mocks.listen.mockClear();
  });

  it("keeps ticks out of the App render path while lifecycle changes still propagate", async () => {
    const appRender = vi.fn();
    const elapsedRender = vi.fn();
    render(<RecordingHarness onAppRender={appRender} onElapsedRender={elapsedRender} />);
    await waitFor(() => expect(mocks.listeners.has("recording-telemetry")).toBe(true));

    expect(appRender).toHaveBeenCalledTimes(1);
    expect(elapsedRender).toHaveBeenCalledTimes(1);

    act(() => {
      mocks.listeners.get("recording-telemetry")?.({ payload: telemetry() });
    });

    expect(screen.getByRole("status", { name: "Elapsed seconds" })).toHaveTextContent("1");
    expect(appRender).toHaveBeenCalledTimes(1);
    expect(elapsedRender).toHaveBeenCalledTimes(2);

    act(() => {
      mocks.listeners.get("recording-telemetry")?.({
        payload: telemetry({ elapsedMs: 1900 }),
      });
    });

    expect(appRender).toHaveBeenCalledTimes(1);
    expect(elapsedRender).toHaveBeenCalledTimes(2);

    act(() => {
      mocks.listeners.get("recording-telemetry")?.({
        payload: telemetry({ state: "paused", elapsedMs: 2000 }),
      });
    });

    expect(screen.getByTestId("recording-state")).toHaveTextContent("paused");
    expect(appRender).toHaveBeenCalledTimes(2);

    act(() => {
      mocks.listeners.get("recording-telemetry")?.({
        payload: telemetry({
          state: "paused",
          elapsedMs: 2100,
          warnings: [
            {
              source: "microphone",
              code: "microphone_stream_stalled",
              message: "Microphone input stopped unexpectedly.",
            },
          ],
        }),
      });
    });

    expect(screen.getByTestId("recording-warning")).toHaveTextContent(
      "Microphone input stopped unexpectedly.",
    );
    expect(appRender).toHaveBeenCalledTimes(3);
  });
});
