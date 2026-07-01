import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  buildSkillSetupModel,
  envConfiguredIndex,
  parseConfigResult,
  parseConfigWriteResult,
  parseSkillSetupRequirements,
  readConfigPath,
  setupBadge,
  skillConfigPath,
  skillConfigPathSegments,
  SkillSetupController,
  validateConfigValue,
  type HermesSkillSetupRequirements,
  type SkillSetupEngine,
  type SkillSetupState,
} from "../lib/hermes-admin";
import { SkillSetupView } from "../components/settings/SkillSetupSection";
import { makeAdminHarness } from "./fixtures/hermes-admin-harness";
import {
  FAKE_SECRET,
  skillSetupScenario,
} from "./fixtures/hermes-admin-scenarios";

/** Builds a setup engine from a harness (its shape matches SkillSetupEngine). */
function engineFromHarness(scenario = skillSetupScenario()): {
  engine: SkillSetupEngine;
  logs: Array<Record<string, unknown>>;
} {
  const harness = makeAdminHarness(scenario);
  const { server: _server, target, client, cache, lifecycle, logs } = harness;
  return { engine: { target, client, cache, lifecycle }, logs };
}

// ---------------------------------------------------------------------------
// Requirement parsing (no render, no network).
// ---------------------------------------------------------------------------

describe("skill setup — requirement parsing", () => {
  it("parses required_environment_variables (bare names and objects)", () => {
    const req = parseSkillSetupRequirements({
      required_environment_variables: [
        "PLAIN_KEY",
        {
          name: "OPENAI_API_KEY",
          prompt: "OpenAI API key",
          help: "Used for model calls.",
          required_for: "model calls",
          required: true,
        },
        { name: "OPTIONAL_KEY", optional: true },
      ],
    });
    expect(req.env.map((e) => e.name)).toEqual([
      "PLAIN_KEY",
      "OPENAI_API_KEY",
      "OPTIONAL_KEY",
    ]);
    expect(req.env[0].required).toBe(true); // bare name defaults to required
    expect(req.env[1].prompt).toBe("OpenAI API key");
    expect(req.env[1].requiredFor).toBe("model calls");
    expect(req.env[2].required).toBe(false); // optional: true -> not required
  });

  it("parses metadata.hermes.config (array and key->meta map)", () => {
    const arrayForm = parseSkillSetupRequirements({
      metadata: {
        hermes: {
          config: [
            {
              key: "output_dir",
              prompt: "Output directory",
              default: "~/exports",
              required: true,
            },
          ],
        },
      },
    });
    expect(arrayForm.config[0]).toMatchObject({
      key: "output_dir",
      prompt: "Output directory",
      default: "~/exports",
      required: true,
    });

    const mapForm = parseSkillSetupRequirements({
      metadata: { hermes: { config: { format: "md" } } },
    });
    expect(mapForm.config[0]).toMatchObject({
      key: "format",
      default: "md",
      required: false, // config is optional unless said otherwise
    });
  });

  it("returns empty lists when nothing is declared", () => {
    expect(parseSkillSetupRequirements({ name: "x" })).toEqual({
      env: [],
      config: [],
    });
    expect(parseSkillSetupRequirements(null)).toEqual({ env: [], config: [] });
  });
});

// ---------------------------------------------------------------------------
// Badge logic (precedence) and config path.
// ---------------------------------------------------------------------------

