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
  createRoutine: vi.fn<() => Promise<RoutineJob>>(),
  updateRoutine: vi.fn<() => Promise<RoutineJob>>(),
  triggerRoutine: vi.fn(),
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
    prompt: "Summarize my unread notes and flag anything urgent.",
    prompt_preview: "Summarize my unread notes",
    schedule: "0 9 * * *",
    repeat: "forever",
    deliver: "local",
    created_at: "2026-06-01T09:00:00",
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

function renderView(
  props: Partial<{
    onCreateRoutine: (prompt: string) => void;
    onOpenRun: (session: HermesSessionInfo) => void;
  }> = {},
) {
  return render(
    <RoutinesView
      onCreateRoutine={props.onCreateRoutine ?? vi.fn()}
      onOpenRun={props.onOpenRun ?? vi.fn()}
    />,
  );
}

async function openDetail(name: string) {
  const list = await screen.findByRole("list", { name: "Routines" });
  await userEvent.click(within(list).getByText(name));
  return screen.findByRole("textbox", { name: "Instructions" });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pauseRoutine.mockResolvedValue({});
  mocks.resumeRoutine.mockResolvedValue({});
  mocks.removeRoutine.mockResolvedValue({});
  mocks.triggerRoutine.mockResolvedValue({});
  mocks.createRoutine.mockResolvedValue(job());
  mocks.updateRoutine.mockResolvedValue(job());
  adapterMocks.listScheduledRunSessions.mockResolvedValue([]);
});

describe("RoutinesView list", () => {
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
    renderView();

    expect(await screen.findByText("Morning summary")).toBeInTheDocument();
    expect(screen.getByText("Weekly digest")).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getByText("Last run failed")).toBeInTheDocument();
    expect(screen.queryByText("Summarize my unread notes")).toBeNull();
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
    renderView();

    const nine = new Date(2000, 0, 1, 9, 0).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    expect(
      await screen.findByText(`Weekdays ${nine}`, { exact: false }),
    ).toBeInTheDocument();
    expect(screen.queryByText("0 9 * * 1-5", { exact: false })).toBeNull();

    // The search box matches the displayed wording, not just the raw cron.
    await userEvent.type(screen.getByRole("searchbox"), "weekdays");
    expect(screen.getByText("Morning summary")).toBeInTheDocument();
    expect(screen.queryByText("Weekly digest")).toBeNull();
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
    renderView();

    expect(await screen.findByText("Nightly cleanup")).toBeInTheDocument();
    // Badges for the toolset-widened and the script-backed routines, none
    // for the sandboxed one.
    const list = screen.getByRole("list", { name: "Routines" });
    expect(within(list).getAllByText("Unrestricted")).toHaveLength(2);
  });

  it("shows starter routines once routines exist", async () => {
    mocks.listRoutines.mockResolvedValue([job()]);
    renderView();

    expect(await screen.findByText("Morning summary")).toBeInTheDocument();
    const starters = screen.getByRole("region", { name: "Starter routines" });
    expect(within(starters).getByText("Morning brief")).toBeInTheDocument();
  });

  it("pauses a scheduled routine from its detail toggle and reloads", async () => {
    mocks.listRoutines.mockResolvedValue([job()]);
    renderView();
    await openDetail("Morning summary");

    mocks.listRoutines.mockResolvedValue([job({ state: "paused" })]);
    const toggle = screen.getByRole("switch", {
      name: "Morning summary active",
    });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);

    await waitFor(() =>
      expect(mocks.pauseRoutine).toHaveBeenCalledWith("abc123"),
    );
    expect(await screen.findByText("Paused")).toBeInTheDocument();
  });

  it("resumes a paused routine from its detail toggle", async () => {
    mocks.listRoutines.mockResolvedValue([job({ state: "paused" })]);
    renderView();
    await openDetail("Morning summary");

    const toggle = screen.getByRole("switch", {
      name: "Morning summary active",
    });
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    await waitFor(() =>
      expect(mocks.resumeRoutine).toHaveBeenCalledWith("abc123"),
    );
  });

  it("surfaces a failed reload after a successful pause", async () => {
    mocks.listRoutines.mockResolvedValue([job()]);
    renderView();
    await openDetail("Morning summary");

    mocks.listRoutines.mockRejectedValue(new Error("reload failed"));
    await userEvent.click(
      screen.getByRole("switch", { name: "Morning summary active" }),
    );

    expect(await screen.findByText("reload failed")).toBeInTheDocument();
  });

  it("surfaces a load error", async () => {
    mocks.listRoutines.mockRejectedValue(new Error("gateway down"));
    renderView();
    expect(await screen.findByText("gateway down")).toBeInTheDocument();
  });
});

