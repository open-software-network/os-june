import { setShowThinking, type ProviderModelSettingsDto } from "./tauri";

export const SHOW_THINKING_CHANGED_EVENT = "june:show-thinking-changed";

export type ShowThinkingChangedDetail = {
  enabled: boolean;
};

/** Persists the show-thinking display preference and broadcasts the change so
 * open chat surfaces re-render without refetching settings. Display-only: it
 * never changes what the model does. */
export async function saveShowThinking(enabled: boolean): Promise<ProviderModelSettingsDto> {
  const settings = await setShowThinking(enabled);
  window.dispatchEvent(
    new CustomEvent<ShowThinkingChangedDetail>(SHOW_THINKING_CHANGED_EVENT, {
      detail: { enabled: settings.showThinking },
    }),
  );
  return settings;
}
