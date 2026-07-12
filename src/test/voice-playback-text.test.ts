import { describe, expect, it } from "vitest";
import {
  speakableVoiceText,
  StreamingVoiceText,
  voiceTextChunks,
} from "../lib/voice-playback-text";

describe("speakableVoiceText", () => {
  it("strips markdown down to speakable prose", () => {
    const markdown = [
      "## Summary",
      "",
      "The fix is **ready** and `pnpm test` passes. See [the docs](https://example.com).",
    ].join("\n");

    expect(speakableVoiceText(markdown)).toBe(
      "Summary\nThe fix is ready and pnpm test passes. See the docs.",
    );
  });

  it("drops fenced code, images, HTML, and hidden request tokens", () => {
    const markdown = [
      "Before.",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "[REQUEST:AGENT_CLI_ACCESS] <details>secret</details> After. ![diagram](a.png)",
      "MEDIA:/Users/alex/private/reference.png",
    ].join("\n");

    expect(speakableVoiceText(markdown)).toBe("Before.\nsecret After.");
  });

  it("reads table rows as comma-separated cells", () => {
    const markdown = "| Item | Status |\n| --- | --- |\n| Build | green |";
    expect(speakableVoiceText(markdown)).toBe("Item, Status\nBuild, green");
  });
});

describe("voiceTextChunks", () => {
  it("keeps short sentences together and splits before the size cap", () => {
    expect(voiceTextChunks("One. Two. Three.")).toEqual(["One. Two. Three."]);

    const sentence = `${"word ".repeat(45).trim()}.`;
    expect(voiceTextChunks(`${sentence} ${sentence}`)).toEqual([sentence, sentence]);
  });

  it("bounds a punctuation-free sentence without losing or reordering words", () => {
    const text = Array.from({ length: 400 }, (_, index) => `word${index}`).join(" ");
    const chunks = voiceTextChunks(text);

    expect(chunks.every((chunk) => [...chunk].length <= 1_000)).toBe(true);
    expect(chunks.join(" ")).toBe(text);
  });

  it("hard-splits a huge single token without losing characters", () => {
    const text = `a${"🙂".repeat(1_300)}${"unbroken".repeat(400)}`;
    const chunks = voiceTextChunks(text);

    expect(chunks.every((chunk) => [...chunk].length <= 1_000)).toBe(true);
    expect(chunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
    expect(chunks.every((chunk) => !/^[\uDC00-\uDFFF]/.test(chunk))).toBe(true);
    expect(chunks.join("")).toBe(text);
  });
});

describe("StreamingVoiceText", () => {
  it("emits complete sentences and flushes the final tail", () => {
    const stream = new StreamingVoiceText();

    expect(stream.push("Hello wor")).toEqual([]);
    expect(stream.push("Hello world. The final tail")).toEqual(["Hello world."]);
    expect(stream.flush("Hello world. The final tail")).toEqual(["The final tail"]);
  });

  it("never emits text from an open or completed code fence", () => {
    const stream = new StreamingVoiceText();
    const open = "Look here.\n```\nlet x = 1. let y = 2.\n";
    expect(stream.push(open)).toEqual(["Look here."]);

    const closed = `${open}\`\`\`\nDone. More`;
    expect(stream.push(closed)).toEqual(["Done."]);
  });
});