describe("RoutinesView templates and creation", () => {
  it("shows starter templates while no routine exists", async () => {
    mocks.listRoutines.mockResolvedValue([]);
    renderView();

    expect(await screen.findByText("Morning brief")).toBeVisible();
    expect(screen.getByText("Morning brief")).toBeInTheDocument();
    expect(screen.getByText("Weekly review")).toBeInTheDocument();
  });

  it("opens the editor prefilled from a starter template", async () => {
    mocks.listRoutines.mockResolvedValue([]);
    renderView();
    await screen.findByText("Morning brief");

    await userEvent.click(
      screen.getByRole("button", { name: "Add Morning brief" }),
    );

    expect(screen.getByRole("textbox", { name: "Routine name" })).toHaveValue(
      "Morning brief",
    );
    const instructions = screen.getByRole("textbox", {
      name: "Instructions",
    }) as HTMLTextAreaElement;
    expect(instructions.value).toContain("morning brief");
    // The template schedule "0 8 * * 1-5" lands on the Weekdays preset.
    expect(
      screen.getByRole("button", { name: "Schedule type" }),
    ).toHaveTextContent("Weekdays");
  });

  it("creates a routine from the editor and opens its detail page", async () => {
    mocks.listRoutines.mockResolvedValueOnce([]);
    renderView();
    await screen.findByText("Morning brief");

    await userEvent.click(screen.getByRole("button", { name: "New routine" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "Instructions" }),
      "Summarize my unread notes and flag anything urgent.",
    );
    mocks.listRoutines.mockResolvedValue([job()]);
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(mocks.createRoutine).toHaveBeenCalledWith({
        prompt: "Summarize my unread notes and flag anything urgent.",
        schedule: "0 9 * * *",
        name: undefined,
        unrestricted: false,
      }),
    );
    // Creation lands on the new routine's detail page.
    expect(
      await screen.findByRole("textbox", { name: "Routine name" }),
    ).toHaveValue("Morning summary");
  });

  it("routes the describe path through the agent prompt, sandboxed by default", async () => {
    mocks.listRoutines.mockResolvedValue([]);
    const onCreateRoutine = vi.fn();
    renderView({ onCreateRoutine });
    await screen.findByText("Morning brief");

    // The composer bar is permanently anchored to the page bottom.
    const composer = screen.getByRole("form", {
      name: "Describe a routine to June",
    });
    // Its sandbox trigger reflects the default mode.
    expect(
      within(composer).getByRole("button", { name: /sandboxed/i }),
    ).toBeInTheDocument();

    await userEvent.type(
      within(composer).getByRole("textbox"),
      "watch the weather and message me",
    );
    await userEvent.click(
      within(composer).getByRole("button", { name: "Ask June to set it up" }),
    );

    const prompt = onCreateRoutine.mock.calls[0][0] as string;
    expect(prompt).toContain("watch the weather and message me");
    expect(prompt).toContain("cronjob tool");
    expect(prompt).toContain("Do not set enabled_toolsets");
    expect(prompt).not.toContain("Create the job with enabled_toolsets");
  });

  it("describes an unrestricted routine only after the explicit opt-in", async () => {
    mocks.listRoutines.mockResolvedValue([]);
    const onCreateRoutine = vi.fn();
    renderView({ onCreateRoutine });
    await screen.findByText("Morning brief");

    const composer = screen.getByRole("form", {
      name: "Describe a routine to June",
    });
    // Arm Unrestricted through the composer's sandbox menu.
    await userEvent.click(
      within(composer).getByRole("button", { name: /sandboxed/i }),
    );
    await userEvent.click(
      within(composer).getByRole("menuitemradio", { name: /unrestricted/i }),
    );
    await userEvent.type(
      within(composer).getByRole("textbox"),
      "clean up my downloads folder nightly",
    );
    await userEvent.click(
      within(composer).getByRole("button", { name: "Ask June to set it up" }),
    );

    const prompt = onCreateRoutine.mock.calls[0][0] as string;
    expect(prompt).toContain(
      "Create the job with enabled_toolsets set to exactly: terminal, file, code_execution",
    );
  });

  it("dismisses the describe mode menu with Escape", async () => {
    mocks.listRoutines.mockResolvedValue([]);
    renderView();
    await screen.findByText("Morning brief");

    const composer = screen.getByRole("form", {
      name: "Describe a routine to June",
    });
    await userEvent.click(
      within(composer).getByRole("button", { name: /sandboxed/i }),
    );
    expect(
      within(composer).getByRole("menuitemradio", { name: /unrestricted/i }),
    ).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    expect(
      within(composer).queryByRole("menuitemradio", { name: /unrestricted/i }),
    ).toBeNull();
  });
});

