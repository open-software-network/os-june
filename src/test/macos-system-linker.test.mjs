import { describe, expect, it } from "vitest";
import { rewriteMacOSLinkerArgs, splitLinkerCommand } from "../../scripts/macos-system-linker.mjs";

describe("macOS system linker", () => {
  it("replaces direct libdispatch links with System.framework", () => {
    expect(rewriteMacOSLinkerArgs(["input.o", "-ldispatch", "-lobjc", "-ldispatch"])).toEqual([
      "input.o",
      "-framework",
      "System",
      "-lobjc",
      "-framework",
      "System",
    ]);
  });

  it("preserves unrelated linker arguments", () => {
    expect(rewriteMacOSLinkerArgs(["-arch", "arm64", "-framework", "AppKit"])).toEqual([
      "-arch",
      "arm64",
      "-framework",
      "AppKit",
    ]);
  });

  it("splits CC-style linker values into command and flags", () => {
    expect(splitLinkerCommand("ccache clang")).toEqual({ command: "ccache", args: ["clang"] });
    expect(splitLinkerCommand("clang -arch arm64")).toEqual({
      command: "clang",
      args: ["-arch", "arm64"],
    });
    expect(splitLinkerCommand("/usr/bin/clang")).toEqual({ command: "/usr/bin/clang", args: [] });
  });
});
