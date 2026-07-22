import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FocusWorkspace } from "../components/focus/FocusWorkspace";
import type { FocusSessionDto, FocusStatus } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  focusAbandon: vi.fn(),
  focusFinish: vi.fn(),
  focusHistory: vi.fn(),
  focusListMacosShortcuts: vi.fn(),
  focusPause: vi.fn(),
  focusReassignSegment: vi.fn(),
  focusResume: vi.fn(),
  focusSplitSegment: vi.fn(),
  focusStart: vi.fn(),
  focusStartPlan: vi.fn(),
  focusStartBreak: vi.fn(),
  focusStatus: vi.fn(),
  focusUpdateCompletion: vi.fn(),
  focusUpdateNextProject: vi.fn(),
}));

const eventMocks = vi.hoisted(() => ({
  listen: vi.fn(async () => () => undefined),
}));

vi.mock("@tauri-apps/api/event", () => eventMocks);

vi.mock("../lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/platform")>()),
  isMacLikePlatform: () => true,
}));

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  ...mocks,
}));

const PROJECTS = [
  {
    id: "project-1",
    name: "Launch",
    memoryDisabled: false,
    createdAt: "2027-01-15T00:00:00.000Z",
    updatedAt: "2027-01-15T00:00:00.000Z",
  },
  {
    id: "project-2",
    name: "Support",
    memoryDisabled: false,
    createdAt: "2027-01-15T00:00:00.000Z",
    updatedAt: "2027-01-15T00:00:00.000Z",
  },
  {
    id: "project-3",
    name: "Release",
    memoryDisabled: false,
    createdAt: "2027-01-15T00:00:00.000Z",
    updatedAt: "2027-01-15T00:00:00.000Z",
  },
];

function session(status: FocusStatus, id = `focus-${status}`): FocusSessionDto {
  const terminal = status === "completed" || status === "abandoned";
  return {
    id,
    intention: status === "abandoned" ? "Abandoned work" : "Ship Focus",
    status,
    currentIntervalPosition: status === "onBreak" ? 1 : 0,
    createdAt: "2027-01-15T09:00:00.000Z",
    startedAt: "2027-01-15T09:00:00.000Z",
    completedAt: status === "completed" ? "2027-01-15T09:20:00.000Z" : undefined,
    abandonedAt: status === "abandoned" ? "2027-01-15T09:10:00.000Z" : undefined,
    intervals: [
      {
        position: 0,
        kind: "focus",
        plannedDurationMs: 1_500_000,
        projectId: "project-1",
        projectName: "Launch",
      },
      { position: 1, kind: "break", plannedDurationMs: 300_000 },
      {
        position: 2,
        kind: "focus",
        plannedDurationMs: 1_500_000,
        projectId: "project-2",
        projectName: "Support",
      },
    ],
    segments: terminal
      ? [
          {
            id: `segment-${id}`,
            intervalPosition: 0,
            kind: "focus",
            startedAt: "2027-01-15T09:00:00.000Z",
            endedAt: "2027-01-15T09:20:00.000Z",
            durationMs: 1_200_000,
            projectId: "project-1",
            projectName: "Launch",
          },
        ]
      : [],
    plannedFocusMs: 3_000_000,
    actualFocusMs: terminal ? 1_200_000 : 600_000,
    actualBreakMs: 0,
    pausedMs: 0,
    currentElapsedMs: 600_000,
    remainingMs: 900_000,
    overtimeMs: status === "overtime" ? 60_000 : 0,
    outcome: status === "abandoned" ? "abandoned" : terminal ? "shortened" : "active",
  };
}

async function renderWorkspace(active: FocusSessionDto | null, history: FocusSessionDto[] = []) {
  mocks.focusStatus.mockResolvedValue(active);
  mocks.focusHistory.mockResolvedValue(history);
  render(<FocusWorkspace projects={PROJECTS} />);
  await screen.findByRole("heading", { name: "Make time for one clear intention" });
  await waitFor(() => expect(screen.queryByRole("status", { name: "Loading Focus" })).toBeNull());
}

async function selectOption(label: string, option: string) {
  const trigger = screen.getByRole("button", { name: label });
  const control = trigger.parentElement;
  if (!control) throw new Error("Select control is missing");
  vi.spyOn(control, "getBoundingClientRect").mockReturnValue({
    bottom: 82,
    left: 20,
    top: 50,
    width: 220,
  } as DOMRect);
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.focusListMacosShortcuts.mockResolvedValue([]);
});

