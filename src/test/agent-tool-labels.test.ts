import { describe, expect, it } from "vitest";
import {
  humanizeToolName,
  toolActivityLabel,
  toolActivitySentence,
} from "../lib/agent-tool-labels";

describe("toolActivityLabel", () => {
  it("replaces generic terminal labels with the command activity", () => {
    expect(toolActivityLabel("terminal")).toBe("Running command");
    expect(
      toolActivityLabel("terminal", {
        command: "curl https://example.com/docs",
      }),
    ).toBe("Browsing");
    expect(toolActivityLabel("shell", { command: "rg -n Terminal src" })).toBe("Searching files");
  });

  it("labels common web and file tools by intent", () => {
    expect(toolActivityLabel("web.run", { search_query: [{ q: "June status" }] })).toBe(
      "Searching web",
    );
    expect(toolActivityLabel("fetch_url", { url: "https://example.com" })).toBe("Browsing");
    expect(toolActivityLabel("read_file", { path: "src/App.tsx" })).toBe("Reading files");
    expect(toolActivityLabel("write_file", { path: "src/App.tsx" })).toBe("Editing files");
  });

  it("keeps an understandable fallback for unknown tools", () => {
    expect(humanizeToolName("custom_deploy_tool")).toBe("Custom deploy tool");
    expect(toolActivityLabel("custom_deploy_tool")).toBe("Custom deploy tool");
  });

  it("composes activity labels as standalone status sentences", () => {
    expect(toolActivitySentence("read_file")).toBe("Reading files.");
    expect(toolActivitySentence("gh")).toBe("Using GitHub.");
    expect(toolActivitySentence(undefined)).toBe("Using a tool.");
  });
});
