import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_HERMES_MODEL_ID_PREFIX,
  AUTO_MODEL_ID,
  DEFAULT_AUTO_COST_QUALITY,
  REMOTE_HERMES_MODEL_ID_PREFIX,
  SESSION_MODEL_SELECTION_STORAGE_KEY,
  decodeHermesModelSelection,
  forgetSessionModelSelection,
  hasPendingSessionModelSelection,
  hermesModelIdForSelection,
  markSessionModelSelectionApplied,
  migrateSessionModelSelection,
  readSessionModelSelections,
  rememberAppliedSessionModelSelection,
  stageSessionModelSelection,
} from "../lib/hermes-session-model-selection";
import { localGenerationOptionId, unavailableLocalGenerationOption } from "../lib/local-generation";

describe("session model selections", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    window.localStorage.removeItem(SESSION_MODEL_SELECTION_STORAGE_KEY);
  });

  it("ignores invalid storage and sanitizes valid persisted entries", () => {
    window.localStorage.setItem(SESSION_MODEL_SELECTION_STORAGE_KEY, "not-json");
    expect(readSessionModelSelections()).toEqual({});

    window.localStorage.setItem(
      SESSION_MODEL_SELECTION_STORAGE_KEY,
      JSON.stringify({
        invalidSelection: {
          selection: { modelId: " " },
          revision: 1,
          appliedRevision: 0,
        },
        invalidRevision: {
          selection: { modelId: "model-a" },
          revision: "1",
          appliedRevision: 0,
        },
        valid: {
          selection: { modelId: "  model-b  ", costQuality: 120.4 },
          revision: 3,
          appliedRevision: 9,
        },
      }),
    );

    expect(readSessionModelSelections()).toEqual({
      valid: {
        selection: { modelId: "model-b", costQuality: 100 },
        revision: 3,
        appliedRevision: 3,
      },
    });
  });

  it("stages synchronously with a monotonic revision and latest selection wins", () => {
    const first = stageSessionModelSelection("session-1", { modelId: "model-a" });
    expect(first["session-1"]).toEqual({
      selection: { modelId: "model-a" },
      revision: 1,
      appliedRevision: 0,
    });

    const second = stageSessionModelSelection("session-1", {
      modelId: AUTO_MODEL_ID,
      costQuality: 49.6,
    });
    expect(second["session-1"]).toEqual({
      selection: { modelId: AUTO_MODEL_ID, costQuality: 50 },
      revision: 2,
      appliedRevision: 0,
    });
    expect(readSessionModelSelections()).toEqual(second);
  });

  it("isolates choices and revision counters by stored session id", () => {
    stageSessionModelSelection("session-a", { modelId: "model-a" });
    stageSessionModelSelection("session-a", { modelId: "model-a-2" });
    const store = stageSessionModelSelection("session-b", { modelId: "model-b" });

    expect(store["session-a"].revision).toBe(2);
    expect(store["session-a"].selection.modelId).toBe("model-a-2");
    expect(store["session-b"].revision).toBe(1);
    expect(store["session-b"].selection.modelId).toBe("model-b");
  });

  it("keeps a newer choice pending when an older revision is acknowledged", () => {
    const first = stageSessionModelSelection("session-1", { modelId: "model-a" });
    const applyingRevision = first["session-1"].revision;
    stageSessionModelSelection("session-1", { modelId: "model-b" });

    const afterStaleAck = markSessionModelSelectionApplied("session-1", applyingRevision);
    expect(afterStaleAck["session-1"]).toEqual({
      selection: { modelId: "model-b" },
      revision: 2,
      appliedRevision: 1,
    });
    expect(hasPendingSessionModelSelection(afterStaleAck["session-1"])).toBe(true);

    const afterCurrentAck = markSessionModelSelectionApplied("session-1", 2);
    expect(afterCurrentAck["session-1"].appliedRevision).toBe(2);
    expect(hasPendingSessionModelSelection(afterCurrentAck["session-1"])).toBe(false);
  });

  it("keeps monotonic latest-wins state when persistence is unavailable", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    const first = stageSessionModelSelection("session-1", { modelId: "model-a" });
    const firstRevision = first["session-1"].revision;
    const second = stageSessionModelSelection("session-1", { modelId: "model-b" });

    expect(second["session-1"].revision).toBe(firstRevision + 1);
    expect(second["session-1"].selection.modelId).toBe("model-b");
    const afterStaleAck = markSessionModelSelectionApplied("session-1", firstRevision);
    expect(afterStaleAck["session-1"]).toEqual({
      selection: { modelId: "model-b" },
      revision: firstRevision + 1,
      appliedRevision: firstRevision,
    });

    // Let the canonical map flush successfully so later tests can observe
    // ordinary localStorage clearing in their beforeEach.
    setItem.mockRestore();
    stageSessionModelSelection("session-1", { modelId: "model-c" });
  });

  it("ignores an acknowledgement beyond the current revision", () => {
    const staged = stageSessionModelSelection("session-1", { modelId: "model-a" });
    const afterImpossibleAck = markSessionModelSelectionApplied("session-1", 99);
    expect(afterImpossibleAck).toEqual(staged);
    expect(hasPendingSessionModelSelection(afterImpossibleAck["session-1"])).toBe(true);
  });

  it("remembers a newly created session's already-applied choice", () => {
    const remembered = rememberAppliedSessionModelSelection("session-1", {
      modelId: AUTO_MODEL_ID,
      costQuality: 20,
    });
    expect(remembered["session-1"]).toEqual({
      selection: { modelId: AUTO_MODEL_ID, costQuality: 20 },
      revision: 1,
      appliedRevision: 1,
    });
    expect(hasPendingSessionModelSelection(remembered["session-1"])).toBe(false);

    const staged = stageSessionModelSelection("session-1", { modelId: "model-b" });
    expect(staged["session-1"].revision).toBe(2);
    expect(staged["session-1"].appliedRevision).toBe(1);
  });

  it("persists, migrates, and forgets an entry", () => {
    stageSessionModelSelection("provisional", { modelId: "model-a" });

    const migrated = migrateSessionModelSelection("provisional", "stored-session");
    expect(migrated.provisional).toBeUndefined();
    expect(migrated["stored-session"]).toEqual({
      selection: { modelId: "model-a" },
      revision: 1,
      appliedRevision: 0,
    });
    expect(readSessionModelSelections()).toEqual(migrated);

    expect(forgetSessionModelSelection("stored-session")).toEqual({});
    expect(window.localStorage.getItem(SESSION_MODEL_SELECTION_STORAGE_KEY)).toBeNull();
  });

  it("rebases a migrated pending choice above an existing destination revision", () => {
    rememberAppliedSessionModelSelection("stored-session", { modelId: "older-model" });
    rememberAppliedSessionModelSelection("stored-session", { modelId: "older-model" });
    stageSessionModelSelection("provisional", { modelId: "newer-model" });

    const migrated = migrateSessionModelSelection("provisional", "stored-session");
    expect(migrated.provisional).toBeUndefined();
    expect(migrated["stored-session"]).toEqual({
      selection: { modelId: "newer-model" },
      revision: 3,
      appliedRevision: 2,
    });
    expect(hasPendingSessionModelSelection(migrated["stored-session"])).toBe(true);
  });
});

