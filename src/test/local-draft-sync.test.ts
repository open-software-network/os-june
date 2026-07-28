import { describe, expect, it } from "vitest";
import type { LocalTranscriptionSettingsDto } from "../lib/tauri";
import {
  decideConfirmEnable,
  decidePickerEnable,
  decideSaveModel,
  decideToggleOn,
  draftStillMatchesSent,
  localTranscriptionDraftRehydration,
  makeLocalTranscriptionSaveSerializer,
  reconcileLocalTranscriptionSaveResponse,
  type PendingLocalTranscriptionSave,
} from "../lib/local-draft-sync";

function settings(baseUrl: string, modelId: string, apiKey = ""): LocalTranscriptionSettingsDto {
  return { baseUrl, modelId, apiKey };
}

const SAVED_A = settings("http://localhost:8000/v1", "openai/whisper-large-v3:latest");
const EDITED_B = settings("http://localhost:8000/v1", "openai/whisper-large-v2");

describe("localTranscriptionDraftRehydration", () => {
  it("rehydrates from provider settings when no save is in flight", () => {
    const decision = localTranscriptionDraftRehydration({
      pendingSave: null,
      incoming: SAVED_A,
      currentDraft: EDITED_B,
    });
    expect(decision).toEqual({ rehydrate: true, matchesPendingSave: false });
  });

  it("preserves edits made while a save is in flight (the delayed-save race)", () => {
    const decision = localTranscriptionDraftRehydration({
      pendingSave: SAVED_A,
      incoming: SAVED_A,
      currentDraft: EDITED_B,
    });
    expect(decision.matchesPendingSave).toBe(true);
    expect(decision.rehydrate).toBe(false);
  });

  it("rehydrates when the saved response matches and the draft was not edited", () => {
    const decision = localTranscriptionDraftRehydration({
      pendingSave: SAVED_A,
      incoming: SAVED_A,
      currentDraft: SAVED_A,
    });
    expect(decision.matchesPendingSave).toBe(true);
    expect(decision.rehydrate).toBe(true);
  });

  it("still rehydrates when provider settings change to something other than the pending save", () => {
    const other = settings("http://localhost:9000/v1", "openai/whisper-large-v3");
    const decision = localTranscriptionDraftRehydration({
      pendingSave: SAVED_A,
      incoming: other,
      currentDraft: EDITED_B,
    });
    expect(decision.matchesPendingSave).toBe(false);
    expect(decision.rehydrate).toBe(true);
  });

  it("treats an api-key change as an edit that must be preserved", () => {
    const editedKey = settings(SAVED_A.baseUrl, SAVED_A.modelId, "sk-new");
    const decision = localTranscriptionDraftRehydration({
      pendingSave: SAVED_A,
      incoming: SAVED_A,
      currentDraft: editedKey,
    });
    expect(decision.matchesPendingSave).toBe(true);
    expect(decision.rehydrate).toBe(false);
  });

  it("treats a trailing-slash base URL as matching its normalized backend response", () => {
    const withSlash = settings("http://localhost:8000/v1/", "openai/whisper-large-v3");
    const normalized = settings("http://localhost:8000/v1", "openai/whisper-large-v3");
    const decision = localTranscriptionDraftRehydration({
      pendingSave: withSlash,
      incoming: normalized,
      currentDraft: withSlash,
    });
    expect(decision.matchesPendingSave).toBe(true);
    expect(decision.rehydrate).toBe(true);
  });

  it("preserves edits made during a save even when the backend normalizes the base URL", () => {
    const withSlash = settings("http://localhost:8000/v1/", "openai/whisper-large-v3");
    const normalized = settings("http://localhost:8000/v1", "openai/whisper-large-v3");
    const editedModel = settings("http://localhost:8000/v1/", "openai/whisper-large-v2");
    const decision = localTranscriptionDraftRehydration({
      pendingSave: withSlash,
      incoming: normalized,
      currentDraft: editedModel,
    });
    expect(decision.matchesPendingSave).toBe(true);
    expect(decision.rehydrate).toBe(false);
  });
});

