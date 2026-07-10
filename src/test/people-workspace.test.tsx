import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PeopleWorkspace } from "../components/people/PeopleWorkspace";

const mocks = vi.hoisted(() => ({
  listPersonas: vi.fn(),
  getPersona: vi.fn(),
  updatePersona: vi.fn(),
  archivePersona: vi.fn(),
  restorePersona: vi.fn(),
  deletePersona: vi.fn(),
  scrubDeletedPersonaFromNotes: vi.fn(),
  createPersonaCommitment: vi.fn(),
  updatePersonaCommitment: vi.fn(),
  deletePersonaCommitment: vi.fn(),
  retryPersonaDossierJob: vi.fn(),
}));

vi.mock("../lib/tauri", () => mocks);

const now = "2026-07-10T10:00:00Z";

function summary(overrides: Record<string, unknown> = {}) {
  return {
    id: "persona-jun",
    name: "Jun",
    relationship: "Product lead",
    voiceprintCount: 3,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function detail(overrides: Record<string, unknown> = {}) {
  return {
    ...summary(),
    dossier: "Jun owns the product roadmap.",
    commitments: [
      {
        id: "commitment-1",
        personaId: "persona-jun",
        direction: "personaOwesUser",
        text: "Share the revised roadmap",
        dueValue: "2026-07-15",
        status: "open",
        sourceNoteId: "note-1",
        sourceNoteTitle: "Roadmap review",
        createdAt: now,
        updatedAt: now,
      },
    ],
    meetings: [
      {
        noteId: "note-1",
        title: "Roadmap review",
        preview: "Discussed roadmap timing.",
        provenance: "confirmed",
        firstConfirmedAt: now,
        lastSeenAt: now,
      },
    ],
    dossierJobs: [],
    ...overrides,
  };
}

function props(overrides: Record<string, unknown> = {}) {
  return {
    onSelectPersona: vi.fn(),
    onOpenNote: vi.fn(),
    onPrepare: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listPersonas.mockResolvedValue([summary()]);
  mocks.getPersona.mockResolvedValue(detail());
  mocks.updatePersona.mockResolvedValue(detail());
  mocks.archivePersona.mockResolvedValue(detail({ archivedAt: now }));
  mocks.restorePersona.mockResolvedValue(detail({ archivedAt: undefined }));
  mocks.deletePersona.mockResolvedValue({
    deletionBatchId: "delete-1",
    affectedTranscriptCount: 2,
    affectedNoteIds: ["note-1"],
  });
  mocks.scrubDeletedPersonaFromNotes.mockResolvedValue(undefined);
  mocks.createPersonaCommitment.mockResolvedValue(detail());
  mocks.updatePersonaCommitment.mockResolvedValue(detail());
  mocks.deletePersonaCommitment.mockResolvedValue(detail());
  mocks.retryPersonaDossierJob.mockResolvedValue(detail());
});

describe("PeopleWorkspace list", () => {
  it("lists known people and opens one with a disambiguating accessible name", async () => {
    const callbacks = props();
    const user = userEvent.setup();
    render(<PeopleWorkspace {...callbacks} />);

    expect(screen.getByRole("heading", { name: "People June knows" })).toBeInTheDocument();
    const open = await screen.findByRole("button", { name: "Open Jun, Product lead" });
    expect(screen.getByText("3 voiceprints")).toBeInTheDocument();

    await user.click(open);
    expect(callbacks.onSelectPersona).toHaveBeenCalledWith("persona-jun");
  });

  it("sends active, archived, and search filters to the authoritative list command", async () => {
    const user = userEvent.setup();
    render(<PeopleWorkspace {...props()} />);

    await waitFor(() =>
      expect(mocks.listPersonas).toHaveBeenCalledWith({ filter: "active", query: undefined }),
    );
    await user.click(screen.getByRole("button", { name: "Archived" }));
    await waitFor(() =>
      expect(mocks.listPersonas).toHaveBeenCalledWith({ filter: "archived", query: undefined }),
    );

    await user.type(screen.getByRole("searchbox", { name: "Search people" }), "Jun");
    await waitFor(() =>
      expect(mocks.listPersonas).toHaveBeenLastCalledWith({ filter: "archived", query: "Jun" }),
    );
  });

  it("shows a retryable error instead of losing the People destination", async () => {
    mocks.listPersonas.mockRejectedValue(new Error("database unavailable"));
    const user = userEvent.setup();
    render(<PeopleWorkspace {...props()} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("database unavailable");
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mocks.listPersonas).toHaveBeenCalledTimes(2));
  });
});

describe("PeopleWorkspace detail", () => {
  it("edits identity and dossier, prepares, and opens source notes", async () => {
    const callbacks = props({ selectedPersonaId: "persona-jun" });
    const user = userEvent.setup();
    render(<PeopleWorkspace {...callbacks} />);

    expect(await screen.findByRole("heading", { name: "Jun", level: 1 })).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Jun Park");
    await user.clear(screen.getByLabelText("Relationship"));
    await user.type(screen.getByLabelText("Relationship"), "Product partner");
    await user.clear(screen.getByLabelText("What June remembers"));
    await user.type(screen.getByLabelText("What June remembers"), "Owns the roadmap.");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(mocks.updatePersona).toHaveBeenCalledWith({
        personaId: "persona-jun",
        name: "Jun Park",
        relationship: "Product partner",
        dossier: "Owns the roadmap.",
      }),
    );

    await user.click(screen.getByRole("button", { name: "Prepare for meeting" }));
    expect(callbacks.onPrepare).toHaveBeenCalledWith("persona-jun");

    const roadmapLinks = screen.getAllByRole("button", { name: "Roadmap review" });
    await user.click(roadmapLinks[0]!);
    expect(callbacks.onOpenNote).toHaveBeenCalledWith("note-1", "persona-jun");
  });

  it("adds, updates, and deletes structured commitments", async () => {
    const user = userEvent.setup();
    render(<PeopleWorkspace {...props({ selectedPersonaId: "persona-jun" })} />);
    await screen.findByRole("heading", { name: "Commitments" });

    await user.click(screen.getByRole("button", { name: "Add commitment" }));
    const dialog = screen.getByRole("dialog", { name: "Add commitment" });
    await user.type(within(dialog).getByLabelText("Commitment"), "Send the launch plan");
    await user.click(within(dialog).getByRole("button", { name: "Add commitment" }));
    await waitFor(() =>
      expect(mocks.createPersonaCommitment).toHaveBeenCalledWith({
        personaId: "persona-jun",
        direction: "personaOwesUser",
        text: "Send the launch plan",
        due: undefined,
      }),
    );

    await user.click(screen.getByRole("button", { name: "Status for Share the revised roadmap" }));
    await user.click(screen.getByRole("option", { name: "Done" }));
    expect(mocks.updatePersonaCommitment).toHaveBeenCalledWith({
      commitmentId: "commitment-1",
      direction: "personaOwesUser",
      text: "Share the revised roadmap",
      due: "2026-07-15",
      status: "done",
    });

    await user.click(
      screen.getByRole("button", { name: "Delete commitment: Share the revised roadmap" }),
    );
    expect(mocks.deletePersonaCommitment).toHaveBeenCalledWith("commitment-1");
  });

  it("keeps delete and historical scrub as two explicit confirmations", async () => {
    const callbacks = props({ selectedPersonaId: "persona-jun" });
    const user = userEvent.setup();
    render(<PeopleWorkspace {...callbacks} />);
    await screen.findByRole("heading", { name: "Jun", level: 1 });

    await user.click(screen.getByRole("button", { name: "Delete" }));
    const deleteDialog = screen.getByRole("dialog", { name: "Delete Jun?" });
    await user.click(within(deleteDialog).getByRole("button", { name: "Delete person" }));
    expect(mocks.deletePersona).toHaveBeenCalledWith("persona-jun");

    const scrubDialog = await screen.findByRole("dialog", {
      name: "Remove Jun from past transcripts?",
    });
    expect(scrubDialog).toHaveTextContent("2 transcript turns keep the name");
    await user.click(within(scrubDialog).getByRole("button", { name: "Scrub past transcripts" }));
    await waitFor(() =>
      expect(mocks.scrubDeletedPersonaFromNotes).toHaveBeenCalledWith("delete-1"),
    );
    await waitFor(() => expect(callbacks.onSelectPersona).toHaveBeenCalledWith(undefined));
  });

  it("surfaces a failed dossier job with a retry action and restores archived people", async () => {
    mocks.getPersona.mockResolvedValue(
      detail({
        archivedAt: now,
        dossierJobs: [{ id: "job-1", status: "failed", lastError: "Credits unavailable" }],
      }),
    );
    const user = userEvent.setup();
    render(<PeopleWorkspace {...props({ selectedPersonaId: "persona-jun" })} />);

    const notice = await screen.findByText("Credits unavailable");
    await user.click(within(notice.closest("section")!).getByRole("button", { name: "Retry" }));
    expect(mocks.retryPersonaDossierJob).toHaveBeenCalledWith("job-1");

    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(mocks.restorePersona).toHaveBeenCalledWith("persona-jun");
  });
});
