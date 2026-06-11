import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RoutinesView } from "../components/routines/RoutinesView";
import type { RoutineJob } from "../lib/hermes-routines";
import type { HermesSessionInfo } from "../lib/tauri";

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

const adapterMocks = vi.hoisted(() => ({
  listScheduledRunSessions: vi.fn<() => Promise<HermesSessionInfo[]>>(),
}));

vi.mock("../lib/hermes-adapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/hermes-adapter")>()),
  listScheduledRunSessions: adapterMocks.listScheduledRunSessions,
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

function run(overrides: Partial<HermesSessionInfo> = {}): HermesSessionInfo {
  return {
    id: "cron_abc123_20260610_090000",
    source: "cron",
    title: "Morning Summary Digest",
    preview: "Here is today's summary of your unread notes.",
    last_active: "2026-06-10T09:00:30Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pauseRoutine.mockResolvedValue({ success: true });
  mocks.resumeRoutine.mockResolvedValue({ success: true });
  mocks.removeRoutine.mockResolvedValue({ success: true });
  adapterMocks.listScheduledRunSessions.mockResolvedValue([]);
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
    render(
      <RoutinesView
        onCreateRoutine={vi.fn()}
        onEditRoutine={vi.fn()}
        onOpenRun={vi.fn()}
      />,
    );

    expect(await screen.findByText("Morning summary")).toBeInTheDocument();
    expect(screen.getByText("Weekly digest")).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getByText("Last run failed")).toBeInTheDocument();
    expect(screen.getByText("Summarize my unread notes")).toBeInTheDocument();
  });

  it("shows cron schedules as plain language and matches it in search", async () => {
    mocks.listRoutines.mockResolvedValue([
      job({ schedule: "0 9 * * 1-5" }),
      job({
        job_id: "def456",
        name: "Weekly digest",
        prompt_preview: "Compile a digest of the week",
        schedule: "0 8 * * 1",
      }),
    ]);
    render(
      <RoutinesView
        onCreateRoutine={vi.fn()}
        onEditRoutine={vi.fn()}
        onOpenRun={vi.fn()}
      />,
    );

    const nine = new Date(2000, 0, 1, 9, 0).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    expect(
      await screen.findByText(`Weekdays at ${nine}`, { exact: false }),
    ).toBeInTheDocument();
    expect(screen.queryByText("0 9 * * 1-5", { exact: false })).toBeNull();

    // The search box matches the displayed wording, not just the raw cron.
    await userEvent.type(screen.getByRole("searchbox"), "weekdays");
    expect(screen.getByText("Morning summary")).toBeInTheDocument();
    expect(screen.queryByText("Weekly digest")).toBeNull();
  });

  it("defaults a new routine to sandboxed and says so in the prompt", async () => {
    mocks.listRoutines.mockResolvedValue([]);
    const onCreateRoutine = vi.fn();
    render(
      <RoutinesView
        onCreateRoutine={onCreateRoutine}
        onEditRoutine={vi.fn()}
        onOpenRun={vi.fn()}
      />,
    );

    await userEvent.click(
      (await screen.findAllByRole("button", { name: /new routine/i }))[0],
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("radio", { name: "Sandboxed" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(dialog).toHaveTextContent(
      "It cannot run commands or change your files.",
    );

    await userEvent.type(
      within(dialog).getByRole("textbox"),
      "watch the weather and message me",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Ask June to set it up" }),
    );

    const prompt = onCreateRoutine.mock.calls[0][0] as string;
    expect(prompt).toContain("Do not set enabled_toolsets");
    // Cron scripts run as shell subprocesses outside the toolset gate, so a
    // sandboxed routine must not get one either.
    expect(prompt).toContain("Do not attach a script");
    expect(prompt).not.toContain("Create the job with enabled_toolsets");
  });

  it("creates an unrestricted routine only after the explicit opt-in", async () => {
    mocks.listRoutines.mockResolvedValue([]);
    const onCreateRoutine = vi.fn();
    render(
      <RoutinesView
        onCreateRoutine={onCreateRoutine}
        onEditRoutine={vi.fn()}
        onOpenRun={vi.fn()}
      />,
    );

    await userEvent.click(
      (await screen.findAllByRole("button", { name: /new routine/i }))[0],
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("radio", { name: "Unrestricted" }),
    );
    expect(dialog).toHaveTextContent(
      "June can run commands and change any file your account can.",
    );

    await userEvent.type(
      within(dialog).getByRole("textbox"),
      "clean up my downloads folder nightly",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Ask June to set it up" }),
    );

    const prompt = onCreateRoutine.mock.calls[0][0] as string;
    expect(prompt).toContain(
      "Create the job with enabled_toolsets set to exactly: terminal, file, code_execution",
    );
  });

  it("badges routines that carry machine toolsets or a cron script", async () => {
    mocks.listRoutines.mockResolvedValue([
      job(),
      job({
        job_id: "def456",
        name: "Nightly cleanup",
        enabled_toolsets: ["terminal", "file", "web"],
      }),
      // Scripts run as shell subprocesses of the unjailed gateway, outside
      // the toolset gate, so a script-backed job is unrestricted even with
      // no enabled_toolsets override.
      job({
        job_id: "ghi789",
        name: "Disk watchdog",
        script: "/Users/junho/bin/check-disk.sh",
        no_agent: true,
      }),
    ]);
    render(
      <RoutinesView
        onCreateRoutine={vi.fn()}
        onEditRoutine={vi.fn()}
        onOpenRun={vi.fn()}
      />,
    );

    expect(await screen.findByText("Nightly cleanup")).toBeInTheDocument();
    // Badges for the toolset-widened and the script-backed routines, none
    // for the sandboxed one.
    expect(screen.getAllByText("Unrestricted")).toHaveLength(2);
  });

  it("shows the empty state and routes creation through the agent prompt", async () => {
    mocks.listRoutines.mockResolvedValue([]);
    const onCreateRoutine = vi.fn();
    render(
      <RoutinesView
        onCreateRoutine={onCreateRoutine}
        onEditRoutine={vi.fn()}
        onOpenRun={vi.fn()}
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
      <RoutinesView
        onCreateRoutine={vi.fn()}
        onEditRoutine={onEditRoutine}
        onOpenRun={vi.fn()}
      />,
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
    // No enabled_toolsets on the fixture, so the prompt reports the
    // sandboxed default and carries the mode-change instructions.
    expect(prompt).toContain("currently sandboxed");
  });

  it("does not send an edit with an empty description", async () => {
    mocks.listRoutines.mockResolvedValue([job()]);
    const onEditRoutine = vi.fn();
    render(
      <RoutinesView
        onCreateRoutine={vi.fn()}
        onEditRoutine={onEditRoutine}
        onOpenRun={vi.fn()}
      />,
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
    render(
      <RoutinesView
        onCreateRoutine={vi.fn()}
        onEditRoutine={vi.fn()}
        onOpenRun={vi.fn()}
      />,
    );
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
    render(
      <RoutinesView
        onCreateRoutine={vi.fn()}
        onEditRoutine={vi.fn()}
        onOpenRun={vi.fn()}
      />,
    );
    await screen.findByText("Morning summary");

    await userEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() =>
      expect(mocks.resumeRoutine).toHaveBeenCalledWith("abc123"),
    );
  });

  it("deletes a routine after confirmation", async () => {
    mocks.listRoutines.mockResolvedValue([job()]);
    render(
      <RoutinesView
        onCreateRoutine={vi.fn()}
        onEditRoutine={vi.fn()}
        onOpenRun={vi.fn()}
      />,
    );
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
    render(
      <RoutinesView
        onCreateRoutine={vi.fn()}
        onEditRoutine={vi.fn()}
        onOpenRun={vi.fn()}
      />,
    );
    await screen.findByText("Morning summary");

    mocks.listRoutines.mockRejectedValue(new Error("reload failed"));
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));

    expect(await screen.findByText("reload failed")).toBeInTheDocument();
  });

  it("surfaces a failed delete in the error banner", async () => {
    mocks.listRoutines.mockResolvedValue([job()]);
    mocks.removeRoutine.mockRejectedValue(new Error("remove failed"));
    render(
      <RoutinesView
        onCreateRoutine={vi.fn()}
        onEditRoutine={vi.fn()}
        onOpenRun={vi.fn()}
      />,
    );
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
    render(
      <RoutinesView
        onCreateRoutine={vi.fn()}
        onEditRoutine={vi.fn()}
        onOpenRun={vi.fn()}
      />,
    );
    expect(await screen.findByText("gateway down")).toBeInTheDocument();
  });

  it("lists run history under the routines and opens a run on click", async () => {
    mocks.listRoutines.mockResolvedValue([job()]);
    const session = run();
    adapterMocks.listScheduledRunSessions.mockResolvedValue([session]);
    const onOpenRun = vi.fn();
    render(
      <RoutinesView
        onCreateRoutine={vi.fn()}
        onEditRoutine={vi.fn()}
        onOpenRun={onOpenRun}
      />,
    );

    const history = await screen.findByRole("region", { name: "Run history" });
    // The run is labeled with its routine's name (matched via the job id
    // embedded in the cron session id), not the session's own title.
    expect(within(history).getByText("Morning summary")).toBeInTheDocument();
    expect(
      within(history).getByText(
        "Here is today's summary of your unread notes.",
      ),
    ).toBeInTheDocument();

    await userEvent.click(
      within(history).getByRole("button", { name: /morning summary/i }),
    );
    expect(onOpenRun).toHaveBeenCalledWith(session);
  });

  it("labels a run by its session title once the routine is deleted", async () => {
    mocks.listRoutines.mockResolvedValue([job()]);
    adapterMocks.listScheduledRunSessions.mockResolvedValue([
      run({
        id: "cron_gone99_20260609_080000",
        title: "Weekly Metrics Digest",
        preview: "Metrics are flat week over week.",
      }),
    ]);
    render(
      <RoutinesView
        onCreateRoutine={vi.fn()}
        onEditRoutine={vi.fn()}
        onOpenRun={vi.fn()}
      />,
    );

    const history = await screen.findByRole("region", { name: "Run history" });
    expect(
      within(history).getByText("Weekly Metrics Digest"),
    ).toBeInTheDocument();
  });

  it("filters run history with the search query", async () => {
    mocks.listRoutines.mockResolvedValue([
      job(),
      job({ job_id: "def456", name: "Weekly digest" }),
    ]);
    adapterMocks.listScheduledRunSessions.mockResolvedValue([
      run(),
      run({
        id: "cron_def456_20260609_080000",
        preview: "Compiled the weekly digest.",
        last_active: "2026-06-09T08:00:30Z",
      }),
    ]);
    render(
      <RoutinesView
        onCreateRoutine={vi.fn()}
        onEditRoutine={vi.fn()}
        onOpenRun={vi.fn()}
      />,
    );
    await screen.findByRole("region", { name: "Run history" });

    await userEvent.type(screen.getByRole("searchbox"), "weekly");
    const history = screen.getByRole("region", { name: "Run history" });
    expect(within(history).getByText("Weekly digest")).toBeInTheDocument();
    expect(within(history).queryByText("Morning summary")).toBeNull();

    // A query matching no runs hides the section instead of leaving an
    // empty shell under the routines results.
    await userEvent.clear(screen.getByRole("searchbox"));
    await userEvent.type(screen.getByRole("searchbox"), "no such run");
    expect(screen.queryByRole("region", { name: "Run history" })).toBeNull();
  });

  it("shows a quiet hint while no routine has run yet", async () => {
    mocks.listRoutines.mockResolvedValue([job()]);
    render(
      <RoutinesView
        onCreateRoutine={vi.fn()}
        onEditRoutine={vi.fn()}
        onOpenRun={vi.fn()}
      />,
    );

    const history = await screen.findByRole("region", { name: "Run history" });
    expect(within(history).getByText(/No runs yet/)).toBeInTheDocument();
  });

  it("keeps routines usable when run history fails to load", async () => {
    mocks.listRoutines.mockResolvedValue([job()]);
    adapterMocks.listScheduledRunSessions.mockRejectedValue(
      new Error("session store down"),
    );
    render(
      <RoutinesView
        onCreateRoutine={vi.fn()}
        onEditRoutine={vi.fn()}
        onOpenRun={vi.fn()}
      />,
    );

    expect(await screen.findByText("Morning summary")).toBeInTheDocument();
    const history = screen.getByRole("region", { name: "Run history" });
    expect(
      within(history).getByText("Run history is unavailable right now."),
    ).toBeInTheDocument();
  });
});
