import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HERMES_TUI_DEBUG_WARNING,
  buildHermesTuiResumeArgs,
  hermesTuiDebugAvailable,
  hermesTuiDebugTraceLine,
  resolveHermesTuiDebugLaunch,
} from "../lib/hermes-tui-debug";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildHermesTuiResumeArgs — pure CLI argument construction", () => {
  it("builds `--tui --resume <id>` for the modern TUI by default", () => {
    expect(buildHermesTuiResumeArgs({ sessionId: "sess-42" })).toEqual([
      "--tui",
      "--resume",
      "sess-42",
    ]);
  });

  it("forces the classic REPL with --cli when interface is repl", () => {
    expect(
      buildHermesTuiResumeArgs({ sessionId: "sess-42", interface: "repl" }),
    ).toEqual(["--cli", "--resume", "sess-42"]);
  });

  it("resumes by the exact June session id, never a title", () => {
    // The whole trace link depends on --resume taking the session ID so the
    // raw TUI session and the June session are provably the same one.
    const args = buildHermesTuiResumeArgs({ sessionId: "abc-123-def" });
    const resumeIndex = args.indexOf("--resume");
    expect(args[resumeIndex + 1]).toBe("abc-123-def");
  });

  it("trims surrounding whitespace from the session id", () => {
    expect(buildHermesTuiResumeArgs({ sessionId: "  sess-42 " })).toEqual([
      "--tui",
      "--resume",
      "sess-42",
    ]);
  });

  it("rejects an empty or whitespace-only session id", () => {
    expect(() => buildHermesTuiResumeArgs({ sessionId: "" })).toThrow();
    expect(() => buildHermesTuiResumeArgs({ sessionId: "   " })).toThrow();
  });

  it("does NOT encode the mode in the args (the sandbox is applied at spawn)", () => {
    // Mode must never leak in as a flag like --yolo: the per-session
    // sandboxed/unrestricted split is enforced by the Seatbelt wrapper on the
    // Rust spawn, exactly like the dashboard. The args are mode-independent.
    const sandboxed = buildHermesTuiResumeArgs({ sessionId: "s1" });
    expect(sandboxed).not.toContain("--yolo");
    expect(sandboxed).not.toContain("--safe-mode");
  });
});

describe("resolveHermesTuiDebugLaunch — session/profile/mode mapping", () => {
  it("maps an unrestricted session to the unrestricted mode", () => {
    const launch = resolveHermesTuiDebugLaunch({
      sessionId: "sess-1",
      unrestricted: true,
    });
    expect(launch.mode).toBe("unrestricted");
    expect(launch.sessionId).toBe("sess-1");
    expect(launch.args).toEqual(["--tui", "--resume", "sess-1"]);
  });

  it("maps a sandboxed session to the sandboxed mode (the safe default)", () => {
    const launch = resolveHermesTuiDebugLaunch({
      sessionId: "sess-2",
      unrestricted: false,
    });
    expect(launch.mode).toBe("sandboxed");
  });

  it("defaults to sandboxed when the opt-in is unknown", () => {
    const launch = resolveHermesTuiDebugLaunch({ sessionId: "sess-3" });
    expect(launch.mode).toBe("sandboxed");
  });

  it("carries a trace line tying the raw TUI session to the June session", () => {
    const launch = resolveHermesTuiDebugLaunch({
      sessionId: "sess-9",
      unrestricted: true,
    });
    expect(launch.traceLine).toContain("sess-9");
    expect(launch.traceLine.toLowerCase()).toContain("unrestricted");
  });
});

describe("hermesTuiDebugTraceLine — the session->TUI trace mapping", () => {
  it("names both the June session id and the mode", () => {
    const line = hermesTuiDebugTraceLine({
      sessionId: "june-sess-7",
      mode: "sandboxed",
    });
    expect(line).toContain("june-sess-7");
    expect(line.toLowerCase()).toContain("sandboxed");
  });
});

describe("hermesTuiDebugAvailable — dev-only gating", () => {
  it("is available in dev builds", () => {
    vi.stubEnv("DEV", true);
    expect(hermesTuiDebugAvailable()).toBe(true);
  });

  it("is hidden in production builds", () => {
    vi.stubEnv("DEV", false);
    expect(hermesTuiDebugAvailable()).toBe(false);
  });
});

describe("HERMES_TUI_DEBUG_WARNING — debug-tool, not primary UX", () => {
  it("warns this is a developer fallback, not June's UI", () => {
    expect(HERMES_TUI_DEBUG_WARNING.toLowerCase()).toContain("debug");
  });

  it("uses no en/em dashes (project copy rule)", () => {
    expect(HERMES_TUI_DEBUG_WARNING).not.toMatch(/[–—]/);
  });
});