describe("skill setup — badge + model", () => {
  const requirements: HermesSkillSetupRequirements = {
    env: [
      { name: "REQUIRED_KEY", required: true },
      { name: "OPTIONAL_KEY", required: false },
    ],
    config: [
      { key: "required_cfg", required: true },
      { key: "optional_cfg", required: false },
    ],
  };

  it("missing required secret -> missing API key", () => {
    const model = buildSkillSetupModel(
      requirements,
      new Map([["OPTIONAL_KEY", { configured: true }]]),
      new Map([
        ["required_cfg", "x"],
        ["optional_cfg", "y"],
      ]),
    );
    expect(model.badge.status).toBe("missing-api-key");
    expect(model.badge.label).toBe("Missing API key");
  });

  it("required secret set, required config unset -> missing config", () => {
    const model = buildSkillSetupModel(
      requirements,
      new Map([
        ["REQUIRED_KEY", { configured: true }],
        ["OPTIONAL_KEY", { configured: true }],
      ]),
      new Map([["optional_cfg", "y"]]),
    );
    expect(model.badge.status).toBe("missing-config");
  });

  it("only optional remains -> optional setup skipped", () => {
    const model = buildSkillSetupModel(
      requirements,
      new Map([["REQUIRED_KEY", { configured: true }]]),
      new Map([["required_cfg", "x"]]),
    );
    expect(model.badge.status).toBe("optional-skipped");
  });

  it("everything required satisfied -> ready", () => {
    const model = buildSkillSetupModel(
      requirements,
      new Map([
        ["REQUIRED_KEY", { configured: true }],
        ["OPTIONAL_KEY", { configured: true }],
      ]),
      new Map([
        ["required_cfg", "x"],
        ["optional_cfg", "y"],
      ]),
    );
    expect(model.badge.status).toBe("ready");
  });

  it("badge copy uses sentence case and no dashes", () => {
    for (const status of [
      "ready",
      "missing-api-key",
      "missing-config",
      "optional-skipped",
    ] as const) {
      expect(setupBadge(status).label).not.toMatch(/[–—]/);
    }
  });

  it("encodes the skills.config dotted path consistently", () => {
    expect(skillConfigPath("research", "model")).toBe(
      "skills.config.research.model",
    );
    expect(skillConfigPathSegments("research", "model")).toEqual([
      "skills",
      "config",
      "research",
      "model",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Secret safety in the model: a credential-shaped config value is masked.
// ---------------------------------------------------------------------------

describe("skill setup — secret safety in display", () => {
  it("masks a credential-shaped config value before display", () => {
    const model = buildSkillSetupModel(
      { env: [], config: [{ key: "token_field", required: false }] },
      new Map(),
      // A user pasted a long opaque token into a 'config' field by mistake.
      new Map([["token_field", FAKE_SECRET]]),
    );
    expect(model.config[0].current).toBe("[redacted]");
    // Flagged redacted so the editor never seeds its draft from the placeholder.
    expect(model.config[0].redacted).toBe(true);
  });

  it("shows a normal config value (a path) verbatim", () => {
    const model = buildSkillSetupModel(
      { env: [], config: [{ key: "output_dir", required: false }] },
      new Map(),
      new Map([["output_dir", "~/exports"]]),
    );
    expect(model.config[0].current).toBe("~/exports");
    expect(model.config[0].redacted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Config validation.
// ---------------------------------------------------------------------------

describe("skill setup — config validation", () => {
  it("rejects a blank required value", () => {
    const result = validateConfigValue({ key: "x", required: true }, "  ");
    expect(result.ok).toBe(false);
  });

  it("accepts a blank optional value", () => {
    expect(validateConfigValue({ key: "x", required: false }, "").ok).toBe(
      true,
    );
  });

  it("rejects a path value with line breaks", () => {
    const result = validateConfigValue(
      { key: "output_dir", required: false },
      "~/a\n~/b",
    );
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Config endpoint parsers.
// ---------------------------------------------------------------------------

describe("skill setup — config endpoint parsing", () => {
  it("reads a dotted path out of the config tree", () => {
    const { config } = parseConfigResult({
      config: { skills: { config: { exporter: { output_dir: "~/notes" } } } },
    });
    expect(
      readConfigPath(config, ["skills", "config", "exporter", "output_dir"]),
    ).toBe("~/notes");
    expect(
      readConfigPath(config, ["skills", "config", "missing", "k"]),
    ).toBeUndefined();
  });

  it("defaults a config write to next-session timing", () => {
    expect(parseConfigWriteResult("a.b", {}).appliesAt).toBe("next-session");
    expect(parseConfigWriteResult("a.b", { ok: true }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Controller against the real client + fake server.
// ---------------------------------------------------------------------------

describe("skill setup — controller", () => {
  function research(scenario = skillSetupScenario()) {
    return scenario.skills?.find((s) => s.name === "research");
  }

  it("loads configured/missing state without revealing values", async () => {
    const { engine, logs } = engineFromHarness();
    const controller = new SkillSetupController(engine, "research", research());
    await controller.load();
    const { model } = controller.getSnapshot();
    const openai = model.env.find(
      (e) => e.requirement.name === "OPENAI_API_KEY",
    );
    const serp = model.env.find((e) => e.requirement.name === "SERP_API_KEY");
    expect(openai?.configured).toBe(false); // missing required
    expect(serp?.configured).toBe(true); // optional, set
    expect(model.badge.status).toBe("missing-api-key");
    // The secret value never appears in any logged record.
    expect(JSON.stringify(logs)).not.toContain(FAKE_SECRET);
    controller.dispose();
  });

  it("sets a secret through env.set and refreshes to configured", async () => {
    const { engine } = engineFromHarness();
    const setSpy = vi.spyOn(engine.client.env, "set");
    const controller = new SkillSetupController(engine, "research", research());
    await controller.load();
    await controller.setSecret(
      "OPENAI_API_KEY",
      "sk-FAKE-NEW-VALUE-123456789012",
    );
    const openai = controller
      .getSnapshot()
      .model.env.find((e) => e.requirement.name === "OPENAI_API_KEY");
    expect(openai?.configured).toBe(true);
    expect(setSpy).toHaveBeenCalledWith(
      "OPENAI_API_KEY",
      "sk-FAKE-NEW-VALUE-123456789012",
    );
    controller.dispose();
  });

  it("does not retain a secret value anywhere in its snapshot/state", async () => {
    const { engine } = engineFromHarness();
    const controller = new SkillSetupController(engine, "research", research());
    await controller.load();
    const secret = "sk-FAKE-RETENTION-CHECK-0000000000";
    await controller.setSecret("OPENAI_API_KEY", secret);
    // The whole snapshot, serialized, must not contain the value.
    expect(JSON.stringify(controller.getSnapshot())).not.toContain(secret);
    controller.dispose();
  });

  it("surfaces a safe error and does not leak on a failed write", async () => {
    const { engine } = engineFromHarness();
    vi.spyOn(engine.client.env, "set").mockRejectedValueOnce(
      new Error("boom sk-FAKE-LEAK-IN-ERROR-000000000000"),
    );
    const controller = new SkillSetupController(engine, "research", research());
    await controller.load();
    await controller.setSecret("OPENAI_API_KEY", "sk-FAKE-x");
    const snap = controller.getSnapshot();
    expect(snap.error).toBeDefined();
    expect(snap.pending.has("OPENAI_API_KEY")).toBe(false);
    controller.dispose();
  });

  it("writes non-secret config through config.set under the right path", async () => {
    const { engine } = engineFromHarness();
    // The write goes through the segment-aware method so a dotted skill/key is
    // never split into nested config keys.
    const setSpy = vi.spyOn(engine.client.config, "setValueAtSegments");
    const controller = new SkillSetupController(
      engine,
      "exporter",
      skillSetupScenario().skills?.find((s) => s.name === "exporter"),
    );
    await controller.load();
    // output_dir is preconfigured to ~/notes.
    const before = controller
      .getSnapshot()
      .model.config.find((c) => c.requirement.key === "output_dir");
    expect(before?.current).toBe("~/notes");

    await controller.setConfig("format", "json");
    expect(setSpy).toHaveBeenCalledWith(
      ["skills", "config", "exporter", "format"],
      "json",
    );
    const after = controller
      .getSnapshot()
      .model.config.find((c) => c.requirement.key === "format");
    expect(after?.current).toBe("json");
    controller.dispose();
  });

  it("fires onSaved after a successful config write so the list overview can refresh", async () => {
    const { engine } = engineFromHarness();
    const controller = new SkillSetupController(
      engine,
      "exporter",
      skillSetupScenario().skills?.find((s) => s.name === "exporter"),
    );
    const onSaved = vi.fn();
    controller.setOnSaved(onSaved);
    await controller.load();
    await controller.setConfig("format", "json");
    expect(onSaved).toHaveBeenCalled();
    controller.dispose();
  });

  it("clears config back to default through config.delete", async () => {
    const { engine } = engineFromHarness();
    const delSpy = vi.spyOn(engine.client.config, "deleteAtSegments");
    const controller = new SkillSetupController(
      engine,
      "exporter",
      skillSetupScenario().skills?.find((s) => s.name === "exporter"),
    );
    await controller.load();
    await controller.deleteConfig("output_dir");
    expect(delSpy).toHaveBeenCalledWith([
      "skills",
      "config",
      "exporter",
      "output_dir",
    ]);
    const after = controller
      .getSnapshot()
      .model.config.find((c) => c.requirement.key === "output_dir");
    expect(after?.current).toBeUndefined();
    controller.dispose();
  });

  it("reveals a secret only on request and never stores it", async () => {
    const { engine } = engineFromHarness();
    const controller = new SkillSetupController(engine, "research", research());
    await controller.load();
    const value = await controller.revealSecret("SERP_API_KEY");
    expect(value).toBe(FAKE_SECRET);
    // The revealed value is returned to the caller, not parked in state.
    expect(JSON.stringify(controller.getSnapshot())).not.toContain(FAKE_SECRET);
    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// Render: badge + required/optional + secret never shown.
// ---------------------------------------------------------------------------

describe("skill setup — view", () => {
  function stateWith(
    overrides: Partial<SkillSetupState> = {},
  ): SkillSetupState {
    const requirements: HermesSkillSetupRequirements = {
      env: [
        {
          name: "OPENAI_API_KEY",
          prompt: "OpenAI API key",
          required: true,
        },
      ],
      config: [
        { key: "output_dir", prompt: "Output directory", required: true },
      ],
    };
    const model = buildSkillSetupModel(
      requirements,
      envConfiguredIndex([{ key: "OPENAI_API_KEY", hasValue: false, raw: {} }]),
      new Map([["output_dir", "~/exports"]]),
    );
    return {
      status: "ready",
      skill: "research",
      model,
      pending: new Set(),
      retryable: false,
      lifecycle: {
        state: "clean",
        label: "Up to date",
        detail: "No pending changes.",
        canRestart: false,
      },
      notifications: [],
      refresh: vi.fn(),
      setSecret: vi.fn(),
      deleteSecret: vi.fn(),
      revealSecret: vi.fn(() => Promise.resolve(undefined)),
      setConfig: vi.fn(),
      deleteConfig: vi.fn(),
      dismissNotification: vi.fn(),
      ...overrides,
    };
  }

  it("renders required tags and a missing-API-key badge", () => {
    render(<SkillSetupView state={stateWith()} />);
    expect(screen.getByText("Missing API key")).toBeInTheDocument();
    expect(screen.getAllByText("Required").length).toBeGreaterThan(0);
    // The secret field is a password input (value hidden by default).
    const field = screen.getByLabelText("OPENAI_API_KEY value");
    expect(field).toHaveAttribute("type", "password");
  });

  it("sends a typed secret straight to setSecret and clears the field", async () => {
    const setSecret = vi.fn();
    render(<SkillSetupView state={stateWith({ setSecret })} />);
    const field = screen.getByLabelText("OPENAI_API_KEY value");
    await userEvent.type(field, "sk-FAKE-typed-123456");
    await userEvent.click(
      within(screen.getByLabelText("Required secrets")).getByRole("button", {
        name: "Save",
      }),
    );
    expect(setSecret).toHaveBeenCalledWith(
      "OPENAI_API_KEY",
      "sk-FAKE-typed-123456",
    );
    // After save the field is cleared (value lives in Hermes now).
    await waitFor(() => expect((field as HTMLInputElement).value).toBe(""));
  });

  it("does not prefill a redacted config value and refuses to save the placeholder", async () => {
    const setConfig = vi.fn();
    // A sensitive key whose stored value is masked to [redacted] for display.
    const model = buildSkillSetupModel(
      {
        env: [],
        config: [{ key: "api_token", prompt: "API token", required: true }],
      },
      new Map(),
      new Map([["api_token", FAKE_SECRET]]),
    );
    render(<SkillSetupView state={stateWith({ model, setConfig })} />);
    // The field starts empty, NOT seeded with the [redacted] placeholder.
    const field = screen.getByLabelText("api_token value") as HTMLInputElement;
    expect(field.value).toBe("");
    // Saving without typing a replacement is refused, so the real value is never
    // overwritten with [redacted].
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(setConfig).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/enter a new value/i);
  });

  it("never renders a secret value in the DOM for a configured key", () => {
    const model = buildSkillSetupModel(
      { env: [{ name: "OPENAI_API_KEY", required: true }], config: [] },
      envConfiguredIndex([
        {
          key: "OPENAI_API_KEY",
          hasValue: true,
          preview: "sk-...wxyz",
          raw: {},
        },
      ]),
      new Map(),
    );
    render(<SkillSetupView state={stateWith({ model })} />);
    // Only the masked preview, never a full value, appears.
    expect(screen.getByText(/sk-\.\.\.wxyz/)).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });
});
