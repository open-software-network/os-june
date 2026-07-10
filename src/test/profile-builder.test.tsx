import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROFILE_BUILDER_STEPS,
  ProfileBuilderController,
  buildCreatePayload,
  buildCreatePlan,
  buildProfileModelOverrides,
  canAdvance,
  canCreateProfile,
  emptyProfileForm,
  nextStep,
  previousStep,
  slugifyProfileName,
  validateProfileName,
  validateStep,
  visibleSteps,
  type ProfileBuilderContext,
  type ProfileBuilderEngine,
  type ProfileBuilderForm,
  type ProfileBuilderModel,
  type ProfileBuilderState,
} from "../lib/hermes-admin";
import { ProfileBuilderView } from "../components/settings/ProfileBuilderSection";
import {
  getActiveHermesProfileName,
  resetActiveHermesProfileForTests,
} from "../lib/active-hermes-profile";
import { makeAdminHarness } from "./fixtures/hermes-admin-harness";

const mocks = vi.hoisted(() => ({
  setProfileModelOverrides: vi.fn(),
  deleteProfileModelOverrides: vi.fn(),
  providerModelSettings: vi.fn(),
  listVeniceModels: vi.fn(),
  hermesBridgeStatus: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  setProfileModelOverrides: mocks.setProfileModelOverrides,
  deleteProfileModelOverrides: mocks.deleteProfileModelOverrides,
  providerModelSettings: mocks.providerModelSettings,
  listVeniceModels: mocks.listVeniceModels,
  hermesBridgeStatus: mocks.hermesBridgeStatus,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOOL_MODEL: ProfileBuilderModel = {
  provider: "venice",
  id: "tool-model",
  name: "Tool Model",
  capabilities: ["supportsFunctionCalling", "vision"],
};

const NO_TOOL_MODEL: ProfileBuilderModel = {
  provider: "venice",
  id: "e2ee-model",
  name: "E2EE Model",
  capabilities: ["e2ee"],
};

const VOICE_MODEL = {
  provider: "venice",
  id: "voice-fast",
  name: "Voice Fast",
  modelType: "transcription",
  traits: [],
  capabilities: [],
};

const IMAGE_MODEL = {
  provider: "venice",
  id: "image-private",
  name: "Image Private",
  modelType: "image",
  traits: [],
  capabilities: [],
};

const VIDEO_MODEL = {
  provider: "venice",
  id: "grok-imagine-text-to-video-private",
  name: "Grok Imagine",
  modelType: "video",
  traits: [],
  capabilities: [],
};

const GLOBAL_IMAGE_MODEL = "venice-sd35";
const GLOBAL_VIDEO_MODEL = "wan-2.2-a14b-text-to-video";

function ctx(overrides: Partial<ProfileBuilderContext> = {}): ProfileBuilderContext {
  return {
    existingProfiles: [],
    models: [TOOL_MODEL, NO_TOOL_MODEL],
    ...overrides,
  };
}

function validForm(overrides: Partial<ProfileBuilderForm> = {}): ProfileBuilderForm {
  return {
    ...emptyProfileForm(),
    name: "Research assistant",
    provider: "venice",
    model: "tool-model",
    ...overrides,
  };
}

/** A model loader that resolves to the two test models. */
const loadTestModels = () => Promise.resolve([TOOL_MODEL, NO_TOOL_MODEL]);

/** Builds a profile-builder engine over a fake server. */
function makeBuilderEngine(
  scenario: Parameters<typeof makeAdminHarness>[0] = {},
): ProfileBuilderEngine & {
  server: ReturnType<typeof makeAdminHarness>["server"];
} {
  const harness = makeAdminHarness(scenario);
  return {
    target: harness.target,
    client: harness.client,
    cache: harness.cache,
    lifecycle: harness.lifecycle,
    loadModels: loadTestModels,
    server: harness.server,
  };
}

async function flush(): Promise<void> {
  // Let queued microtasks (the load chain) settle.
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Slug + name validation
// ---------------------------------------------------------------------------

describe("profile builder — slug + name validation", () => {
  it("slugifies a free-text name to a safe slug", () => {
    expect(slugifyProfileName("Research Assistant!")).toBe("research-assistant");
    expect(slugifyProfileName("  My/Agent 2  ")).toBe("my-agent-2");
    expect(slugifyProfileName("***")).toBe("");
  });

  it("rejects empty, reserved, and colliding names", () => {
    expect(validateProfileName("", [])).toMatch(/enter a profile name/i);
    expect(validateProfileName("***", [])).toMatch(/letters or numbers/i);
    expect(validateProfileName("default", [])).toMatch(/reserved/i);
    expect(validateProfileName("Research", [{ name: "research", raw: {} }])).toMatch(
      /already exists/i,
    );
  });

  it("accepts a valid, non-colliding name", () => {
    expect(validateProfileName("Research", [])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Step navigation + validation
// ---------------------------------------------------------------------------

describe("profile builder — wizard state back/next/validation", () => {
  it("steps forward and back within bounds", () => {
    expect(nextStep("identity")).toBe("model");
    expect(nextStep("review")).toBe("review");
    expect(previousStep("model")).toBe("identity");
    expect(previousStep("identity")).toBe("identity");
  });

  it("blocks advancing past identity until the name is valid", () => {
    const blank = emptyProfileForm();
    expect(canAdvance("identity", blank, ctx())).toBe(false);
    const named = validForm();
    expect(canAdvance("identity", named, ctx())).toBe(true);
  });

  it("does not block the optional steps (skills/mcps)", () => {
    const form = validForm();
    expect(canAdvance("skills", form, ctx())).toBe(true);
    expect(canAdvance("mcps", form, ctx())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Model tool-calling gate
// ---------------------------------------------------------------------------

describe("profile builder — model tool-calling gate", () => {
  it("blocks creation when the chosen model cannot call tools", () => {
    const form = validForm({ model: "e2ee-model" });
    const validation = validateStep("model", form, ctx());
    expect(validation.error).toMatch(/does not support tool calling/i);
    expect(canCreateProfile(form, ctx())).toBe(false);
  });

  it("allows creation when the chosen model supports tools", () => {
    const form = validForm();
    expect(validateStep("model", form, ctx()).error).toBeUndefined();
    expect(canCreateProfile(form, ctx())).toBe(true);
  });

  it("requires a model to be chosen at all", () => {
    const form = validForm({ provider: "", model: "" });
    expect(validateStep("model", form, ctx()).error).toMatch(/choose a generation model/i);
  });

  it("re-runs the gating steps from review so a late bad model is caught", () => {
    const form = validForm({ model: "e2ee-model" });
    expect(validateStep("review", form, ctx()).error).toMatch(/does not support tool calling/i);
  });
});

// ---------------------------------------------------------------------------
// Create plan + payload
// ---------------------------------------------------------------------------

describe("profile builder — create plan + payload", () => {
  it("does not include a sandbox policy row in the plan", () => {
    const plan = buildCreatePlan(validForm());
    expect(plan.some((change) => /sandbox|full mode/i.test(change.target))).toBe(false);
    expect(plan.some((change) => /sandbox|full mode/i.test(change.detail))).toBe(false);
  });

  it("builds a ProfileCreate payload with the slug, model, and clone flags", () => {
    const payload = buildCreatePayload(validForm({ hubSkills: ["foo"] }));
    expect(payload.name).toBe("research-assistant");
    expect(payload.provider).toBe("venice");
    expect(payload.model).toBe("tool-model");
    expect(payload.clone_from_default).toBe(true);
    expect(payload.no_skills).toBeUndefined();
    expect(payload.hub_skills).toEqual(["foo"]);
  });

  it("strips June internal MCP servers from the create payload", () => {
    const payload = buildCreatePayload(
      validForm({
        mcpServers: ["linear", "june_context", "github"],
      }),
    );
    expect(payload.mcp_servers).toEqual([{ name: "linear" }, { name: "github" }]);
  });

  it("always clones June's default and never sends no_skills (Hermes forbids the combo)", () => {
    const payload = buildCreatePayload(validForm());
    expect(payload.clone_from_default).toBe(true);
    expect(payload.no_skills).toBeUndefined();
    expect(payload.keep_skills).toBeUndefined();
  });

  it("narrows bundled skills via keep_skills when a subset is chosen", () => {
    const payload = buildCreatePayload(validForm({ keepSkills: ["web-search"] }));
    expect(payload.keep_skills).toEqual(["web-search"]);
    expect(payload.no_skills).toBeUndefined();
  });

  it("does not build profile model overrides for default slots", () => {
    expect(buildProfileModelOverrides(validForm())).toBeNull();
  });

  it("builds profile model overrides only for explicit voice, image, and video picks", () => {
    expect(
      buildProfileModelOverrides(
        validForm({
          voiceProvider: "venice",
          voiceModel: "voice-fast",
          imageModel: "image-private",
          videoModel: "grok-imagine-text-to-video-private",
        }),
      ),
    ).toEqual({
      transcriptionProvider: "venice",
      transcriptionModel: "voice-fast",
      imageModel: "image-private",
      videoModel: "grok-imagine-text-to-video-private",
    });
  });

  it("adds voice, image, and video override rows to the review plan", () => {
    const plan = buildCreatePlan(
      validForm({
        voiceProvider: "venice",
        voiceModel: "voice-fast",
        imageModel: "image-private",
        videoModel: "grok-imagine-text-to-video-private",
      }),
      {
        transcription: [VOICE_MODEL],
        image: [IMAGE_MODEL],
        video: [VIDEO_MODEL],
      },
    );
    expect(plan.some((change) => change.detail === "Voice model: Voice Fast.")).toBe(true);
    expect(plan.some((change) => change.detail === "Image model: Image Private.")).toBe(true);
    expect(plan.some((change) => change.detail === "Video model: Grok Imagine.")).toBe(true);
  });

  it("skips the MCP step when there are no attachable servers", () => {
    expect(visibleSteps(false)).not.toContain("mcps");
    expect(visibleSteps(false)).toEqual(["identity", "model", "skills", "review"]);
    expect(visibleSteps(true)).toContain("mcps");
    expect(visibleSteps(true)).toEqual(PROFILE_BUILDER_STEPS);
    // Navigation skips the hidden MCP step end to end.
    expect(nextStep("skills", visibleSteps(false))).toBe("review");
    expect(previousStep("review", visibleSteps(false))).toBe("skills");
  });

  it("does not list June internal MCP servers in the review count", () => {
    const plan = buildCreatePlan(validForm({ mcpServers: ["linear", "june_context"] }));
    expect(
      plan.some((change) => change.detail === "June's built-in tools are always included."),
    ).toBe(true);
    expect(plan.some((change) => change.detail.startsWith("Attaches 1 MCP server"))).toBe(true);
    expect(plan.some((change) => change.detail.startsWith("Attaches 3 MCP server"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Controller create orchestration: success + failure + rollback
// ---------------------------------------------------------------------------

describe("profile builder — create success/failure + rollback", () => {
  beforeEach(() => {
    mocks.setProfileModelOverrides.mockReset();
    mocks.setProfileModelOverrides.mockResolvedValue(undefined);
    resetActiveHermesProfileForTests();
    mocks.providerModelSettings.mockResolvedValue({
      settings: {
        transcriptionProvider: "venice",
        transcriptionModel: "global-voice",
        imageModel: GLOBAL_IMAGE_MODEL,
        videoModel: GLOBAL_VIDEO_MODEL,
      },
      effectiveSettings: {
        transcriptionProvider: "venice",
        transcriptionModel: "active-profile-voice",
        imageModel: "active-profile-image",
        videoModel: "grok-imagine-text-to-video-private",
      },
    });
    mocks.listVeniceModels.mockImplementation(async (mode) => ({
      mode,
      modelType: mode === "transcription" ? "transcription" : "image",
      selectedModel: mode === "transcription" ? "global-voice" : GLOBAL_IMAGE_MODEL,
      models: mode === "transcription" ? [VOICE_MODEL] : [],
    }));
  });

  it("creates a profile, makes it active, and feeds the app store", async () => {
    const engine = makeBuilderEngine();
    const controller = new ProfileBuilderController(engine);
    await controller.load();
    await flush();

    controller.update(validForm());
    await controller.createProfile({ makeActive: true });

    const snapshot = controller.getSnapshot();
    expect(snapshot.create.phase).toBe("created");
    expect(snapshot.create.createdSlug).toBe("research-assistant");
    expect(snapshot.create.activated).toBe(true);
    expect(snapshot.create.message).toBe('Created "research-assistant".');

    // The profile exists and is now the sticky active profile.
    const profiles = await engine.client.profiles.list();
    expect(profiles.some((p) => p.name === "research-assistant")).toBe(true);
    expect(await engine.client.profiles.active()).toMatchObject({ active: "research-assistant" });
    expect(getActiveHermesProfileName()).toBe("research-assistant");

    controller.dispose();
    resetActiveHermesProfileForTests();
  });

  it("keeps the profile and reports partial success when activation fails", async () => {
    const engine = makeBuilderEngine({
      profileActivateNotOk: true,
    });
    const controller = new ProfileBuilderController(engine);
    await controller.load();
    await flush();

    controller.update(validForm());
    await controller.createProfile({ makeActive: true });

    const snapshot = controller.getSnapshot();
    expect(snapshot.create.phase).toBe("created");
    expect(snapshot.create.createdSlug).toBe("research-assistant");
    expect(snapshot.create.activated).toBe(false);
    expect(snapshot.create.message).toMatch(
      /Created "research-assistant"\. Could not make it active:/,
    );
    expect(getActiveHermesProfileName()).toBe("default");

    const profiles = await engine.client.profiles.list();
    expect(profiles.some((p) => p.name === "research-assistant")).toBe(true);

    controller.dispose();
  });

  it("reports a clean failure when create itself fails (nothing was made)", async () => {
    const engine = makeBuilderEngine({
      profileCreateError: { status: 500, error: "boom" },
    });
    const controller = new ProfileBuilderController(engine);
    await controller.load();
    await flush();

    controller.update(validForm());
    await controller.createProfile();

    const snapshot = controller.getSnapshot();
    expect(snapshot.create.phase).toBe("failed");
    expect(snapshot.create.error).toMatch(/no changes were made/i);

    controller.dispose();
  });

  it("blocks create entirely when the model lacks tool calling", async () => {
    const engine = makeBuilderEngine();
    const controller = new ProfileBuilderController(engine);
    await controller.load();
    await flush();

    controller.update(validForm({ model: "e2ee-model" }));
    await controller.createProfile();

    const snapshot = controller.getSnapshot();
    expect(snapshot.create.phase).toBe("failed");
    // No create request was sent to the server.
    const createCall = engine.server.requestLog.find(
      (entry) => entry.method === "POST" && entry.path === "/api/profiles",
    );
    expect(createCall).toBeUndefined();

    controller.dispose();
  });

  it("dedupes the new name against existing profiles loaded from the server", async () => {
    const engine = makeBuilderEngine({
      profiles: [{ name: "research", active: true }],
    });
    const controller = new ProfileBuilderController(engine);
    await controller.load();
    await flush();

    const snapshot = controller.getSnapshot();
    expect(validateProfileName("Research", snapshot.existingProfiles)).toMatch(/already exists/i);

    controller.dispose();
  });

  it("writes explicit model overrides after the profile is created", async () => {
    const engine = makeBuilderEngine();
    const controller = new ProfileBuilderController(engine);
    await controller.load();
    await flush();

    controller.update(
      validForm({
        voiceProvider: "venice",
        voiceModel: "voice-fast",
        imageModel: "image-private",
        videoModel: "grok-imagine-text-to-video-private",
      }),
    );
    await controller.createProfile();

    expect(mocks.setProfileModelOverrides).toHaveBeenCalledWith("research-assistant", {
      transcriptionProvider: "venice",
      transcriptionModel: "voice-fast",
      imageModel: "image-private",
      videoModel: "grok-imagine-text-to-video-private",
    });

    controller.dispose();
  });

  it("loads image and video choices from the frontend catalogs", async () => {
    const engine = makeBuilderEngine();
    const controller = new ProfileBuilderController(engine);
    await controller.load();
    await flush();

    controller.setStep("model");
    await flush();

    const snapshot = controller.getSnapshot();
    expect(snapshot.imageModels.length).toBeGreaterThan(0);
    expect(snapshot.imageModels.some((model) => model.id === GLOBAL_IMAGE_MODEL)).toBe(true);
    expect(snapshot.videoModels.length).toBeGreaterThan(0);
    expect(snapshot.videoModels.some((model) => model.id === GLOBAL_VIDEO_MODEL)).toBe(true);

    controller.dispose();
  });

  it("uses global model settings for June's default placeholders", async () => {
    const engine = makeBuilderEngine();
    const controller = new ProfileBuilderController(engine);
    await controller.load();
    await flush();

    controller.setStep("model");
    await flush();

    expect(controller.getSnapshot().effectiveModelSettings).toMatchObject({
      transcriptionModel: "global-voice",
      imageModel: GLOBAL_IMAGE_MODEL,
      videoModel: GLOBAL_VIDEO_MODEL,
    });

    controller.dispose();
  });

  it("keeps the profile and reports partial success when override save fails", async () => {
    mocks.setProfileModelOverrides.mockRejectedValueOnce(new Error("disk full"));
    const engine = makeBuilderEngine();
    const controller = new ProfileBuilderController(engine);
    await controller.load();
    await flush();

    controller.update(validForm({ imageModel: "image-private" }));
    await controller.createProfile();

    const snapshot = controller.getSnapshot();
    expect(snapshot.create.phase).toBe("created");
    expect(snapshot.create.createdSlug).toBe("research-assistant");
    expect(snapshot.create.message).toMatch(/model overrides were not saved/i);

    const profiles = await engine.client.profiles.list();
    expect(profiles.some((p) => p.name === "research-assistant")).toBe(true);

    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// View rendering (render-only, stubbed state)
// ---------------------------------------------------------------------------

function stubState(overrides: Partial<ProfileBuilderState> = {}): ProfileBuilderState {
  return {
    status: "ready",
    mode: "sandboxed",
    profile: "default",
    retryable: false,
    step: "model",
    form: validForm({ model: "e2ee-model" }),
    existingProfiles: [],
    models: [TOOL_MODEL, NO_TOOL_MODEL],
    voiceModels: [VOICE_MODEL],
    imageModels: [IMAGE_MODEL],
    videoModels: [VIDEO_MODEL],
    effectiveModelSettings: {
      transcriptionProvider: "venice",
      transcriptionModel: "voice-fast",
      imageModel: "image-private",
      videoModel: "grok-imagine-text-to-video-private",
    },
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

describe("profile builder — view", () => {
  it("renders basics without a radio group", () => {
    render(<ProfileBuilderView state={stubState({ step: "identity", form: validForm() })} />);
    expect(screen.getByLabelText("Profile name")).toBeInTheDocument();
    expect(screen.getByLabelText("Description")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("surfaces the tool-calling block on the model step", () => {
    render(<ProfileBuilderView state={stubState()} />);
    expect(screen.getByText(/does not support tool calling/i)).toBeInTheDocument();
  });

  it("shows the per-profile video model slot", () => {
    render(
      <ProfileBuilderView state={stubState({ form: validForm({ videoModel: VIDEO_MODEL.id }) })} />,
    );
    expect(screen.getByRole("button", { name: "Change video model" })).toHaveTextContent(
      "Grok Imagine",
    );
  });

  it("shows the created panel with the slug after a successful create", () => {
    render(
      <ProfileBuilderView
        state={stubState({
          create: {
            phase: "created",
            createdSlug: "research-assistant",
            activated: true,
            message: 'Created "research-assistant".',
          },
        })}
      />,
    );
    expect(screen.getByText("Profile created")).toBeInTheDocument();
    expect(screen.getByText(/it is now active for new sessions/i)).toBeInTheDocument();
  });

  it("hides June internal MCP servers in the MCP step", () => {
    render(
      <ProfileBuilderView
        state={stubState({
          step: "mcps",
          form: validForm(),
          mcpServers: [
            { name: "june_context", enabled: true, transport: "http", auth: "unknown", raw: {} },
            { name: "linear", enabled: true, transport: "http", auth: "unknown", raw: {} },
          ],
        })}
      />,
    );
    expect(screen.getByText("linear")).toBeInTheDocument();
    expect(screen.queryByText("june_context")).not.toBeInTheDocument();
    expect(screen.getByText("June's built-in tools are always included.")).toBeInTheDocument();
  });

  it("renders the empty state when Hermes is not running", () => {
    render(<ProfileBuilderView state={stubState({ status: "unavailable" })} />);
    expect(screen.getByText("Hermes is not running")).toBeInTheDocument();
  });
});
