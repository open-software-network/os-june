import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ProfileBuilderController,
  buildCreatePayload,
  buildCreatePlan,
  canAdvance,
  canCreateProfile,
  emptyProfileForm,
  nextStep,
  previousStep,
  slugifyProfileName,
  validateProfileName,
  validateStep,
  type ProfileBuilderContext,
  type ProfileBuilderEngine,
  type ProfileBuilderForm,
  type ProfileBuilderModel,
  type ProfileBuilderState,
} from "../lib/hermes-admin";
import { ProfileBuilderView } from "../components/settings/ProfileBuilderSection";
import { makeAdminHarness } from "./fixtures/hermes-admin-harness";

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

function ctx(
  overrides: Partial<ProfileBuilderContext> = {},
): ProfileBuilderContext {
  return {
    existingProfiles: [],
    models: [TOOL_MODEL, NO_TOOL_MODEL],
    ...overrides,
  };
}

function validForm(
  overrides: Partial<ProfileBuilderForm> = {},
): ProfileBuilderForm {
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
    expect(slugifyProfileName("Research Assistant!")).toBe(
      "research-assistant",
    );
    expect(slugifyProfileName("  My/Agent 2  ")).toBe("my-agent-2");
    expect(slugifyProfileName("***")).toBe("");
  });

  it("rejects empty, reserved, and colliding names", () => {
    expect(validateProfileName("", [])).toMatch(/enter a profile name/i);
    expect(validateProfileName("***", [])).toMatch(/letters or numbers/i);
    expect(validateProfileName("default", [])).toMatch(/reserved/i);
    expect(
      validateProfileName("Research", [{ name: "research", raw: {} }]),
    ).toMatch(/already exists/i);
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

  it("does not block the optional steps (toolsets/skills/mcps)", () => {
    const form = validForm();
    expect(canAdvance("toolsets", form, ctx())).toBe(true);
    expect(canAdvance("skills", form, ctx())).toBe(true);
    expect(canAdvance("mcps", form, ctx())).toBe(true);
  });

  it("warns (does not block) on Full mode and missing specialized SOUL", () => {
    const full = validForm({ sandbox: "unrestricted" });
    const fullValidation = validateStep("toolsets", full, ctx());
    expect(fullValidation.error).toBeUndefined();
    expect(fullValidation.warnings.length).toBeGreaterThan(0);

    const specialized = validForm({ identity: "specialized", soul: "" });
    const idValidation = validateStep("identity", specialized, ctx());
    expect(idValidation.error).toBeUndefined();
    expect(idValidation.warnings.join(" ")).toMatch(/still behaves like June/i);
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
    expect(validateStep("model", form, ctx()).error).toMatch(
      /choose a generation model/i,
    );
  });

  it("re-runs the gating steps from review so a late bad model is caught", () => {
    const form = validForm({ model: "e2ee-model" });
    expect(validateStep("review", form, ctx()).error).toMatch(
      /does not support tool calling/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Create plan + payload
// ---------------------------------------------------------------------------

describe("profile builder — create plan + payload", () => {
  it("labels Full mode as a high-risk change in the plan", () => {
    const plan = buildCreatePlan(validForm({ sandbox: "unrestricted" }));
    const danger = plan.find((change) => change.risk === "danger");
    expect(danger).toBeDefined();
    expect(danger?.detail).toMatch(/full mode/i);
  });

  it("includes a SOUL change only when a SOUL was written", () => {
    const without = buildCreatePlan(validForm());
    expect(without.some((c) => c.target.endsWith("SOUL.md"))).toBe(false);
    const withSoul = buildCreatePlan(validForm({ soul: "Be terse." }));
    expect(withSoul.some((c) => c.target.endsWith("SOUL.md"))).toBe(true);
  });

  it("builds a ProfileCreate payload with the slug, model, and clone flags", () => {
    const payload = buildCreatePayload(
      validForm({ keepBundledSkills: true, hubSkills: ["foo"] }),
    );
    expect(payload.name).toBe("research-assistant");
    expect(payload.provider).toBe("venice");
    expect(payload.model).toBe("tool-model");
    expect(payload.clone_from_default).toBe(true);
    expect(payload.no_skills).toBe(false);
    expect(payload.hub_skills).toEqual(["foo"]);
  });

  it("sets no_skills when bundled skills are dropped", () => {
    const payload = buildCreatePayload(validForm({ keepBundledSkills: false }));
    expect(payload.no_skills).toBe(true);
    expect(payload.clone_from_default).toBe(false);
  });

  it("does NOT put the SOUL in the create body (it is written separately)", () => {
    const payload = buildCreatePayload(validForm({ soul: "Be terse." }));
    expect(payload).not.toHaveProperty("soul");
    expect(payload).not.toHaveProperty("content");
  });
});

// ---------------------------------------------------------------------------
// Controller create orchestration: success + failure + rollback
// ---------------------------------------------------------------------------

describe("profile builder — create success/failure + rollback", () => {
  it("creates a profile, writes its SOUL, and starts a test session", async () => {
    const engine = makeBuilderEngine();
    const controller = new ProfileBuilderController(engine);
    await controller.load();
    await flush();

    controller.update(validForm({ soul: "Be terse." }));
    await controller.createProfile({ startTestSession: true });

    const snapshot = controller.getSnapshot();
    expect(snapshot.create.phase).toBe("created");
    expect(snapshot.create.createdSlug).toBe("research-assistant");
    expect(snapshot.create.testSessionStarted).toBe(true);

    // The profile and a session now exist on the server.
    const profiles = await engine.client.profiles.list();
    expect(profiles.some((p) => p.name === "research-assistant")).toBe(true);
    const sessions = await engine.client.profiles.sessions();
    expect(sessions.some((s) => s.profile === "research-assistant")).toBe(true);

    // The SOUL was written via a separate PUT, not the create body.
    const soulPut = engine.server.requestLog.find(
      (entry) =>
        entry.method === "PUT" &&
        entry.path === "/api/profiles/research-assistant/soul",
    );
    expect(soulPut?.body).toMatchObject({ content: "Be terse." });

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

  it("reports a post-create failure when the SOUL write fails after create", async () => {
    const engine = makeBuilderEngine({
      profileSoulError: { status: 500, error: "soul boom" },
    });
    const controller = new ProfileBuilderController(engine);
    await controller.load();
    await flush();

    controller.update(validForm({ soul: "Be terse." }));
    await controller.createProfile();

    const snapshot = controller.getSnapshot();
    expect(snapshot.create.phase).toBe("failed");
    expect(snapshot.create.createdSlug).toBe("research-assistant");
    // The message must NOT imply a clean rollback — the profile WAS created.
    expect(snapshot.create.error).toMatch(/created the profile/i);
    expect(snapshot.create.error).toMatch(/from the profile's settings/i);

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
    expect(validateProfileName("Research", snapshot.existingProfiles)).toMatch(
      /already exists/i,
    );

    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// View rendering (render-only, stubbed state)
// ---------------------------------------------------------------------------

function stubState(
  overrides: Partial<ProfileBuilderState> = {},
): ProfileBuilderState {
  return {
    status: "ready",
    mode: "sandboxed",
    profile: "default",
    retryable: false,
    step: "model",
    form: validForm({ model: "e2ee-model" }),
    existingProfiles: [],
    models: [TOOL_MODEL, NO_TOOL_MODEL],
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

describe("profile builder — view", () => {
  it("surfaces the tool-calling block on the model step", () => {
    render(<ProfileBuilderView state={stubState()} />);
    expect(
      screen.getByText(/does not support tool calling/i),
    ).toBeInTheDocument();
  });

  it("shows the created panel with the slug after a successful create", () => {
    render(
      <ProfileBuilderView
        state={stubState({
          create: {
            phase: "created",
            createdSlug: "research-assistant",
            testSessionStarted: true,
            message: 'Created "research-assistant".',
          },
        })}
      />,
    );
    expect(screen.getByText("Profile created")).toBeInTheDocument();
    expect(
      screen.getByText(/a test session is running under it/i),
    ).toBeInTheDocument();
  });

  it("renders the empty state when Hermes is not running", () => {
    render(<ProfileBuilderView state={stubState({ status: "unavailable" })} />);
    expect(screen.getByText("Hermes is not running")).toBeInTheDocument();
  });
});
