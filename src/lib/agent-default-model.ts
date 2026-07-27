import { setVeniceModel, type ProviderModelSettingsDto } from "./tauri";

type ModelWriter = (modelId: string) => Promise<ProviderModelSettingsDto | void>;

let writeTail: Promise<void> = Promise.resolve();

/** Serialize app-wide model writes so a slower earlier IPC response cannot
 * persist over a newer picker choice. Each write still runs after a previous
 * failure, leaving the most recent selection with the final word. */
export function persistAgentDefaultModel(
  modelId: string,
  writer: ModelWriter = (nextModelId) => setVeniceModel("generation", nextModelId),
): Promise<void> {
  const write = writeTail.catch(() => undefined).then(() => writer(modelId));
  writeTail = write.then(() => undefined);
  return writeTail;
}

export function resetAgentDefaultModelPersistenceForTests() {
  writeTail = Promise.resolve();
}
