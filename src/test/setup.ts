import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { MotionGlobalConfig } from "framer-motion";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, vi } from "vitest";
import { Toaster, toast } from "../components/ui/Toaster";
import { markOnboardingComplete } from "../lib/onboarding";

// Resolve framer-motion animations instantly. Without this the frameloop
// stalls when tests swap fake/real timers, leaving AnimatePresence exits
// stuck in the DOM and exit-dependent assertions flaky.
MotionGlobalConfig.skipAnimations = true;

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: vi.fn(async () => undefined),
}));

// jsdom ships no ResizeObserver; the SegmentedControl relies on one.
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (!document.elementFromPoint) {
  document.elementFromPoint = () => document.body;
}

if (!window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

if (
  !("localStorage" in globalThis) ||
  !globalThis.localStorage ||
  typeof globalThis.localStorage.clear !== "function"
) {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      get length() {
        return values.size;
      },
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, String(value)),
    },
  });
}

if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: function* () {},
    }) as DOMRectList;
}

if (!Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}

if (!HTMLElement.prototype.getClientRects) {
  HTMLElement.prototype.getClientRects = () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: function* () {},
    }) as DOMRectList;
}

if (!HTMLElement.prototype.getBoundingClientRect) {
  HTMLElement.prototype.getBoundingClientRect = () => new DOMRect();
}

function setNavigatorPlatform(platform: string, userAgent: string) {
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    get: () => platform,
  });
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    get: () => userAgent,
  });
}

// Existing App tests exercise the signed-in main shell; pre-complete the
// first-run onboarding so the wizard doesn't gate them. Onboarding tests
// opt back in by clearing localStorage.
beforeEach(() => {
  setNavigatorPlatform("MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)");
  markOnboardingComplete();
});

// The app mounts the toast host once in the App shell, but component tests
// render surfaces (e.g. AgentWorkspace) without it. Mount a single Toaster once,
// into its own host outside React Testing Library's container so cleanup()
// never unmounts it — any toast(...) a surface fires portals to document.body
// where `screen` queries can still find it. Mounting once (not per test) keeps
// zero per-test render churn, so timing-sensitive tests aren't perturbed.
// Surface-fired toasts carry stable ids (model switch, branch, issue-report
// sent, busy) so a toast re-fired in a later test updates the earlier one in
// place rather than stacking a duplicate node.
const toasterHost = document.createElement("div");
document.body.appendChild(toasterHost);
createRoot(toasterHost).render(createElement(Toaster));

// Clear any toasts a test left behind so they never leak into the next one.
afterEach(() => {
  toast.dismiss();
  cleanup();
});