describe("reconcileLocalTranscriptionSaveResponse", () => {
  function pendingFor(
    sent: LocalTranscriptionSettingsDto,
    seq: number,
  ): PendingLocalTranscriptionSave {
    return { seq, sent };
  }

  it("applies an earlier save and keeps the newer save pending when a newer save is in flight", () => {
    const outcome = reconcileLocalTranscriptionSaveResponse({
      pending: pendingFor(EDITED_B, 2),
      responseSeq: 1,
      responseSettings: SAVED_A,
      currentDraft: EDITED_B,
    });
    expect(outcome).toEqual({
      kind: "apply",
      preserveEdits: true,
      matchesPendingSave: false,
      clearPending: false,
    });
  });

  it("drops a response when no save is pending", () => {
    const outcome = reconcileLocalTranscriptionSaveResponse({
      pending: null,
      responseSeq: 1,
      responseSettings: SAVED_A,
      currentDraft: SAVED_A,
    });
    expect(outcome).toEqual({ kind: "drop" });
  });

  it("applies and rehydrates the draft when the save matches and the user did not edit", () => {
    const outcome = reconcileLocalTranscriptionSaveResponse({
      pending: pendingFor(SAVED_A, 1),
      responseSeq: 1,
      responseSettings: SAVED_A,
      currentDraft: SAVED_A,
    });
    expect(outcome).toEqual({
      kind: "apply",
      preserveEdits: false,
      matchesPendingSave: true,
      clearPending: true,
    });
  });

  it("applies but preserves the draft when the user edited during the save", () => {
    const outcome = reconcileLocalTranscriptionSaveResponse({
      pending: pendingFor(SAVED_A, 1),
      responseSeq: 1,
      responseSettings: SAVED_A,
      currentDraft: EDITED_B,
    });
    expect(outcome).toEqual({
      kind: "apply",
      preserveEdits: true,
      matchesPendingSave: true,
      clearPending: true,
    });
  });

  it("applies and rehydrates when the backend normalizes a trailing base-URL slash", () => {
    const withSlash = settings("http://localhost:8000/v1/", "openai/whisper-large-v3");
    const normalized = settings("http://localhost:8000/v1", "openai/whisper-large-v3");
    const outcome = reconcileLocalTranscriptionSaveResponse({
      pending: pendingFor(withSlash, 1),
      responseSeq: 1,
      responseSettings: normalized,
      currentDraft: withSlash,
    });
    expect(outcome).toEqual({
      kind: "apply",
      preserveEdits: false,
      matchesPendingSave: true,
      clearPending: true,
    });
  });

  it("preserves the durable snapshot from an earlier save when the newer save then fails", () => {
    const outcomeA = reconcileLocalTranscriptionSaveResponse({
      pending: pendingFor(EDITED_B, 2),
      responseSeq: 1,
      responseSettings: SAVED_A,
      currentDraft: EDITED_B,
    });
    expect(outcomeA).toEqual({
      kind: "apply",
      preserveEdits: true,
      matchesPendingSave: false,
      clearPending: false,
    });
    const outcomeB = reconcileLocalTranscriptionSaveResponse({
      pending: pendingFor(EDITED_B, 2),
      responseSeq: 2,
      responseSettings: EDITED_B,
      currentDraft: EDITED_B,
    });
    expect(outcomeB).toEqual({
      kind: "apply",
      preserveEdits: false,
      matchesPendingSave: true,
      clearPending: true,
    });
  });
});

const LOOPBACK_URL = "http://localhost:8000/v1";
const LAN_URL = "http://192.168.1.20:8000/v1";
const LAN_MODEL = "openai/whisper-large-v3:latest";

function toggleState(args: {
  enabled: boolean;
  savedBaseUrl: string;
  draftBaseUrl: string;
  draftModelId: string;
}) {
  return args;
}

