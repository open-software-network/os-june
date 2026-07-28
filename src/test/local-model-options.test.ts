import { describe, expect, it } from "vitest";
import type {
  LocalGenerationSettingsDto,
  LocalTranscriptionSettingsDto,
  VeniceModelDto,
} from "../lib/tauri";
import { modelOptions } from "../components/settings/ModelPickerDialog";
import {
  LOCAL_GENERATION_OPTION_ID_PREFIX,
  LOCAL_TRANSCRIPTION_OPTION_ID_PREFIX,
  localGenerationOptionId,
  localTranscriptionOptionId,
  rawLocalGenerationModelId,
  rawLocalTranscriptionModelId,
  transcriptionPickerValueForMode,
  withLocalGenerationOption,
  withLocalTranscriptionOption,
} from "../lib/local-generation";

function remoteModel(id: string): VeniceModelDto {
  return {
    provider: "venice",
    id,
    name: id,
    modelType: "asr",
    traits: [],
    capabilities: [],
  } as VeniceModelDto;
}

const LOOPBACK = "http://localhost:8000/v1";
const LAN = "http://192.168.1.20:8000/v1";
const MODEL_ID = "openai/whisper-large-v3:latest";

describe("withLocalTranscriptionOption", () => {
  it("prepends exactly one asr row marked local for a loopback endpoint", () => {
    const local: LocalTranscriptionSettingsDto = {
      baseUrl: LOOPBACK,
      modelId: MODEL_ID,
      apiKey: "",
    };
    const result = withLocalTranscriptionOption(
      [remoteModel("venice-1"), remoteModel("venice-2")],
      local,
    );
    expect(result).toHaveLength(3);
    const [first, ...rest] = result;
    expect(first.provider).toBe("local");
    expect(first.modelType).toBe("asr");
    expect(first.privacy).toBe("local");
    expect(first.name).toBe(`Local: ${MODEL_ID}`);
    expect(first.traits).toEqual(["local"]);
    expect(first.capabilities).toEqual([]);
    expect(rest.map((model) => model.id)).toEqual(["venice-1", "venice-2"]);
  });

  it("marks a LAN endpoint as external", () => {
    const local: LocalTranscriptionSettingsDto = {
      baseUrl: LAN,
      modelId: MODEL_ID,
      apiKey: "",
    };
    const [first] = withLocalTranscriptionOption([remoteModel("venice-1")], local);
    expect(first.privacy).toBe("external");
  });

  it("returns the input unchanged when no model id is configured", () => {
    const local: LocalTranscriptionSettingsDto = {
      baseUrl: LOOPBACK,
      modelId: "",
      apiKey: "",
    };
    const input = [remoteModel("venice-1")];
    expect(withLocalTranscriptionOption(input, local)).toBe(input);
  });
});

describe("transcription option id round-trip", () => {
  it("round-trips a model id containing / and :", () => {
    const id = localTranscriptionOptionId(MODEL_ID);
    expect(id.startsWith(LOCAL_TRANSCRIPTION_OPTION_ID_PREFIX)).toBe(true);
    expect(rawLocalTranscriptionModelId(id)).toBe(MODEL_ID);
  });

  it("returns null for an untagged id", () => {
    expect(rawLocalTranscriptionModelId("openai/whisper-large-v3")).toBeNull();
  });

  it("returns null for a generation-tagged id (prefixes do not cross-parse)", () => {
    const generationId = localGenerationOptionId(MODEL_ID);
    expect(generationId.startsWith(LOCAL_GENERATION_OPTION_ID_PREFIX)).toBe(true);
    expect(rawLocalTranscriptionModelId(generationId)).toBeNull();
  });

  it("rawLocalGenerationModelId returns null for a transcription-tagged id", () => {
    const transcriptionId = localTranscriptionOptionId(MODEL_ID);
    expect(rawLocalGenerationModelId(transcriptionId)).toBeNull();
  });
});

