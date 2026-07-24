export type SettingsTab =
  | "general"
  | "appearance"
  | "billing"
  | "shortcuts"
  | "dictation"
  | "audio"
  | "models"
  | "agent"
  | "memory"
  | "connectors"
  | "about";

export const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "billing", label: "Billing" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "dictation", label: "Dictation" },
  { id: "audio", label: "Audio" },
  { id: "models", label: "Models" },
  { id: "agent", label: "Agent" },
  { id: "memory", label: "Memory" },
  { id: "connectors", label: "Plugins" },
  { id: "about", label: "About" },
];
