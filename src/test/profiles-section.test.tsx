import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
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
  deleteProfileModelOverrides: vi.fn(),
  hermesBridgeStatus: vi.fn(),
  listVeniceModels: vi.fn(),
  providerModelSettings: vi.fn(),
  setProfileModelOverrides: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  deleteProfileModelOverrides: mocks.deleteProfileModelOverrides,
  hermesBridgeStatus: mocks.hermesBridgeStatus,
  listVeniceModels: mocks.listVeniceModels,
  providerModelSettings: mocks.providerModelSettings,
  setProfileModelOverrides: mocks.setProfileModelOverrides,
}));

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
    skills: [],
    mcpServers: [],
    mcpCatalog: [],
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
    error: null,
    activate: vi.fn().mockResolvedValue(true),
    remove: vi.fn().mockResolvedValue(true),
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

  it("disables guarded delete rows and confirms before removal", async () => {
    const user = userEvent.setup();
    const remove = vi.fn().mockResolvedValue(true);
    render(
      <ProfilesSurfaceView managerState={stubManager({ remove })} builderState={stubBuilder()} />,
    );

    expect(screen.getByRole("button", { name: "Delete default" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete research" })).toBeDisabled();
    expect(screen.getByText("The default profile can't be deleted.")).toBeInTheDocument();
    expect(
      screen.getByText("Switch to another profile before deleting this one."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete writing" }));
    expect(screen.getByRole("dialog", { name: 'Delete "writing"?' })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete profile" }));
    expect(remove).toHaveBeenCalledWith("writing");
    expect(mocks.deleteProfileModelOverrides).toHaveBeenCalledWith("writing");
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
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Create and make active" }));

    expect(screen.getByText(/could not make it active: something went wrong/i)).toBeInTheDocument();
    expect(screen.getByText("Profile created")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Profiles" })).not.toBeInTheDocument();
  });

  it("keeps the delete dialog open with an error when removal fails", async () => {
    const user = userEvent.setup();
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
    await user.click(screen.getByRole("button", { name: "Delete profile" }));

    const dialog = screen.getByRole("dialog", { name: 'Delete "writing"?' });
    expect(dialog).toBeInTheDocument();
    expect(
      within(dialog).getByText("Could not delete the profile. Refresh and try again."),
    ).toBeInTheDocument();
    expect(deleteAttempts).toEqual(["/api/profiles/writing"]);
  });

  it("closes a stale delete dialog when the selected profile disappears", async () => {
    const user = userEvent.setup();
    const remove = vi.fn().mockResolvedValue(true);
    const { rerender } = render(
      <ProfilesSurfaceView managerState={stubManager({ remove })} builderState={stubBuilder()} />,
    );

    await user.click(screen.getByRole("button", { name: "Delete writing" }));
    expect(screen.getByRole("dialog", { name: 'Delete "writing"?' })).toBeInTheDocument();

    rerender(
      <ProfilesSurfaceView
        managerState={stubManager({
          profiles: [
            { name: "default", description: "June default", raw: {} },
            { name: "research", description: "Research profile", raw: {} },
          ],
          remove,
        })}
        builderState={stubBuilder()}
      />,
    );

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: 'Delete "writing"?' })).not.toBeInTheDocument(),
    );
    expect(remove).not.toHaveBeenCalled();
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
