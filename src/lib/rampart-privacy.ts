import type { ChatGuard } from "@nationaldesignstudio/rampart";

export const AGENT_PRIVACY_GUARD_MODE_KEY = "june:agent:privacyGuardMode";
export const AGENT_PRIVACY_GUARD_MODE_CHANGED_EVENT =
  "june:agent:privacy-guard-mode-changed";

export type AgentPrivacyGuardMode = "off" | "structured" | "full";
export type AgentPrivacyGuardActiveMode = Exclude<AgentPrivacyGuardMode, "off">;

export type AgentPrivacyGuardModeChangedDetail = {
  mode: AgentPrivacyGuardMode;
};

type AgentPrivacyGuard = Pick<ChatGuard, "protect">;

type LoadedAgentPrivacyGuard = {
  guard: AgentPrivacyGuard;
  mode: AgentPrivacyGuardActiveMode;
};

export type AgentPrivacyGuardLoader = (
  mode: AgentPrivacyGuardActiveMode,
) => Promise<LoadedAgentPrivacyGuard>;

export type AgentPrivacyGuardSession = {
  protectText: (
    text: string,
    options?: { mode?: AgentPrivacyGuardMode },
  ) => Promise<AgentPrivacyProtection>;
};

export type AgentPrivacyProtection = {
  requestedMode: AgentPrivacyGuardMode;
  mode: AgentPrivacyGuardMode;
  text: string;
  placeholders: readonly string[];
  redacted: boolean;
};

const VALID_PRIVACY_GUARD_MODES: AgentPrivacyGuardMode[] = [
  "off",
  "structured",
  "full",
];

export function getAgentPrivacyGuardMode(): AgentPrivacyGuardMode {
  try {
    const stored = window.localStorage.getItem(AGENT_PRIVACY_GUARD_MODE_KEY);
    return isAgentPrivacyGuardMode(stored) ? stored : "off";
  } catch {
    return "off";
  }
}

export function setAgentPrivacyGuardMode(mode: AgentPrivacyGuardMode) {
  try {
    if (mode === "off") {
      window.localStorage.removeItem(AGENT_PRIVACY_GUARD_MODE_KEY);
    } else {
      window.localStorage.setItem(AGENT_PRIVACY_GUARD_MODE_KEY, mode);
    }
  } catch {
    // The current session still receives the change event below.
  }
  window.dispatchEvent(
    new CustomEvent<AgentPrivacyGuardModeChangedDetail>(
      AGENT_PRIVACY_GUARD_MODE_CHANGED_EVENT,
      { detail: { mode } },
    ),
  );
}

export async function protectAgentPromptText(
  text: string,
  options: {
    mode?: AgentPrivacyGuardMode;
    loadGuard?: AgentPrivacyGuardLoader;
  } = {},
): Promise<AgentPrivacyProtection> {
  const requestedMode = options.mode ?? getAgentPrivacyGuardMode();
  if (requestedMode === "off" || !text.trim()) {
    return {
      requestedMode,
      mode: requestedMode,
      text,
      placeholders: [],
      redacted: false,
    };
  }

  const loadGuard = options.loadGuard ?? createRampartGuard;
  try {
    const loaded = await loadGuard(requestedMode);
    const result = await loaded.guard.protect(text);
    return {
      requestedMode,
      mode: loaded.mode,
      text: result.text,
      placeholders: result.placeholders,
      redacted: result.text !== text || result.placeholders.length > 0,
    };
  } catch (cause) {
    throw new AgentPrivacyGuardUnavailableError(cause);
  }
}

export function createAgentPrivacyGuardSession(
  options: { loadGuard?: AgentPrivacyGuardLoader } = {},
): AgentPrivacyGuardSession {
  const guardPromises = new Map<
    AgentPrivacyGuardActiveMode,
    Promise<LoadedAgentPrivacyGuard>
  >();
  const loadGuard = options.loadGuard ?? createRampartGuard;

  async function loadSessionGuard(
    mode: AgentPrivacyGuardActiveMode,
  ): Promise<LoadedAgentPrivacyGuard> {
    const cached = guardPromises.get(mode);
    if (cached) return cached;
    const promise = loadGuard(mode);
    guardPromises.set(mode, promise);
    try {
      return await promise;
    } catch (error) {
      guardPromises.delete(mode);
      throw error;
    }
  }

  return {
    protectText(text, protectOptions = {}) {
      return protectAgentPromptText(text, {
        ...protectOptions,
        loadGuard: loadSessionGuard,
      });
    },
  };
}

export function agentPrivacyGuardNoticeMessage(redactedDetails: number) {
  const count = Math.max(1, redactedDetails);
  const noun = count === 1 ? "detail" : "details";
  return `Privacy guard redacted ${count} ${noun} before sending.`;
}

export function agentPrivacyGuardModeLabel(mode: AgentPrivacyGuardMode) {
  if (mode === "structured") return "Structured";
  if (mode === "full") return "Full";
  return "Off";
}

export class AgentPrivacyGuardUnavailableError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(
      "Privacy guard could not prepare this message. Turn it off in Agent settings to send without redaction.",
    );
    this.name = "AgentPrivacyGuardUnavailableError";
    this.cause = cause;
  }
}

async function createRampartGuard(
  mode: AgentPrivacyGuardActiveMode,
): Promise<LoadedAgentPrivacyGuard> {
  const { createGuard } = await import("@nationaldesignstudio/rampart");
  if (mode === "structured") {
    return {
      guard: await createGuard({ heuristicsOnly: true }),
      mode: "structured",
    };
  }

  try {
    return {
      guard: await createGuard({ device: "wasm" }),
      mode: "full",
    };
  } catch {
    return {
      guard: await createGuard({ heuristicsOnly: true }),
      mode: "structured",
    };
  }
}

function isAgentPrivacyGuardMode(
  value: unknown,
): value is AgentPrivacyGuardMode {
  return (
    typeof value === "string" &&
    VALID_PRIVACY_GUARD_MODES.includes(value as AgentPrivacyGuardMode)
  );
}
