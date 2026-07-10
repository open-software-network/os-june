import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROFILE_BUILDER_STEPS,
  createHermesAdminClient,
  emptyProfileForm,
  nextStep,
  useProfileManagerController,
  type ProfileBuilderModel,
  type ProfileBuilderState,
  type ProfileBuilderStep,
  type ProfileManagerEngine,
  type ProfileManagerState,
} from "../lib/hermes-admin";
import { ProfilesSurfaceView } from "../components/settings/ProfileBuilderSection";
import { makeAdminHarness } from "./fixtures/hermes-admin-harness";

const mocks = vi.hoisted(() => ({
  deleteProfileData: vi.fn(),
  deleteProfileModelOverrides: vi.fn(),
  hermesBridgeStatus: vi.fn(),
  listVeniceModels: vi.fn(),
  moveProfileDataToDefault: vi.fn(),
  profileDataSummary: vi.fn(),
  providerModelSettings: vi.fn(),
  setProfileModelOverrides: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  deleteProfileData: mocks.deleteProfileData,
  deleteProfileModelOverrides: mocks.deleteProfileModelOverrides,
  hermesBridgeStatus: mocks.hermesBridgeStatus,
  listVeniceModels: mocks.listVeniceModels,
  moveProfileDataToDefault: mocks.moveProfileDataToDefault,
  profileDataSummary: mocks.profileDataSummary,
  providerModelSettings: mocks.providerModelSettings,
  setProfileModelOverrides: mocks.setProfileModelOverrides,
}));

const EMPTY_SUMMARY = { notes: 0, dictation: 0, folders: 0, sessions: 0 };

function stubBuilder(overrides: Partial<ProfileBuilderState> = {}): ProfileBuilderState {
  return {
    status: "ready",
    mode: "sandboxed",
    profile: "default",
    retryable: false,
    step: "identity",
    form: emptyProfileForm(),
    existingProfiles: [],
    models: [],
    voiceModels: [],
    imageModels: [],
    videoModels: [],
    skills: [],
    mcpServers: [],
    steps: PROFILE_BUILDER_STEPS,
    inputsLoading: false,
    create: { phase: "idle" },
    lifecycle: {
      state: "clean",
      label: "Up to date",
      detail: "No pending changes.",
      canRestart: false,
    },
    notifications: [],
    setStep: vi.fn(),
    goNext: vi.fn(),
    goBack: vi.fn(),
    update: vi.fn(),
    reset: vi.fn(),
    refresh: vi.fn(),
    createProfile: vi.fn(),
    dismissNotification: vi.fn(),
    ...overrides,
  };
}

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
  return <ProfilesSurfaceView managerState={managerState} builderState={stubBuilder()} />;
}

const TOOL_MODEL: ProfileBuilderModel = {
  provider: "venice",
  id: "tool-model",
  name: "Tool Model",
  capabilities: ["supportsFunctionCalling"],
};

function StatefulBuilderHarness() {
  const [step, setStep] = useState<ProfileBuilderStep>("identity");
  const [form, setForm] = useState(() => ({
    ...emptyProfileForm(),
    provider: "venice",
    model: "tool-model",
  }));
  const [create, setCreate] = useState<ProfileBuilderState["create"]>({ phase: "idle" });

  const builderState = useMemo(
    () =>
      stubBuilder({
        step,
        form,
        models: [TOOL_MODEL],
        create,
        setStep,
        goNext: () => setStep((current) => nextStep(current)),
        update: (patch) => setForm((current) => ({ ...current, ...patch })),
        reset: () => {
          setStep("identity");
          setForm({ ...emptyProfileForm(), provider: "venice", model: "tool-model" });
          setCreate({ phase: "idle" });
        },
        createProfile: () => {
          setCreate({
            phase: "created",
            createdSlug: "research-assistant",
            activated: false,
            message:
              'Created "research-assistant". Could not make it active: Something went wrong.',
          });
        },
      }),
    [create, form, step],
  );

  return <ProfilesSurfaceView managerState={stubManager()} builderState={builderState} />;
}

