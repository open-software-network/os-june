import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoutinesView } from "../components/routines/RoutinesView";
import type { RoutineJob } from "../lib/hermes-routines";

const mocks = vi.hoisted(() => ({
  listRoutines: vi.fn<() => Promise<RoutineJob[]>>(),
  pauseRoutine: vi.fn(),
  resumeRoutine: vi.fn(),
  removeRoutine: vi.fn(),
}));

vi.mock("../lib/hermes-routines", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/hermes-routines")>()),
  ...mocks,
}));

function job(overrides: Partial<RoutineJob> = {}): RoutineJob {
  return {
    job_id: "abc123",
    name: "Morning summary",
    prompt_preview: "Summarize my unread notes",
    schedule: "every day at 9:00",
    repeat: "forever",
    deliver: "local",
    next_run_at: "2026-06-10T09:00:00",
    last_run_at: null,
    last_status: null,
    enabled: true,
    state: "scheduled",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pauseRoutine.mockResolvedValue({ success: true });
  mocks.resumeRoutine.mockResolvedValue({ success: true });
  mocks.removeRoutine.mockResolvedValue({ success: true });
});

describe("RoutinesView", () => {
  it("lists routines with schedule and state", async () => {
    mocks.listRoutines.mockResolvedValue([
      job(),
      job({
        job_id: "def456",
        name: "Weekly digest",
        prompt_preview: "Compile a digest of the week",
        state: "paused",
        last_status: "error",
      }),
    ]);
    render(<RoutinesView onCreateRoutine={vi.fn()} onEditRoutine={vi.fn()} />);

    expect(await screen.findByText("Morning summary")).toBeInTheDocument();
    expect(screen.getByText("Weekly digest")).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getByText("Last run failed")).toBeInTheDocument();
    expect(screen.getByText("Summarize my unread notes")).toBeInTheDocument();
  });

  it("shows the empty state and routes creation through the agent prompt", async () => {
    mocks.listRoutines.mockResolvedValue([]);
    const onCreateRoutine = vi.fn();
    render(
      <RoutinesView
        onCreateRoutine={onCreateRoutine}
        onEditRoutine={vi.fn()}
      />,
    );

    expect(await screen.findByText("Put June on a schedule")).toBeVisible();
    await userEvent.click(
      screen.getAllByRole("button", { name: /new routine/i })[0],
    );

    const dialog = await screen.findByRole("dialog");
    await userEvent.type(
      within(dialog).getByRole("textbox"),
      "every morning, email me a digest",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Ask June to set it up" }),
    );

    expect(onCreateRoutine).toHaveBeenCalledTimes(1);
    const prompt = onCreateRoutine.mock.calls[0][0] as string;
    expect(prompt).toContain("every morning, email me a digest");
    expect(prompt).toContain("cronjob tool");
  });

  it("routes an edit through the agent prompt with the job reference", async () => {
    mocks.listRoutines.mockResolvedValue([job()]);
    const onEditRoutine = vi.fn();
    render(
      <RoutinesView onCreateRoutine={vi.fn()} onEditRoutine={onEditRoutine} />,
    );
    await screen.findByText("Morning summary");

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Edit “Morning summary”");
    await userEvent.type(
      within(dialog).getByRole("textbox"),
      "run at 7am instead",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Ask June to update it" }),
    );

    expect(onEditRoutine).toHaveBeenCalledTimes(1);
    const prompt = onEditRoutine.mock.calls[0][0] as string;
    expect(prompt).toContain("run at 7am instead");
    expect(prompt).toContain("abc123");
    expect(prompt).toContain("Morning summary");
    expect(prompt).toContain("update action");
  });

  it("does not send an edit with an empty description", async () => {
    mocks.listRoutines.mockResolvedValue([job()]);
    const onEditRoutine = vi.fn();
    render(
      <RoutinesView onCreateRoutine={vi.fn()} onEditRoutine={onEditRoutine} />,
    );
    await screen.findByText("Morning summary");

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("button", { name: "Ask June to update it" }),
    ).toBeDisabled();
    expect(onEditRoutine).not.toHaveBeenCalled();
  });

  it("pauses a scheduled routine and reloads the list", async () => {
    mocks.listRoutines.mockResolvedValue([job()]);
    render(<RoutinesView onCreateRoutine={vi.fn()} onEditRoutine={vi.fn()} />);
    await screen.findByText("Morning summary");

    mocks.listRoutines.mockResolvedValue([job({ state: "paused" })]);
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));

    await waitFor(() =>
      expect(mocks.pauseRoutine).toHaveBeenCalledWith("abc123"),
    );
    expect(await screen.findByText("Paused")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
  });

  it("resumes a paused routine", async () => {
    mocks.listRoutines.mockResolvedValue([job({ state: "paused" })]);
    render(<RoutinesView onCreateRoutine={vi.fn()} onEditRoutine={vi.fn()} />);
    await screen.findByText("Morning summary");

    await userEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() =>
      expect(mocks.resumeRoutine).toHaveBeenCalledWith("abc123"),
    );
  });

  it("deletes a routine after confirmation", async () => {
    mocks.listRoutines.mockResolvedValue([job()]);
    render(<RoutinesView onCreateRoutine={vi.fn()} onEditRoutine={vi.fn()} />);
    await screen.findByText("Morning summary");

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete" }),
    );

    await waitFor(() =>
      expect(mocks.removeRoutine).toHaveBeenCalledWith("abc123"),
    );
    await waitFor(() =>
      expect(screen.queryByText("Morning summary")).not.toBeInTheDocument(),
    );
  });

  it("surfaces a failed reload after a successful pause", async () => {
    mocks.listRoutines.mockResolvedValue([job()]);
    render(<RoutinesView onCreateRoutine={vi.fn()} onEditRoutine={vi.fn()} />);
    await screen.findByText("Morning summary");

    mocks.listRoutines.mockRejectedValue(new Error("reload failed"));
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));

    expect(await screen.findByText("reload failed")).toBeInTheDocument();
  });

  it("surfaces a failed delete in the error banner", async () => {
    mocks.listRoutines.mockResolvedValue([job()]);
    mocks.removeRoutine.mockRejectedValue(new Error("remove failed"));
    render(<RoutinesView onCreateRoutine={vi.fn()} onEditRoutine={vi.fn()} />);
    await screen.findByText("Morning summary");

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete" }),
    );

    expect(await screen.findByText("remove failed")).toBeInTheDocument();
    // The routine stays listed — only a successful delete removes the row.
    expect(screen.getByText("Morning summary")).toBeInTheDocument();
  });

  it("surfaces a load error", async () => {
    mocks.listRoutines.mockRejectedValue(new Error("gateway down"));
    render(<RoutinesView onCreateRoutine={vi.fn()} onEditRoutine={vi.fn()} />);
    expect(await screen.findByText("gateway down")).toBeInTheDocument();
  });
});
