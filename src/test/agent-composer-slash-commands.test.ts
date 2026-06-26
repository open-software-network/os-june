import { describe, expect, it } from "vitest";

import {
  parseBuiltinComposerSlashCommand,
  parseSlashFileArguments,
  resolveSlashModel,
  slashModelResolutionError,
} from "../lib/agent-composer-slash-commands";

describe("agent composer built-in slash commands", () => {
  it("parses reserved model and file commands", () => {
    expect(parseBuiltinComposerSlashCommand("/model kimi")).toEqual({
      name: "model",
      argument: "kimi",
    });
    expect(parseBuiltinComposerSlashCommand("  /file ./notes.md  ")).toEqual({
      name: "file",
      argument: "./notes.md",
    });
    expect(
      parseBuiltinComposerSlashCommand("/repo-build-pr fix it"),
    ).toBeNull();
    expect(
      parseBuiltinComposerSlashCommand(
        "/Users/alex/Desktop/report.pdf summarize",
      ),
    ).toBeNull();
  });

  it("parses quoted file paths", () => {
    expect(
      parseSlashFileArguments('"/Users/alex/Desktop/Q2 report.pdf" ./notes.md'),
    ).toEqual({
      status: "ok",
      paths: ["/Users/alex/Desktop/Q2 report.pdf", "./notes.md"],
    });
  });

  it("preserves quoted Windows file paths", () => {
    expect(
      parseSlashFileArguments('"C:\\Users\\alex\\Desktop\\Q2 report.pdf"'),
    ).toEqual({
      status: "ok",
      paths: ["C:\\Users\\alex\\Desktop\\Q2 report.pdf"],
    });
  });

  it("reports unmatched quotes without dropping the command", () => {
    expect(
      parseSlashFileArguments('"/Users/alex/Desktop/Q2 report.pdf'),
    ).toEqual({
      status: "error",
      message: "Could not parse /file paths. Close the quote and try again.",
    });
  });

  it("resolves model ids and friendly model names", () => {
    const models = [
      { id: "zai-org-glm-5-2", name: "GLM 5.2" },
      { id: "moonshotai-kimi-k2-6", name: "Kimi K2.6" },
    ];

    expect(resolveSlashModel("glm-5", models)).toEqual({
      status: "resolved",
      model: models[0],
    });
    expect(resolveSlashModel("moonshotai-kimi-k2-6", models)).toEqual({
      status: "resolved",
      model: models[1],
    });
  });

  it("reports ambiguous model aliases", () => {
    const resolution = resolveSlashModel("kimi", [
      { id: "provider-a-kimi", name: "Kimi base" },
      { id: "provider-b-kimi", name: "Kimi tuned" },
    ]);

    expect(resolution.status).toBe("ambiguous");
    if (resolution.status !== "resolved") {
      expect(slashModelResolutionError(resolution)).toBe(
        'Model "kimi" matches Kimi base, Kimi tuned. Type a longer name.',
      );
    }
  });
});