describe("withLocalGenerationOption (regression guard)", () => {
  it("prepends exactly one text row marked local for a loopback endpoint", () => {
    const local: LocalGenerationSettingsDto = {
      baseUrl: LOOPBACK,
      modelId: "llama3.1:8b",
      apiKey: "",
    };
    const result = withLocalGenerationOption([remoteModel("venice-text-1")], local);
    expect(result).toHaveLength(2);
    expect(result[0].provider).toBe("local");
    expect(result[0].modelType).toBe("text");
    expect(result[0].privacy).toBe("local");
    expect(result[0].name).toBe("Local: llama3.1:8b");
  });

  it("preserves the loopback generation description", () => {
    const local: LocalGenerationSettingsDto = {
      baseUrl: LOOPBACK,
      modelId: "llama3.1:8b",
      apiKey: "",
    };
    const [first] = withLocalGenerationOption([remoteModel("venice-text-1")], local);
    expect(first.description).toBe("OpenAI-compatible local text model.");
  });

  it("preserves the non-loopback generation description", () => {
    const local: LocalGenerationSettingsDto = {
      baseUrl: LAN,
      modelId: "llama3.1:8b",
      apiKey: "",
    };
    const [first] = withLocalGenerationOption([remoteModel("venice-text-1")], local);
    expect(first.description).toBe("OpenAI-compatible text model on a remote endpoint.");
  });

  it("uses the shared transcription description for the asr row", () => {
    const local: LocalTranscriptionSettingsDto = {
      baseUrl: LOOPBACK,
      modelId: MODEL_ID,
      apiKey: "",
    };
    const [first] = withLocalTranscriptionOption([remoteModel("venice-1")], local);
    expect(first.description).toBe("OpenAI-compatible local transcription model.");
  });

  it("returns the input unchanged when no model id is configured", () => {
    const local: LocalGenerationSettingsDto = {
      baseUrl: LOOPBACK,
      modelId: "",
      apiKey: "",
    };
    const input = [remoteModel("venice-text-1")];
    expect(withLocalGenerationOption(input, local)).toBe(input);
  });

  it("round-trips a generation model id", () => {
    const id = localGenerationOptionId("llama3.1:8b");
    expect(rawLocalGenerationModelId(id)).toBe("llama3.1:8b");
  });
});

describe("transcriptionPickerValueForMode", () => {
  const local: LocalTranscriptionSettingsDto = {
    baseUrl: LOOPBACK,
    modelId: MODEL_ID,
    apiKey: "",
  };

  it("returns the tagged local id when local is enabled in the editable global view", () => {
    expect(
      transcriptionPickerValueForMode({
        localTranscriptionEnabled: true,
        localModelId: local.modelId,
        showingPartitionModels: false,
        effectiveTranscriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
      }),
    ).toBe(localTranscriptionOptionId(MODEL_ID));
  });

  it("falls back to the effective transcription model when local is disabled", () => {
    expect(
      transcriptionPickerValueForMode({
        localTranscriptionEnabled: false,
        localModelId: local.modelId,
        showingPartitionModels: false,
        effectiveTranscriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
      }),
    ).toBe("nvidia/parakeet-tdt-0.6b-v3");
  });

  it("prefers the partition effective model over the global local toggle in profile views", () => {
    expect(
      transcriptionPickerValueForMode({
        localTranscriptionEnabled: true,
        localModelId: local.modelId,
        showingPartitionModels: true,
        effectiveTranscriptionModel: "venice/parakeet-tdt-0.6b-v3",
      }),
    ).toBe("venice/parakeet-tdt-0.6b-v3");
  });

  it("falls back to the effective model when the local model id is empty", () => {
    expect(
      transcriptionPickerValueForMode({
        localTranscriptionEnabled: true,
        localModelId: "",
        showingPartitionModels: false,
        effectiveTranscriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
      }),
    ).toBe("nvidia/parakeet-tdt-0.6b-v3");
  });
});

describe("transcription picker options (regression)", () => {
  const local: LocalTranscriptionSettingsDto = {
    baseUrl: LOOPBACK,
    modelId: MODEL_ID,
    apiKey: "",
  };

  it("does not duplicate the local model row when local is enabled", () => {
    const catalog = withLocalTranscriptionOption([remoteModel("venice-1")], local);
    const pickerValue = transcriptionPickerValueForMode({
      localTranscriptionEnabled: true,
      localModelId: local.modelId,
      showingPartitionModels: false,
      effectiveTranscriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
    });
    const options = modelOptions(catalog, pickerValue);
    const localRows = options.filter((model) => model.provider === "local");
    expect(localRows).toHaveLength(1);
    expect(localRows[0]?.id).toBe(localTranscriptionOptionId(MODEL_ID));
    const rawRows = options.filter((model) => model.id === MODEL_ID);
    expect(rawRows).toHaveLength(0);
  });

  it("shows the partition model without a synthetic local row in profile views", () => {
    const catalog = withLocalTranscriptionOption([remoteModel("venice-1")], local);
    const pickerValue = transcriptionPickerValueForMode({
      localTranscriptionEnabled: true,
      localModelId: local.modelId,
      showingPartitionModels: true,
      effectiveTranscriptionModel: "venice/parakeet-tdt-0.6b-v3",
    });
    const options = modelOptions(catalog, pickerValue);
    expect(options.map((model) => model.id)).toEqual([
      "venice/parakeet-tdt-0.6b-v3",
      localTranscriptionOptionId(MODEL_ID),
      "venice-1",
    ]);
    expect(options.some((model) => model.provider === "local")).toBe(true);
  });
});
