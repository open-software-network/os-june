import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHermesAdminClient,
  useProfileManagerController,
  type ProfileManagerEngine,
  type ProfileManagerState,
} from "../lib/hermes-admin";
import { ProfilesSurfaceView } from "../components/settings/ProfileBuilderSection";
import { makeAdminHarness } from "./fixtures/hermes-admin-harness";

const mocks = vi.hoisted(() => ({
  deleteHermesSession: vi.fn(),
  deleteProfileData: vi.fn(),
  deleteProfileModelOverrides: vi.fn(),
  hermesBridgeStatus: vi.fn(),
  listSessionProfiles: vi.fn(),
  moveProfileDataToDefault: vi.fn(),
  profileModelOverrides: vi.fn(),
  profileDataSummary: vi.fn(),
  setProfileModelOverrides: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  deleteProfileData: mocks.deleteProfileData,
  deleteProfileModelOverrides: mocks.deleteProfileModelOverrides,
  hermesBridgeStatus: mocks.hermesBridgeStatus,
  listSessionProfiles: mocks.listSessionProfiles,
  moveProfileDataToDefault: mocks.moveProfileDataToDefault,
  profileModelOverrides: mocks.profileModelOverrides,
  profileDataSummary: mocks.profileDataSummary,
  setProfileModelOverrides: mocks.setProfileModelOverrides,
}));

vi.mock("../lib/hermes-adapter", () => ({
  deleteHermesSession: mocks.deleteHermesSession,
}));

const EMPTY_SUMMARY = { notes: 0, dictation: 0, folders: 0, sessions: 0, memories: 0 };

function stubManager(overrides: Partial<ProfileManagerState> = {}): ProfileManagerState {
  return {
    status: "ready",
    profiles: [
      { name: "default", description: "June default", raw: {} },
      {
        name: "research",
        description: "Research profile",
        provider: "venice",
        model: "tool-model",
        raw: {},
      },
      { name: "writing", provider: "venice", model: "writer-model", raw: {} },
    ],
    activeName: "research",
    activeConfirmed: true,
    pendingAction: null,
    pendingRemoval: null,
    error: null,
    activate: vi.fn().mockResolvedValue(true),
    beginRemove: vi.fn().mockResolvedValue(true),
    confirmRemoval: vi.fn().mockResolvedValue(true),
    cancelRemoval: vi.fn(),
    refresh: vi.fn(),
    dismissError: vi.fn(),
    ...overrides,
  };
}

function Harness({ engine }: { engine: ProfileManagerEngine }) {
  const managerState = useProfileManagerController(engine);
  return (
    <ProfilesSurfaceView
      managerState={managerState}
      createProfile={async (payload) => {
        await engine.client.profiles.create(payload);
      }}
    />
  );
}

