import type { Editor } from "@tiptap/react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  COMPOSER_CHANGE_DELAY_MS,
  ComposerEditor,
  serializePlainText,
} from "../components/agent/composer/ComposerEditor";

afterEach(() => {
  vi.useRealTimers();
});

async function renderComposer(options: {
  onChange?: (text: string) => void;
  onContentChange?: (hasContent: boolean) => void;
  onSubmit?: () => void;
  onBuiltinSlashCommand?: () => boolean;
  serialize?: typeof serializePlainText;
  changeDelayMs?: number;
}) {
  let editor: Editor | null = null;
  render(
    <ComposerEditor
      placeholder="Message June"
      onChange={(text) => options.onChange?.(text)}
      onContentChange={options.onContentChange}
      onSubmit={() => options.onSubmit?.()}
      onBuiltinSlashCommand={options.onBuiltinSlashCommand}
      onReady={(readyEditor) => {
        editor = readyEditor;
      }}
      testOnlySerializePlainText={options.serialize}
      testOnlyChangeDelayMs={options.changeDelayMs}
    />,
  );
  await waitFor(() => expect(editor).not.toBeNull());
  return editor as unknown as Editor;
}

describe("composer change publishing", () => {
  it("bounds full-document serialization to one trailing call for a typing burst", async () => {
    const serialize = vi.fn(serializePlainText);
    const onChange = vi.fn();
    const editor = await renderComposer({ onChange, serialize });
    vi.useFakeTimers();

    act(() => {
      for (const character of "long prompt") {
        editor.commands.insertContent(character);
      }
    });

    expect(serialize).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(COMPOSER_CHANGE_DELAY_MS);
    });

    expect(serialize).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("long prompt");
  });

  it("updates sendability without serializing the document or counting whitespace", async () => {
    const serialize = vi.fn(serializePlainText);
    const onContentChange = vi.fn();
    const editor = await renderComposer({ serialize, onContentChange });
    vi.useFakeTimers();

    act(() => {
      editor.commands.insertContent("   ");
    });
    expect(onContentChange).not.toHaveBeenCalled();
    expect(serialize).not.toHaveBeenCalled();

    act(() => {
      editor.commands.insertContent("x");
    });
    expect(onContentChange).toHaveBeenLastCalledWith(true);
    expect(serialize).not.toHaveBeenCalled();
  });

  it("flushes the exact final text synchronously before Enter submits", async () => {
    const serialize = vi.fn(serializePlainText);
    let latestText = "";
    let submittedText = "";
    const editor = await renderComposer({
      serialize,
      onChange: (text) => {
        latestText = text;
      },
      onSubmit: () => {
        submittedText = latestText;
      },
    });
    vi.useFakeTimers();

    act(() => {
      editor.commands.insertContent("exact final text");
    });
    expect(serialize).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message June" }), {
      key: "Enter",
    });

    expect(serialize).toHaveBeenCalledTimes(1);
    expect(submittedText).toBe("exact final text");
  });

  it("flushes pending text before a slash-menu command reads composer state", async () => {
    const serialize = vi.fn(serializePlainText);
    let latestText = "";
    let slashMenuText = "";
    await renderComposer({
      serialize,
      changeDelayMs: 10_000,
      onChange: (text) => {
        latestText = text;
      },
      onBuiltinSlashCommand: () => {
        slashMenuText = latestText;
        return true;
      },
    });
    const user = userEvent.setup();

    await user.type(screen.getByRole("textbox", { name: "Message June" }), "/");
    expect(serialize).not.toHaveBeenCalled();

    fireEvent.mouseDown(screen.getByRole("option", { name: "Model" }));

    expect(serialize).toHaveBeenCalledTimes(1);
    expect(slashMenuText).toBe("/");
  });

  it("does not serialize an intermediate IME composition", async () => {
    const serialize = vi.fn(serializePlainText);
    const onChange = vi.fn();
    const editor = await renderComposer({ onChange, serialize });
    vi.useFakeTimers();
    const textbox = screen.getByRole("textbox", { name: "Message June" });

    fireEvent.compositionStart(textbox);
    act(() => {
      editor.commands.insertContent("編集中");
      vi.advanceTimersByTime(COMPOSER_CHANGE_DELAY_MS * 2);
    });

    expect(serialize).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.compositionEnd(textbox);
    act(() => {
      vi.advanceTimersByTime(COMPOSER_CHANGE_DELAY_MS * 2);
    });

    expect(serialize).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("編集中");
  });
});
