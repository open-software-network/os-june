import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  emptyProfileForm,
  useProfileManagerController,
  type ProfileBuilderState,
  type ProfileManagerEngine,
  type ProfileManagerState,
} from "../lib/hermes-admin";
import { ProfilesSurfaceView } from "../components/settings/ProfileBuilderSection";
import { makeAdminHarness } from "./fixtures/hermes-admin-harness";

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

describe("profiles settings surface", () => {
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
  });

  it("opens the wizard from New profile and returns to the refreshed list after create", async () => {
    const user = userEvent.setup();
    const managerState = stubManager();
    const builderState = stubBuilder();
    const { rerender } = render(
      <ProfilesSurfaceView managerState={managerState} builderState={builderState} />,
    );

    await user.click(screen.getByRole("button", { name: "New profile" }));
    expect(screen.getByLabelText("Profile name")).toBeInTheDocument();

    rerender(
      <ProfilesSurfaceView
        managerState={managerState}
        builderState={stubBuilder({ create: { phase: "created", createdSlug: "research" } })}
      />,
    );

    await waitFor(() => expect(managerState.refresh).toHaveBeenCalled());
    expect(screen.getByRole("list", { name: "Profiles" })).toBeInTheDocument();
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
