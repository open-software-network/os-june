// Dev-only console driver for the session usage panel: window.__usageDemo("half")
// parks the agent's usage overlay in a given state regardless of any live
// session, so every variant (mid-window fill, nearly-empty, near-full, at the
// themed high-water color, cost breakdown, empty) can be designed without a matching
// Hermes session.
// __usageDemo("off") — or __usageDemo(false) — goes back to real data.
// __usageDemo() prints the list.
//
// The hook is imported unconditionally by AgentWorkspace (the override simply
// stays null in production); only the console command registration is gated on
// import.meta.env.DEV, in main.tsx.

import { useSyncExternalStore } from "react";
import type { SessionUsage } from "./hermes-session-usage";
import type { VeniceModelDto } from "./tauri";

const USAGE_DEMO_EVENT = "june:usage-demo-changed";

export type UsageDemoKey = "half" | "low" | "nearFull" | "critical" | "cost" | "empty";

export type UsageDemoFixture = {
  label: string;
  usage: SessionUsage;
  model: VeniceModelDto;
};

// One demo model, resolved for every fixture so the model row, the "private"
// privacy chip, and the context clamp all light up. `privacy: "private"` yields
// modelPrivacyBadge → "Private mode"; contextTokens caps the meter denominator.
const DEMO_MODEL: VeniceModelDto = {
  provider: "venice",
  id: "glm-5-2-demo",
  name: "GLM 5.2",
  modelType: "text",
  privacy: "private",
  traits: [],
  capabilities: [],
  contextTokens: 200_000,
};

const WINDOW = 200_000;

// Ordered from the everyday mid-window state outward to the edge cases.
export const USAGE_DEMO_FIXTURES: Record<UsageDemoKey, UsageDemoFixture> = {
  half: {
    label: "About half full",
    usage: {
      sessionId: "usage-demo-half",
      model: DEMO_MODEL.id,
      promptTokens: 72_000,
      completionTokens: 28_000,
      totalTokens: 100_000,
      contextUsed: 100_000,
      contextLimit: WINDOW,
    },
    model: DEMO_MODEL,
  },
  low: {
    label: "Barely used",
    usage: {
      sessionId: "usage-demo-low",
      model: DEMO_MODEL.id,
      promptTokens: 3_600,
      completionTokens: 1_400,
      totalTokens: 5_000,
      contextUsed: 5_000,
      contextLimit: WINDOW,
    },
    model: DEMO_MODEL,
  },
  nearFull: {
    // 184K / 200K = 92%, past the 90% near-full threshold, so this exercises
    // the themed warm-strong meter color (the only non-normal tier).
    label: "Near full (themed color)",
    usage: {
      sessionId: "usage-demo-near-full",
      model: DEMO_MODEL.id,
      promptTokens: 146_000,
      completionTokens: 38_000,
      totalTokens: 184_000,
      contextUsed: 184_000,
      contextLimit: WINDOW,
    },
    model: DEMO_MODEL,
  },
  critical: {
    label: "Nearly full (themed color)",
    usage: {
      sessionId: "usage-demo-critical",
      model: DEMO_MODEL.id,
      promptTokens: 150_000,
      completionTokens: 44_000,
      totalTokens: 194_000,
      contextUsed: 194_000,
      contextLimit: WINDOW,
    },
    model: DEMO_MODEL,
  },
  cost: {
    label: "With cost breakdown",
    usage: {
      sessionId: "usage-demo-cost",
      model: DEMO_MODEL.id,
      promptTokens: 72_000,
      completionTokens: 28_000,
      totalTokens: 100_000,
      contextUsed: 100_000,
      contextLimit: WINDOW,
      estimatedCostUsd: 0.4213,
      toolCosts: [
        { name: "web_search", estimatedCostUsd: 0.01 },
        { name: "code_subagent", estimatedCostUsd: 0.12 },
      ],
    },
    model: DEMO_MODEL,
  },
  empty: {
    label: "Empty state",
    usage: { sessionId: "usage-demo-empty" },
    model: DEMO_MODEL,
  },
};

export const USAGE_DEMO_ORDER: UsageDemoKey[] = [
  "half",
  "low",
  "nearFull",
  "critical",
  "cost",
  "empty",
];

let forced: UsageDemoKey | null = null;

function subscribe(onChange: () => void) {
  window.addEventListener(USAGE_DEMO_EVENT, onChange);
  return () => window.removeEventListener(USAGE_DEMO_EVENT, onChange);
}

/** The forced usage fixture, or null while the real session path is active. */
export function useUsagePanelDemo(): UsageDemoFixture | null {
  return useSyncExternalStore(
    subscribe,
    () => (forced ? USAGE_DEMO_FIXTURES[forced] : null),
    () => null,
  );
}

function set(next: UsageDemoKey | null) {
  forced = next;
  window.dispatchEvent(new Event(USAGE_DEMO_EVENT));
}

function isKey(value: string): value is UsageDemoKey {
  return value in USAGE_DEMO_FIXTURES;
}

export function registerUsagePanelDemo() {
  if (typeof window === "undefined") return;
  (window as unknown as Record<string, unknown>).__usageDemo = (
    name?: UsageDemoKey | "off" | false,
  ) => {
    if (name === false || name === "off") {
      set(null);
      return "Usage demo off. Showing the real session path.";
    }
    if (name === undefined) {
      return [
        `In the agent, then: __usageDemo("${USAGE_DEMO_ORDER[0]}")`,
        `States: "${USAGE_DEMO_ORDER.join('", "')}"`,
        '__usageDemo("off") to reset.',
        forced ? `Currently showing: ${forced}` : "Currently: real data.",
      ].join("\n");
    }
    if (!isKey(name)) {
      return `Unknown state "${name}". Try ${USAGE_DEMO_ORDER.join(", ")}, off.`;
    }
    set(name);
    return `Usage showing "${USAGE_DEMO_FIXTURES[name].label}". __usageDemo("off") to reset.`;
  };
}