describe("profiles settings surface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.profileDataSummary.mockResolvedValue(EMPTY_SUMMARY);
    mocks.moveProfileDataToDefault.mockResolvedValue(undefined);
    mocks.deleteProfileData.mockResolvedValue(undefined);
    mocks.deleteProfileModelOverrides.mockResolvedValue(undefined);
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
    expect(within(researchRow as HTMLElement).getByText("Active")).toBeInTheDocument();
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
    await user.click(
      within(researchRow as HTMLElement).getByRole("button", { name: "Make active" }),
    );

    await waitFor(() => {
      expect(within(researchRow as HTMLElement).getByText("Active")).toBeInTheDocument();
    });
  });

  it("disables guarded delete rows and deletes empty profiles without a dialog", async () => {
    const user = userEvent.setup();
    const beginRemove = vi.fn().mockResolvedValue(true);
    render(
      <ProfilesSurfaceView
        managerState={stubManager({ beginRemove })}
        builderState={stubBuilder()}
      />,
    );

    expect(screen.getByRole("button", { name: "Delete default" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete research" })).toBeDisabled();
    expect(screen.getByText("The default profile can't be deleted.")).toBeInTheDocument();
    expect(
      screen.getByText("Switch to another profile before deleting this one."),
    ).toBeInTheDocument();

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
      within(dialog).getByText("This profile has 2 notes, 1 chat, 3 dictations, 4 projects."),
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

  it("opens the wizard from New profile and returns to the refreshed list after clean create", async () => {
    const user = userEvent.setup();
    const managerState = stubManager({
      profiles: [
        { name: "default", description: "June default", raw: {} },
        { name: "research-assistant", description: "Research assistant", raw: {} },
      ],
      activeName: "research-assistant",
    });
    const builderState = stubBuilder();
    const { rerender } = render(
      <ProfilesSurfaceView managerState={managerState} builderState={builderState} />,
    );

    await user.click(screen.getByRole("button", { name: "New profile" }));
    expect(screen.getByLabelText("Profile name")).toBeInTheDocument();

    rerender(
      <ProfilesSurfaceView
        managerState={managerState}
        builderState={stubBuilder({
          create: {
            phase: "created",
            createdSlug: "research-assistant",
            activated: true,
            message: 'Created "research-assistant".',
          },
        })}
      />,
    );

    await waitFor(() => expect(managerState.refresh).toHaveBeenCalled());
    expect(screen.getByRole("list", { name: "Profiles" })).toBeInTheDocument();
    const createdRow = screen.getByText("research-assistant").closest("li");
    expect(createdRow).not.toBeNull();
    expect(within(createdRow as HTMLElement).getByText("Active")).toBeInTheDocument();
  });

  it("stays on the created panel when a profile is created but activation fails", async () => {
    const user = userEvent.setup();
    render(<StatefulBuilderHarness />);

    await user.click(screen.getByRole("button", { name: "New profile" }));
    await user.type(screen.getByLabelText("Profile name"), "Research assistant");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Create and make active" }));

    expect(screen.getByText(/could not make it active: something went wrong/i)).toBeInTheDocument();
    expect(screen.getByText("Profile created")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Profiles" })).not.toBeInTheDocument();
  });

  it("keeps the delete dialog open with an error when removal fails", async () => {
    const user = userEvent.setup();
    mocks.profileDataSummary.mockResolvedValue({
      notes: 1,
      dictation: 0,
      folders: 0,
      sessions: 0,
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
      summary: { notes: 1, dictation: 0, folders: 0, sessions: 0 },
    };
    const { rerender } = render(
      <ProfilesSurfaceView
        managerState={stubManager({ pendingRemoval, cancelRemoval })}
        builderState={stubBuilder()}
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
        builderState={stubBuilder()}
      />,
    );

    await waitFor(() => expect(cancelRemoval).toHaveBeenCalled());
  });

  it("keeps the Hermes-not-running empty state", () => {
    render(
      <ProfilesSurfaceView
        managerState={stubManager({ status: "unavailable", profiles: [], activeConfirmed: false })}
        builderState={stubBuilder({ status: "unavailable" })}
      />,
    );

    expect(screen.getByText("Hermes is not running")).toBeInTheDocument();
  });
});
