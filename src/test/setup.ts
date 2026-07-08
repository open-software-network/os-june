import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { MotionGlobalConfig } from "framer-motion";
import { createElement } from "react";
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
//
// The app mounts the toast host once in the App shell, but component tests
// render surfaces (e.g. AgentWorkspace) without it. Mount a Toaster per test via
// RTL's own render so the existing cleanup() tears it down between tests: sonner
// portals toasts to document.body (so `screen` queries still find them), and
// unmounting the Toaster removes that portal synchronously — no toast lingers
// into the next test's queries. Surface-fired toasts also carry stable ids
// (model switch, branch, issue-report sent, busy) so a re-fire updates one toast
// in place rather than stacking a duplicate node.
beforeEach(() => {
  setNavigatorPlatform("MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)");
  markOnboardingComplete();
  render(createElement(Toaster));
});

afterEach(() => {
  toast.dismiss();
  cleanup();
});