describe("decideToggleOn", () => {
  it("is incomplete when the draft endpoint or model is missing", () => {
    expect(
      decideToggleOn(
        toggleState({
          enabled: false,
          savedBaseUrl: LOOPBACK_URL,
          draftBaseUrl: "",
          draftModelId: LAN_MODEL,
        }),
      ),
    ).toEqual({ kind: "incomplete" });
    expect(
      decideToggleOn(
        toggleState({
          enabled: false,
          savedBaseUrl: LOOPBACK_URL,
          draftBaseUrl: LOOPBACK_URL,
          draftModelId: "",
        }),
      ),
    ).toEqual({ kind: "incomplete" });
  });

  it("authorizes a loopback draft directly via loopback-enable", () => {
    expect(
      decideToggleOn(
        toggleState({
          enabled: false,
          savedBaseUrl: "",
          draftBaseUrl: LOOPBACK_URL,
          draftModelId: LAN_MODEL,
        }),
      ),
    ).toEqual({ kind: "loopback-enable" });
  });

  it("always requires confirm for a non-loopback draft regardless of prior state", () => {
    const state = toggleState({
      enabled: false,
      savedBaseUrl: LOOPBACK_URL,
      draftBaseUrl: LAN_URL,
      draftModelId: LAN_MODEL,
    });
    expect(decideToggleOn(state)).toEqual({ kind: "require-confirm" });
    expect(decideToggleOn(state)).toEqual({ kind: "require-confirm" });
    expect(decideToggleOn({ ...state, enabled: true })).toEqual({ kind: "require-confirm" });
  });

  it("does not cross-parse a loopback draft as enableable when it is non-loopback", () => {
    expect(
      decideToggleOn(
        toggleState({
          enabled: true,
          savedBaseUrl: LAN_URL,
          draftBaseUrl: "http://10.0.0.5:8000/v1",
          draftModelId: LAN_MODEL,
        }),
      ),
    ).toEqual({ kind: "require-confirm" });
  });
});

describe("decideSaveModel", () => {
  it("blocks an incomplete draft from saving", () => {
    expect(
      decideSaveModel(
        toggleState({
          enabled: true,
          savedBaseUrl: LOOPBACK_URL,
          draftBaseUrl: LAN_URL,
          draftModelId: "",
        }),
      ),
    ).toEqual({ kind: "blocked-incomplete" });
  });

  it("saves a loopback draft regardless of activation state", () => {
    expect(
      decideSaveModel(
        toggleState({
          enabled: true,
          savedBaseUrl: LOOPBACK_URL,
          draftBaseUrl: "http://localhost:9000/v1",
          draftModelId: LAN_MODEL,
        }),
      ),
    ).toEqual({ kind: "save" });
    expect(
      decideSaveModel(
        toggleState({
          enabled: false,
          savedBaseUrl: "",
          draftBaseUrl: LOOPBACK_URL,
          draftModelId: LAN_MODEL,
        }),
      ),
    ).toEqual({ kind: "save" });
  });

  it("requires confirm when an active loopback STT route moves off-device", () => {
    expect(
      decideSaveModel(
        toggleState({
          enabled: true,
          savedBaseUrl: LOOPBACK_URL,
          draftBaseUrl: LAN_URL,
          draftModelId: LAN_MODEL,
        }),
      ),
    ).toEqual({ kind: "require-confirm" });
  });

  it("allows a disabled STT route to save a non-loopback endpoint without confirm", () => {
    expect(
      decideSaveModel(
        toggleState({
          enabled: false,
          savedBaseUrl: LOOPBACK_URL,
          draftBaseUrl: LAN_URL,
          draftModelId: LAN_MODEL,
        }),
      ),
    ).toEqual({ kind: "save" });
  });

  it("allows saving when an active route is already off-device and stays off-device", () => {
    expect(
      decideSaveModel(
        toggleState({
          enabled: true,
          savedBaseUrl: LAN_URL,
          draftBaseUrl: "http://10.0.0.5:8000/v1",
          draftModelId: LAN_MODEL,
        }),
      ),
    ).toEqual({ kind: "save" });
  });

  it("allows an active off-device route moving back to loopback without confirm", () => {
    expect(
      decideSaveModel(
        toggleState({
          enabled: true,
          savedBaseUrl: LAN_URL,
          draftBaseUrl: LOOPBACK_URL,
          draftModelId: LAN_MODEL,
        }),
      ),
    ).toEqual({ kind: "save" });
  });
});