describe("turn-scoped Hermes model ids", () => {
  it("round-trips Auto with an integer, clamped cost-quality preference", () => {
    const lower = hermesModelIdForSelection({ modelId: AUTO_MODEL_ID, costQuality: -4 });
    const rounded = hermesModelIdForSelection({ modelId: AUTO_MODEL_ID, costQuality: 72.6 });
    const higher = hermesModelIdForSelection({ modelId: AUTO_MODEL_ID, costQuality: 140 });

    expect(lower).toBe(`${AUTO_HERMES_MODEL_ID_PREFIX}0`);
    expect(decodeHermesModelSelection(lower)).toEqual({
      modelId: AUTO_MODEL_ID,
      costQuality: 0,
    });
    expect(rounded).toBe(`${AUTO_HERMES_MODEL_ID_PREFIX}73`);
    expect(decodeHermesModelSelection(rounded)).toEqual({
      modelId: AUTO_MODEL_ID,
      costQuality: 73,
    });
    expect(higher).toBe(`${AUTO_HERMES_MODEL_ID_PREFIX}100`);
    expect(decodeHermesModelSelection(higher)).toEqual({
      modelId: AUTO_MODEL_ID,
      costQuality: 100,
    });
  });

  it("uses the default preference when Auto has no usable value", () => {
    const encoded = hermesModelIdForSelection({ modelId: AUTO_MODEL_ID });
    expect(encoded).toBe(`${AUTO_HERMES_MODEL_ID_PREFIX}${DEFAULT_AUTO_COST_QUALITY}`);
    expect(decodeHermesModelSelection(`${AUTO_HERMES_MODEL_ID_PREFIX}invalid`)).toEqual({
      modelId: AUTO_MODEL_ID,
      costQuality: DEFAULT_AUTO_COST_QUALITY,
    });
  });

  it("preserves local provenance and tags concrete remote ids", () => {
    const localOption = localGenerationOptionId(" llama3.1:8b / β ");
    expect(hermesModelIdForSelection({ modelId: localOption })).toBe(localOption);
    expect(unavailableLocalGenerationOption(localOption)).toEqual(
      expect.objectContaining({
        id: localOption,
        name: "Local: llama3.1:8b / β",
        description: "This local model is no longer configured.",
      }),
    );
    const remote = hermesModelIdForSelection({ modelId: "zai-org/glm-5" });
    expect(remote).toBe(`${REMOTE_HERMES_MODEL_ID_PREFIX}zai-org%2Fglm-5`);
    expect(decodeHermesModelSelection(remote)).toEqual({
      modelId: "zai-org/glm-5",
    });
  });
});
