import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NoteChatPanel } from "../components/note-chat/NoteChatPanel";
import type { NoteChat } from "../components/note-chat/useNoteChat";
import { AGENT_RUN_AUTO_MODEL_PREFIX } from "../lib/agent-model-selection";
import { loadSessionModels, rememberSessionModel } from "../lib/agent-session-models";

const mocks = vi.hoisted(() => ({
  listVeniceModels: vi.fn(),
  providerModelSettings: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  dictationHelperCommand: vi.fn(),
  listVeniceModels: mocks.listVeniceModels,
  providerModelSettings: mocks.providerModelSettings,
}));

describe("note chat model truthfulness", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.listVeniceModels.mockReset();
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: "concrete-default",
      models: [
        {
          provider: "venice",
          id: "concrete-default",
          name: "Concrete default",
          modelType: "text",
          traits: ["private"],
          capabilities: ["supportsFunctionCalling"],
        },
      ],
    });
    mocks.providerModelSettings.mockReset();
    mocks.providerModelSettings.mockResolvedValue({
      settings: { generationModel: "concrete-default", costQuality: 100 },
      effectiveSettings: {
        generationModel: "concrete-default",
        costQuality: 100,
        veniceApiKeyConfigured: false,
      },
    });
  });

  it("never lets catalog hydration overwrite an acknowledged session choice", async () => {
    const stagedAuto = `${AGENT_RUN_AUTO_MODEL_PREFIX}20`;
    rememberSessionModel("note-session", stagedAuto);
    const setModel = vi.fn((model: string) => rememberSessionModel("note-session", model));
    const chat: NoteChat = {
      turns: [],
      working: false,
      submissionPending: false,
      loading: false,
      error: null,
      storedSessionId: "note-session",
      model: "auto",
      setModel,
      submit: vi.fn(async () => ({ accepted: true, current: true })),
      retry: vi.fn(async () => true),
      stop: vi.fn(),
    };

    render(
      <NoteChatPanel
        note={{ id: "note-1", title: "Planning" }}
        chat={chat}
        onClose={vi.fn()}
        onOpenInAgent={vi.fn()}
      />,
    );

    await waitFor(() => expect(mocks.listVeniceModels).toHaveBeenCalledOnce());
    expect(setModel).not.toHaveBeenCalled();
    expect(loadSessionModels()["note-session"]).toBe(stagedAuto);
  });
});
