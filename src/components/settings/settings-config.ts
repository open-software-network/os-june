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
  | "skills"
  | "external-dirs"
  | "skill-review"
  | "mcp"
  | "mcp-catalog"
  | "mcp-diagnostics"
  | "mcp-security"
  | "skills-hub"
  | "taps"
  | "toolsets"
  | "bundles"
  | "profile-builder"
  | "integrations-health"
  | "import-export"
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
  { id: "skills", label: "Installed skills" },
  { id: "external-dirs", label: "External skill directories" },
  { id: "skill-review", label: "Pending skill changes" },
  { id: "mcp", label: "MCP servers" },
  { id: "mcp-catalog", label: "MCP catalog" },
  { id: "mcp-diagnostics", label: "MCP diagnostics" },
  { id: "mcp-security", label: "MCP security" },
  { id: "skills-hub", label: "Skills hub" },
  { id: "taps", label: "Team skill taps" },
  { id: "toolsets", label: "Toolsets" },
  { id: "bundles", label: "Bundles" },
  { id: "profile-builder", label: "Profiles" },
  { id: "integrations-health", label: "Integrations health" },
  { id: "import-export", label: "Import / export" },
  { id: "about", label: "About" },
];