describe("draftStillMatchesSent", () => {
  it("matches when the draft is unchanged after the save", () => {
    expect(draftStillMatchesSent(SAVED_A, SAVED_A)).toBe(true);
  });

  it("does not match when the draft was edited to a different model during the save", () => {
    expect(draftStillMatchesSent(SAVED_A, EDITED_B)).toBe(false);
  });

  it("does not match when the base URL changed during the save", () => {
    const sent = settings(LOOPBACK_URL, LAN_MODEL);
    const edited = settings("http://localhost:9000/v1", LAN_MODEL);
    expect(draftStillMatchesSent(sent, edited)).toBe(false);
  });

  it("does not match when the api key changed during the save", () => {
    const sent = settings(LOOPBACK_URL, LAN_MODEL, "");
    const edited = settings(LOOPBACK_URL, LAN_MODEL, "sk-new");
    expect(draftStillMatchesSent(sent, edited)).toBe(false);
  });

  it("treats a trailing slash on the saved base URL as a match", () => {
    const sent = settings("http://localhost:8000/v1/", LAN_MODEL);
    const draftAfterSave = settings("http://localhost:8000/v1/", LAN_MODEL);
    expect(draftStillMatchesSent(sent, draftAfterSave)).toBe(true);
  });

  it("matches when the backend normalized a trailing slash and the draft was unchanged", () => {
    const sent = settings("http://localhost:8000/v1/", LAN_MODEL);
    const draftAfterSave = settings("http://localhost:8000/v1", LAN_MODEL);
    expect(draftStillMatchesSent(sent, draftAfterSave)).toBe(true);
  });
});

describe("decideConfirmEnable", () => {
  const SAVED_LAN_A = settings(LAN_URL, LAN_MODEL);
  const DRAFT_LAN_B = settings("http://10.0.0.5:8000/v1", "openai/whisper-large-v2");

  function confirmState(args: {
    fromPicker: boolean;
    savedBaseUrl?: string;
    savedModelId?: string;
    draftBaseUrl?: string;
    draftModelId?: string;
  }) {
    const saved = args.fromPicker ? SAVED_LAN_A : DRAFT_LAN_B;
    const draft = args.fromPicker ? DRAFT_LAN_B : SAVED_LAN_A;
    return {
      fromPicker: args.fromPicker,
      savedBaseUrl: args.savedBaseUrl ?? saved.baseUrl,
      savedModelId: args.savedModelId ?? saved.modelId,
      draftBaseUrl: args.draftBaseUrl ?? draft.baseUrl,
      draftModelId: args.draftModelId ?? draft.modelId,
    };
  }

  it("enables the saved endpoint when the confirm originated from the picker", () => {
    expect(decideConfirmEnable(confirmState({ fromPicker: true }))).toEqual({
      kind: "enable-saved",
    });
  });

  it("never saves the mutable draft when the picker prompted the confirm", () => {
    expect(decideConfirmEnable(confirmState({ fromPicker: true }))).not.toEqual({
      kind: "save-draft-then-enable",
    });
  });

  it("saves the draft before enabling when the toggle prompted the confirm", () => {
    expect(decideConfirmEnable(confirmState({ fromPicker: false }))).toEqual({
      kind: "save-draft-then-enable",
    });
  });

  it("is incomplete when the picker confirm has no saved endpoint", () => {
    expect(
      decideConfirmEnable(confirmState({ fromPicker: true, savedBaseUrl: "", savedModelId: "" })),
    ).toEqual({ kind: "incomplete" });
  });

  it("is incomplete when the toggle confirm has an empty draft", () => {
    expect(
      decideConfirmEnable(confirmState({ fromPicker: false, draftBaseUrl: "", draftModelId: "" })),
    ).toEqual({ kind: "incomplete" });
  });
});