describe("profiles settings surface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.profileDataSummary.mockResolvedValue(EMPTY_SUMMARY);
    mocks.moveProfileDataToDefault.mockResolvedValue(undefined);
    mocks.deleteProfileData.mockResolvedValue(undefined);
    mocks.deleteProfileModelOverrides.mockResolvedValue(undefined);
    mocks.profileModelOverrides.mockResolvedValue(null);
    mocks.listSessionProfiles.mockResolvedValue([]);
    mocks.deleteHermesSession.mockResolvedValue(undefined);
  });

  it("renders profiles with the active badge from activeName", async () => {
    const harness = makeAdminHarness({
      profiles: [
        { name: "default", description: "Base profile" },
        { name: "research", description: "Research profile" },
      ],
      activeProfile: "research",
    });

    render(<Harness engine={harness as ProfileManagerEngine} />);

    await screen.findByText("Research profile");
    const researchRow = screen.getByText("research").closest("li");
    expect(researchRow).not.toBeNull();
    expect(within(researchRow as HTMLElement).getByText("In use")).toBeInTheDocument();
  });

  it("makes a profile active and rerenders the badge", async () => {
    const user = userEvent.setup();
    const harness = makeAdminHarness({
      profiles: [
        { name: "default", active: true },
        { name: "research", active: false },
      ],
      activeProfile: "default",
    });

    render(<Harness engine={harness as ProfileManagerEngine} />);
    await screen.findByText("research");

    const researchRow = screen.getByText("research").closest("li");
    expect(researchRow).not.toBeNull();
    await user.click(within(researchRow as HTMLElement).getByRole("button", { name: "Use" }));

    await waitFor(() => {
      expect(within(researchRow as HTMLElement).getByText("In use")).toBeInTheDocument();
    });
  });

  it("hides guarded delete actions and deletes empty profiles without a dialog", async () => {
    const user = userEvent.setup();
    const beginRemove = vi.fn().mockResolvedValue(true);
    render(
      <ProfilesSurfaceView managerState={stubManager({ beginRemove })} createProfile={vi.fn()} />,
    );

    expect(screen.queryByRole("button", { name: "Delete default" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete research" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete writing" }));
    expect(beginRemove).toHaveBeenCalledWith("writing");
    expect(screen.queryByRole("dialog", { name: 'Delete "writing"?' })).not.toBeInTheDocument();
    expect(mocks.deleteProfileModelOverrides).toHaveBeenCalledWith("writing");
  });

  it("opens a profile data dialog with counts before deleting a data-owning profile", async () => {
    const user = userEvent.setup();
    mocks.profileDataSummary.mockResolvedValue({
      notes: 2,
      dictation: 3,
      folders: 4,
      sessions: 1,
      memories: 5,
    });
    const harness = makeAdminHarness({
      profiles: [
        { name: "default", active: true },
        { name: "writing", active: false },
      ],
      activeProfile: "default",
    });

    render(<Harness engine={harness as ProfileManagerEngine} />);
    await screen.findByText("writing");
    await user.click(screen.getByRole("button", { name: "Delete writing" }));

    const dialog = await screen.findByRole("dialog", { name: 'Delete "writing"?' });
    expect(
      within(dialog).getByText(
        "This profile has 2 notes, 1 session, 3 dictations, 4 projects, 5 memories.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Move to default" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Delete permanently" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(
      harness.server.requestLog.some(
        (entry) => entry.method === "DELETE" && entry.path === "/api/profiles/writing",
      ),
    ).toBe(false);
  });

  it("move to default moves profile data before removing the profile", async () => {
    const user = userEvent.setup();
    mocks.profileDataSummary.mockResolvedValue({
      notes: 1,
      dictation: 0,
      folders: 0,
      sessions: 1,
      memories: 0,
    });
    const harness = makeAdminHarness({
      profiles: [
        { name: "default", active: true },
        { name: "writing", active: false },
      ],
      activeProfile: "default",
    });

    render(<Harness engine={harness as ProfileManagerEngine} />);
    await screen.findByText("writing");
    await user.click(screen.getByRole("button", { name: "Delete writing" }));
    const dialog = await screen.findByRole("dialog", { name: 'Delete "writing"?' });
    await user.click(within(dialog).getByRole("button", { name: "Move to default" }));

    await waitFor(() => expect(mocks.moveProfileDataToDefault).toHaveBeenCalledWith("writing"));
    expect(mocks.deleteProfileData).not.toHaveBeenCalled();
    expect(
      harness.server.requestLog.some(
        (entry) => entry.method === "DELETE" && entry.path === "/api/profiles/writing",
      ),
    ).toBe(true);
    expect(mocks.deleteProfileModelOverrides).toHaveBeenCalledWith("writing");
  });

  it("delete permanently requires a second confirm before deleting profile data", async () => {
    const user = userEvent.setup();
    mocks.profileDataSummary.mockResolvedValue({
      notes: 0,
      dictation: 1,
      folders: 0,
      sessions: 0,
      memories: 0,
    });
    const harness = makeAdminHarness({
      profiles: [
        { name: "default", active: true },
        { name: "writing", active: false },
      ],
      activeProfile: "default",
    });

    render(<Harness engine={harness as ProfileManagerEngine} />);
    await screen.findByText("writing");
    await user.click(screen.getByRole("button", { name: "Delete writing" }));
    const dialog = await screen.findByRole("dialog", { name: 'Delete "writing"?' });

    await user.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
    expect(mocks.deleteProfileData).not.toHaveBeenCalled();
    expect(
      within(dialog).getByText(
        "This can't be undone. Confirm delete to permanently remove this profile's data.",
      ),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Confirm delete" }));

    await waitFor(() => expect(mocks.deleteProfileData).toHaveBeenCalledWith("writing"));
    expect(mocks.moveProfileDataToDefault).not.toHaveBeenCalled();
    expect(
      harness.server.requestLog.some(
        (entry) => entry.method === "DELETE" && entry.path === "/api/profiles/writing",
      ),
    ).toBe(true);
    expect(mocks.deleteProfileModelOverrides).toHaveBeenCalledWith("writing");
  });

  it("cancel closes the data dialog without deleting profile data or profile", async () => {
    const user = userEvent.setup();
    mocks.profileDataSummary.mockResolvedValue({
      notes: 1,
      dictation: 1,
      folders: 1,
      sessions: 1,
      memories: 0,
    });
    const harness = makeAdminHarness({
      profiles: [
        { name: "default", active: true },
        { name: "writing", active: false },
      ],
      activeProfile: "default",
    });

    render(<Harness engine={harness as ProfileManagerEngine} />);
    await screen.findByText("writing");
    await user.click(screen.getByRole("button", { name: "Delete writing" }));
    const dialog = await screen.findByRole("dialog", { name: 'Delete "writing"?' });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: 'Delete "writing"?' })).not.toBeInTheDocument(),
    );
    expect(mocks.moveProfileDataToDefault).not.toHaveBeenCalled();
    expect(mocks.deleteProfileData).not.toHaveBeenCalled();
    expect(
      harness.server.requestLog.some(
        (entry) => entry.method === "DELETE" && entry.path === "/api/profiles/writing",
      ),
    ).toBe(false);
    expect(mocks.deleteProfileModelOverrides).not.toHaveBeenCalled();
  });

  it("creates a new profile from the footer and refreshes the list", async () => {
    const user = userEvent.setup();
    const harness = makeAdminHarness({
      profiles: [{ name: "default", active: true }],
      activeProfile: "default",
    });
    render(<Harness engine={harness as ProfileManagerEngine} />);

    await screen.findByText("default");
    await user.click(screen.getByRole("button", { name: "New profile" }));
    const input = screen.getByLabelText("Profile name");
    expect(input).toHaveValue("Profile 2");
    await user.type(input, "{Enter}");

    await screen.findByText("profile-2");
    const createRequest = harness.server.requestLog.find(
      (entry) => entry.method === "POST" && entry.path === "/api/profiles",
    );
    expect(createRequest?.body).toEqual({ name: "profile-2", clone_from_default: true });
    expect(screen.getByText("default").closest("li")).toHaveTextContent("In use");
  });

  it("bumps the automatic name when Profile 2 already exists", async () => {
    const user = userEvent.setup();
    render(
      <ProfilesSurfaceView
        managerState={stubManager({
          profiles: [
            { name: "default", raw: {} },
            { name: "Profile 2", raw: {} },
          ],
          activeName: "default",
        })}
        createProfile={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "New profile" }));
    expect(screen.getByLabelText("Profile name")).toHaveValue("Profile 3");
  });

  it("copies the active generation model and model overrides without touching data", async () => {
    const user = userEvent.setup();
    const createProfile = vi.fn().mockResolvedValue(undefined);
    const overrides = {
      transcriptionProvider: "venice",
      transcriptionModel: "scribe",
      imageModel: "image-model",
      videoModel: null,
    };
    mocks.profileModelOverrides.mockResolvedValue(overrides);
    render(
      <ProfilesSurfaceView
        managerState={stubManager({
          profiles: [
            { name: "default", raw: {} },
            {
              name: "Client work",
              provider: "venice",
              model: "private-model",
              raw: {},
            },
          ],
          activeName: "Client work",
        })}
        createProfile={createProfile}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Copy current settings" }));
    expect(screen.getByLabelText("Profile name")).toHaveValue("Client work copy");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(createProfile).toHaveBeenCalledWith({
        name: "client-work-copy",
        clone_from_default: true,
        provider: "venice",
        model: "private-model",
      }),
    );
    expect(mocks.profileModelOverrides).toHaveBeenCalledWith("Client work");
    expect(mocks.setProfileModelOverrides).toHaveBeenCalledWith("client-work-copy", overrides);
    expect(mocks.profileDataSummary).not.toHaveBeenCalled();
    expect(mocks.moveProfileDataToDefault).not.toHaveBeenCalled();
    expect(mocks.deleteProfileData).not.toHaveBeenCalled();
  });

  it("skips writing model overrides when the active profile has none", async () => {
    const user = userEvent.setup();
    const createProfile = vi.fn().mockResolvedValue(undefined);
    mocks.profileModelOverrides.mockResolvedValue(null);
    render(<ProfilesSurfaceView managerState={stubManager()} createProfile={createProfile} />);

    await user.click(screen.getByRole("button", { name: "Copy current settings" }));
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(mocks.profileModelOverrides).toHaveBeenCalledWith("research"));
    expect(mocks.setProfileModelOverrides).not.toHaveBeenCalled();
  });

  it("never reads model overrides when copying from the default profile", async () => {
    const user = userEvent.setup();
    const createProfile = vi.fn().mockResolvedValue(undefined);
    render(
      <ProfilesSurfaceView
        managerState={stubManager({ activeName: "default" })}
        createProfile={createProfile}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Copy current settings" }));
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createProfile).toHaveBeenCalled());
    expect(mocks.profileModelOverrides).not.toHaveBeenCalled();
    expect(mocks.setProfileModelOverrides).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("bumps a colliding copy name", async () => {
    const user = userEvent.setup();
    render(
      <ProfilesSurfaceView
        managerState={stubManager({
          profiles: [
            { name: "default", raw: {} },
            { name: "Client work", raw: {} },
            { name: "Client work copy", raw: {} },
          ],
          activeName: "Client work",
        })}
        createProfile={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Copy current settings" }));
    expect(screen.getByLabelText("Profile name")).toHaveValue("Client work copy 2");
  });

  it("keeps a created profile and shows a non-fatal model settings copy error", async () => {
    const user = userEvent.setup();
    const harness = makeAdminHarness({
      profiles: [
        { name: "default", active: false },
        { name: "research", active: true, provider: "venice", model: "tool-model" },
      ],
      activeProfile: "research",
    });
    mocks.profileModelOverrides.mockResolvedValue({ imageModel: "image-model" });
    mocks.setProfileModelOverrides.mockRejectedValue(new Error("disk unavailable"));
    render(<Harness engine={harness as ProfileManagerEngine} />);

    await screen.findByText("research");
    await user.click(screen.getByRole("button", { name: "Copy current settings" }));
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText("research-copy")).toBeInTheDocument();
    expect(
      await screen.findByText(
        'Created "research-copy", but copying model settings failed: disk unavailable',
      ),
    ).toBeInTheDocument();
  });

  it("keeps the delete dialog open with an error when removal fails", async () => {
    const user = userEvent.setup();
    mocks.profileDataSummary.mockResolvedValue({
      notes: 1,
      dictation: 0,
      folders: 0,
      sessions: 0,
      memories: 0,
    });
    const harness = makeAdminHarness({
      profiles: [
        { name: "default", active: true },
        { name: "writing", active: false },
      ],
      activeProfile: "default",
    });
    const deleteAttempts: string[] = [];
    const client = createHermesAdminClient(harness.target, {
      fetch: async (input, init) => {
        const path = new URL(input).pathname;
        if (
          (init?.method ?? "GET").toUpperCase() === "DELETE" &&
          path === "/api/profiles/writing"
        ) {
          deleteAttempts.push(path);
          return new Response(JSON.stringify({ code: "not_found", error: "missing" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }
        return harness.server.fetch(input, init);
      },
    });
    const engine: ProfileManagerEngine = { target: harness.target, client, cache: harness.cache };

    render(<Harness engine={engine} />);

    await screen.findByText("writing");
    await user.click(screen.getByRole("button", { name: "Delete writing" }));
    const dialog = await screen.findByRole("dialog", { name: 'Delete "writing"?' });
    await user.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
    await user.click(within(dialog).getByRole("button", { name: "Confirm delete" }));

    expect(await screen.findByRole("dialog", { name: 'Delete "writing"?' })).toBeInTheDocument();
    expect(
      await within(dialog).findByText("That Hermes resource was not found."),
    ).toBeInTheDocument();
    expect(deleteAttempts).toEqual(["/api/profiles/writing"]);
  });

  it("cancels a stale data dialog when the selected profile disappears", async () => {
    const cancelRemoval = vi.fn();
    const pendingRemoval = {
      name: "writing",
      summary: { notes: 1, dictation: 0, folders: 0, sessions: 0, memories: 0 },
    };
    const { rerender } = render(
      <ProfilesSurfaceView
        managerState={stubManager({ pendingRemoval, cancelRemoval })}
        createProfile={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: 'Delete "writing"?' })).toBeInTheDocument();

    rerender(
      <ProfilesSurfaceView
        managerState={stubManager({
          profiles: [
            { name: "default", description: "June default", raw: {} },
            { name: "research", description: "Research profile", raw: {} },
          ],
          pendingRemoval,
          cancelRemoval,
        })}
        createProfile={vi.fn()}
      />,
    );

    await waitFor(() => expect(cancelRemoval).toHaveBeenCalled());
  });

  it("keeps the Hermes-not-running empty state", () => {
    render(
      <ProfilesSurfaceView
        managerState={stubManager({ status: "unavailable", profiles: [], activeConfirmed: false })}
        createProfile={vi.fn()}
      />,
    );

    expect(screen.getByText("Hermes is not running")).toBeInTheDocument();
  });
});