describe("RoutinesView detail", () => {
  it("opens a routine with its full instructions", async () => {
    mocks.listRoutines.mockResolvedValue([job()]);
    renderView();

    const instructions = await openDetail("Morning summary");
    expect(instructions).toHaveValue(
      "Summarize my unread notes and flag anything urgent.",
    );
    expect(screen.getByRole("textbox", { name: "Routine name" })).toHaveValue(
      "Morning summary",
    );
  });

  it("saves only the changed fields", async () => {
    mocks.listRoutines.mockResolvedValue([job()]);
    renderView();

    const instructions = await openDetail("Morning summary");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await userEvent.clear(instructions);
    await userEvent.type(instructions, "List my unread notes only.");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mocks.updateRoutine).toHaveBeenCalledWith("abc123", {
        prompt: "List my unread notes only.",
      }),
    );
  });

  it("restores a blank local name after saving unrelated changes", async () => {
    mocks.listRoutines
      .mockResolvedValueOnce([job()])
      .mockResolvedValueOnce([job()]);
    renderView();

    const instructions = await openDetail("Morning summary");
    const name = screen.getByRole("textbox", { name: "Routine name" });

    await userEvent.clear(name);
    await userEvent.clear(instructions);
    await userEvent.type(instructions, "List my unread notes only.");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mocks.updateRoutine).toHaveBeenCalledWith("abc123", {
        prompt: "List my unread notes only.",
      }),
    );
    await waitFor(() => expect(name).toHaveValue("Morning summary"));
  });

  it("saves a schedule preset change as a cron expression", async () => {
    mocks.listRoutines.mockResolvedValue([job()]);
    renderView();
    await openDetail("Morning summary");

    // The stored "0 9 * * *" lands on Daily; switch the preset to Weekdays.
    const trigger = screen.getByRole("button", { name: "Schedule type" });
    expect(trigger).toHaveTextContent("Daily");
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("option", { name: "Weekdays" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mocks.updateRoutine).toHaveBeenCalledWith("abc123", {
        schedule: "0 9 * * 1-5",
      }),
    );
  });

  it("widens access after the explicit unrestricted opt-in", async () => {
    mocks.listRoutines.mockResolvedValue([job()]);
    renderView();
    await openDetail("Morning summary");

    await userEvent.click(screen.getByRole("button", { name: "Unrestricted" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mocks.updateRoutine).toHaveBeenCalledWith("abc123", {
        unrestricted: true,
      }),
    );
  });

  it("queues an immediate run", async () => {
    mocks.listRoutines.mockResolvedValue([job()]);
    renderView();
    await openDetail("Morning summary");

    await userEvent.click(screen.getByRole("button", { name: "Run now" }));
    await waitFor(() =>
      expect(mocks.triggerRoutine).toHaveBeenCalledWith("abc123"),
    );
    expect(screen.getByRole("button", { name: "Queued" })).toBeDisabled();
  });

  it("shows this routine's runs and opens one on click", async () => {
    mocks.listRoutines.mockResolvedValue([job()]);
    const mine = run();
    adapterMocks.listScheduledRunSessions.mockResolvedValue([
      mine,
      run({
        id: "cron_other77_20260609_080000",
        title: "Someone else's run",
      }),
    ]);
    const onOpenRun = vi.fn();
    renderView({ onOpenRun });
    await openDetail("Morning summary");
    await userEvent.click(screen.getByRole("tab", { name: "Run history" }));

    const history = screen.getByRole("tabpanel", { name: "Run history" });
    expect(
      within(history).getByText("Morning Summary Digest"),
    ).toBeInTheDocument();
    expect(within(history).queryByText("Someone else's run")).toBeNull();

    await userEvent.click(
      within(history).getByRole("button", { name: /morning summary digest/i }),
    );
    expect(onOpenRun).toHaveBeenCalledWith(mine);
  });

  it("surfaces the last run failure", async () => {
    mocks.listRoutines.mockResolvedValue([
      job({ last_status: "error", last_error: "Model quota exhausted" }),
    ]);
    renderView();
    await openDetail("Morning summary");

    expect(screen.getByText(/Model quota exhausted/)).toBeInTheDocument();
  });

  it("deletes a routine after confirmation and returns to the list", async () => {
    mocks.listRoutines.mockResolvedValue([job()]);
    renderView();
    await openDetail("Morning summary");

    await userEvent.click(
      screen.getByRole("button", { name: "Routine actions" }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Delete routine" }),
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete" }),
    );

    await waitFor(() =>
      expect(mocks.removeRoutine).toHaveBeenCalledWith("abc123"),
    );
    // Back on the (now empty) list page.
    expect(await screen.findByText("Morning brief")).toBeInTheDocument();
  });

  it("surfaces a failed delete and keeps the routine", async () => {
    mocks.listRoutines.mockResolvedValue([job()]);
    mocks.removeRoutine.mockRejectedValue(new Error("remove failed"));
    renderView();
    await openDetail("Morning summary");

    await userEvent.click(
      screen.getByRole("button", { name: "Routine actions" }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Delete routine" }),
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete" }),
    );

    expect(await screen.findByText("remove failed")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Routine name" })).toHaveValue(
      "Morning summary",
    );
  });
});

describe("RoutinesView run history", () => {
  it("lists run history under the routines and opens a run on click", async () => {
    mocks.listRoutines.mockResolvedValue([job()]);
    const session = run();
    adapterMocks.listScheduledRunSessions.mockResolvedValue([session]);
    const onOpenRun = vi.fn();
    renderView({ onOpenRun });

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
    renderView();

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
    renderView();
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
    renderView();

    const history = await screen.findByRole("region", { name: "Run history" });
    expect(within(history).getByText(/No runs yet/)).toBeInTheDocument();
  });

  it("keeps routines usable when run history fails to load", async () => {
    mocks.listRoutines.mockResolvedValue([job()]);
    adapterMocks.listScheduledRunSessions.mockRejectedValue(
      new Error("session store down"),
    );
    renderView();

    expect(await screen.findByText("Morning summary")).toBeInTheDocument();
    const history = screen.getByRole("region", { name: "Run history" });
    expect(
      within(history).getByText("Run history is unavailable right now."),
    ).toBeInTheDocument();
  });
});