describe("Focus workspace", () => {
  it("starts with a 25-minute preset and exposes a four-interval Project plan", async () => {
    const started = session("focusing");
    mocks.focusStart.mockResolvedValue(started);
    await renderWorkspace(null);

    expect(screen.getByRole("button", { name: "25 min" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Intervals" }));

    expect(screen.getAllByText(/^Focus [1-4]$/)).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Focus 1 Project" })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Long break minutes" })).toHaveValue(15);
    fireEvent.click(screen.getByRole("button", { name: "Start Focus" }));

    await waitFor(() => expect(mocks.focusStart).toHaveBeenCalledTimes(1));
    expect(mocks.focusStart.mock.calls[0]?.[0].intervalPlan).toHaveLength(7);
  });

  it("accepts an arbitrary bounded duration", async () => {
    mocks.focusStart.mockResolvedValue(session("focusing"));
    await renderWorkspace(null);

    fireEvent.change(screen.getByRole("spinbutton", { name: "Focus minutes" }), {
      target: { value: "40" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Intention" }), {
      target: { value: "Write the release note" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start Focus" }));

    await waitFor(() =>
      expect(mocks.focusStart).toHaveBeenCalledWith({
        durationMinutes: 40,
        intention: "Write the release note",
        projectId: undefined,
      }),
    );
  });

  it("runs the selected macOS Shortcut when Focus starts", async () => {
    mocks.focusListMacosShortcuts.mockResolvedValue(["Writing Focus"]);
    mocks.focusStart.mockResolvedValue(session("focusing"));
    await renderWorkspace(null);

    await waitFor(() => expect(mocks.focusListMacosShortcuts).toHaveBeenCalledTimes(1));
    await selectOption("Start shortcut", "Writing Focus");
    expect(screen.getByText("Writing Focus will run once after Focus starts.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start Focus" }));

    await waitFor(() =>
      expect(mocks.focusStart).toHaveBeenCalledWith(
        expect.objectContaining({ startShortcutName: "Writing Focus" }),
      ),
    );
  });

  it("lets the user retry when macOS Shortcuts cannot be loaded", async () => {
    mocks.focusListMacosShortcuts
      .mockRejectedValueOnce(new Error("Shortcuts unavailable"))
      .mockResolvedValueOnce(["Deep work"]);
    await renderWorkspace(null);

    expect(await screen.findByText("Your shortcuts could not be loaded.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(mocks.focusListMacosShortcuts).toHaveBeenCalledTimes(2));
    await selectOption("Start shortcut", "Deep work");
    expect(screen.getByText("Deep work will run once after Focus starts.")).toBeInTheDocument();
  });

  it("shows a non-fatal warning when the start Shortcut fails", async () => {
    await renderWorkspace(session("focusing"));
    const listenCalls = eventMocks.listen.mock.calls as unknown as Array<
      [string, (event: { payload: { message: string } }) => void]
    >;
    const shortcutErrorListener = listenCalls.find(
      ([eventName]) => eventName === "june:focus:shortcut-error",
    )?.[1] as ((event: { payload: { message: string } }) => void) | undefined;

    shortcutErrorListener?.({
      payload: { message: "Focus started, but the selected macOS Shortcut did not run." },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Focus started, but the selected macOS Shortcut did not run.",
    );
  });

  it("activates duration presets from the keyboard", async () => {
    const user = userEvent.setup();
    await renderWorkspace(null);
    const preset = screen.getByRole("button", { name: "40 min" });

    preset.focus();
    await user.keyboard("{Enter}");

    expect(preset).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("spinbutton", { name: "Focus minutes" })).toHaveValue(40);
  });

  it.each([
    ["planned", "Start Focus"],
    ["focusing", "Pause"],
    ["paused", "Resume"],
    ["overtime", "Overtime"],
    ["onBreak", "Start next focus"],
  ] as const)("renders the %s phase with its relevant control", async (status, label) => {
    await renderWorkspace(session(status));
    expect(
      screen.getByText(label, {
        selector: status === "overtime" ? ".focus-status-chip" : "button",
      }),
    ).toBeInTheDocument();
  });

  it("changes the next focus interval's Project while active", async () => {
    const active = session("focusing");
    const updated = {
      ...active,
      intervals: active.intervals.map((interval) =>
        interval.position === 2
          ? { ...interval, projectId: "project-3", projectName: "Release" }
          : interval,
      ),
    };
    mocks.focusUpdateNextProject.mockResolvedValue(updated);
    await renderWorkspace(active);

    await selectOption("Next Focus Project", "Release");

    await waitFor(() =>
      expect(mocks.focusUpdateNextProject).toHaveBeenCalledWith({
        sessionId: active.id,
        projectId: "project-3",
      }),
    );
  });

  it("shows terminal outcomes, Project allocation, split, and reassignment controls", async () => {
    const completed = session("completed");
    const abandoned = session("abandoned");
    mocks.focusSplitSegment.mockResolvedValue(completed);
    mocks.focusReassignSegment.mockResolvedValue(completed);
    await renderWorkspace(null, [completed, abandoned]);

    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByText("Abandoned work")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Ship Focus/ }));

    expect(screen.getByRole("table", { name: "Project allocation" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Split evenly" }));
    await waitFor(() =>
      expect(mocks.focusSplitSegment).toHaveBeenCalledWith(
        "segment-focus-completed",
        "2027-01-15T09:10:00.000Z",
      ),
    );

    await selectOption("Focus Project", "Support");
    await waitFor(() =>
      expect(mocks.focusReassignSegment).toHaveBeenCalledWith({
        segmentId: "segment-focus-completed",
        projectId: "project-2",
      }),
    );
  });
});