describe("decidePickerEnable", () => {
  function pendingFor(
    sent: LocalTranscriptionSettingsDto,
    seq: number,
  ): PendingLocalTranscriptionSave {
    return { seq, sent };
  }

  it("enables directly when no save is in flight and the saved endpoint is loopback", () => {
    expect(
      decidePickerEnable({
        pendingSave: null,
        savedBaseUrl: LOOPBACK_URL,
      }),
    ).toEqual({ kind: "enable-saved" });
  });

  it("requires confirm when no save is in flight and the saved endpoint is non-loopback", () => {
    expect(
      decidePickerEnable({
        pendingSave: null,
        savedBaseUrl: LAN_URL,
      }),
    ).toEqual({ kind: "require-confirm" });
  });

  it("requires confirm when a non-loopback save is in flight even though saved is still loopback", () => {
    const decision = decidePickerEnable({
      pendingSave: pendingFor(settings(LAN_URL, LAN_MODEL), 1),
      savedBaseUrl: LOOPBACK_URL,
    });
    expect(decision).toEqual({ kind: "require-confirm" });
  });

  it("still requires confirm when an in-flight save keeps the endpoint loopback", () => {
    expect(
      decidePickerEnable({
        pendingSave: pendingFor(settings(LOOPBACK_URL, LAN_MODEL), 1),
        savedBaseUrl: LOOPBACK_URL,
      }),
    ).toEqual({ kind: "require-confirm" });
  });

  it("requires confirm when an in-flight save moves the endpoint from LAN to loopback before persistence settles", () => {
    expect(
      decidePickerEnable({
        pendingSave: pendingFor(settings(LOOPBACK_URL, LAN_MODEL), 1),
        savedBaseUrl: LAN_URL,
      }),
    ).toEqual({ kind: "require-confirm" });
  });

  it("requires confirm when an in-flight save moves the endpoint from loopback to LAN before persistence settles", () => {
    expect(
      decidePickerEnable({
        pendingSave: pendingFor(settings(LAN_URL, LAN_MODEL), 1),
        savedBaseUrl: LOOPBACK_URL,
      }),
    ).toEqual({ kind: "require-confirm" });
  });
});

describe("makeLocalTranscriptionSaveSerializer", () => {
  it("serializes concurrent saves so an older save cannot overwrite a newer one", async () => {
    const enqueue = makeLocalTranscriptionSaveSerializer();
    const persisted: LocalTranscriptionSettingsDto[] = [];
    const order: string[] = [];

    let resolveA!: () => void;
    const deferredA = new Promise<void>((resolve) => {
      resolveA = resolve;
    });

    const a = enqueue(async () => {
      await deferredA;
      persisted.push(SAVED_A);
      order.push("a");
    });
    const b = enqueue(async () => {
      persisted.push(EDITED_B);
      order.push("b");
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([]);

    resolveA();
    await Promise.all([a, b]);

    expect(order).toEqual(["a", "b"]);
    expect(persisted).toEqual([SAVED_A, EDITED_B]);
    expect(persisted.at(-1)).toEqual(EDITED_B);
  });

  it("still runs a later save after an earlier save rejects", async () => {
    const enqueue = makeLocalTranscriptionSaveSerializer();
    const persisted: LocalTranscriptionSettingsDto[] = [];

    const a = enqueue(async () => {
      throw new Error("save A failed");
    });
    const b = enqueue(async () => {
      persisted.push(EDITED_B);
    });

    await expect(a).rejects.toThrow("save A failed");
    await b;
    expect(persisted).toEqual([EDITED_B]);
  });
});
