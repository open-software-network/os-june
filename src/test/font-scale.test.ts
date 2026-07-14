import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FONT_SCALE_CHANGED_EVENT,
  getStoredFontScale,
  initFontScale,
  installFontScaleShortcuts,
} from "../lib/font-scale";

describe("font scale shortcuts", () => {
  let uninstall: (() => void) | undefined;

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.removeProperty("--font-scale");
    initFontScale();
    uninstall = installFontScaleShortcuts();
  });

  afterEach(() => {
    uninstall?.();
  });

  it("zooms in through the supported text sizes with Command plus", () => {
    fireEvent.keyDown(window, { key: "+", code: "Equal", metaKey: true, shiftKey: true });
    expect(getStoredFontScale()).toBe("large");
    expect(document.documentElement.style.getPropertyValue("--font-scale")).toBe("1.1");

    fireEvent.keyDown(window, { key: "=", code: "Equal", metaKey: true });
    expect(getStoredFontScale()).toBe("larger");
    expect(document.documentElement.style.getPropertyValue("--font-scale")).toBe("1.2");

    fireEvent.keyDown(window, { key: "+", code: "Equal", metaKey: true, shiftKey: true });
    expect(getStoredFontScale()).toBe("larger");
  });

  it("zooms back out to the default and resets with Command zero", () => {
    fireEvent.keyDown(window, { key: "+", metaKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "+", metaKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "-", metaKey: true });
    expect(getStoredFontScale()).toBe("large");

    fireEvent.keyDown(window, { key: "0", metaKey: true });
    expect(getStoredFontScale()).toBe("default");
    expect(document.documentElement.style.getPropertyValue("--font-scale")).toBe("1");

    fireEvent.keyDown(window, { key: "-", metaKey: true });
    expect(getStoredFontScale()).toBe("default");
  });

  it("prevents the webview default and announces scale changes", () => {
    const changes: string[] = [];
    const onChange = (event: Event) => changes.push((event as CustomEvent<string>).detail);
    window.addEventListener(FONT_SCALE_CHANGED_EVENT, onChange);

    const zoomIn = new KeyboardEvent("keydown", {
      key: "+",
      metaKey: true,
      shiftKey: true,
      cancelable: true,
    });
    window.dispatchEvent(zoomIn);

    expect(zoomIn.defaultPrevented).toBe(true);
    expect(changes).toEqual(["large"]);
    window.removeEventListener(FONT_SCALE_CHANGED_EVENT, onChange);
  });

  it("ignores chords that are not standard zoom shortcuts", () => {
    fireEvent.keyDown(window, { key: "+", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "+", metaKey: true, altKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "z", code: "KeyZ", metaKey: true, shiftKey: true });
    expect(getStoredFontScale()).toBe("default");
  });

  it("recognizes physical zoom keys across keyboard layouts", () => {
    fireEvent.keyDown(window, { key: "´", code: "Equal", metaKey: true });
    expect(getStoredFontScale()).toBe("large");

    fireEvent.keyDown(window, { key: "à", code: "Digit0", metaKey: true, shiftKey: true });
    expect(getStoredFontScale()).toBe("default");

    fireEvent.keyDown(window, { key: "´", code: "Equal", metaKey: true });
    fireEvent.keyDown(window, { key: "/", code: "Minus", metaKey: true, shiftKey: true });
    expect(getStoredFontScale()).toBe("default");
  });

  it("uses Control instead of Command on Windows", () => {
    const platform = Object.getOwnPropertyDescriptor(navigator, "platform");
    const userAgent = Object.getOwnPropertyDescriptor(navigator, "userAgent");
    Object.defineProperty(navigator, "platform", { configurable: true, get: () => "Win32" });
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      get: () => "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    });

    try {
      fireEvent.keyDown(window, { key: "+", metaKey: true, shiftKey: true });
      expect(getStoredFontScale()).toBe("default");

      fireEvent.keyDown(window, { key: "+", ctrlKey: true, shiftKey: true });
      expect(getStoredFontScale()).toBe("large");
    } finally {
      if (platform) Object.defineProperty(navigator, "platform", platform);
      if (userAgent) Object.defineProperty(navigator, "userAgent", userAgent);
    }
  });

  it("keeps stepping and reset working when persistence fails", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage quota exceeded", "QuotaExceededError");
    });

    try {
      fireEvent.keyDown(window, { key: "+", metaKey: true, shiftKey: true });
      expect(getStoredFontScale()).toBe("large");
      expect(document.documentElement.style.getPropertyValue("--font-scale")).toBe("1.1");

      fireEvent.keyDown(window, { key: "+", metaKey: true, shiftKey: true });
      expect(getStoredFontScale()).toBe("larger");
      expect(document.documentElement.style.getPropertyValue("--font-scale")).toBe("1.2");

      fireEvent.keyDown(window, { key: "0", metaKey: true });
      expect(getStoredFontScale()).toBe("default");
      expect(document.documentElement.style.getPropertyValue("--font-scale")).toBe("1");
    } finally {
      setItem.mockRestore();
    }
  });

  it("retries snapshots after a transient storage read failure", () => {
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementationOnce(() => {
        throw new DOMException("Storage temporarily unavailable", "SecurityError");
      })
      .mockImplementation(() => "large");

    try {
      expect(getStoredFontScale()).toBe("default");
      expect(getStoredFontScale()).toBe("large");
      expect(document.documentElement.style.getPropertyValue("--font-scale")).toBe("1.1");
    } finally {
      getItem.mockRestore();
    }
  });
});
