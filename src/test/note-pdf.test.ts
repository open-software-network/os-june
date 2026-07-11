import { describe, expect, it, vi } from "vitest";

import { exportNoteAsPdf } from "../lib/note-pdf";

describe("note PDF export", () => {
  it("uses the note title while opening the print sheet and restores the app title", () => {
    document.title = "June";
    const print = vi.fn(() => expect(document.title).toBe("Weekly sync"));

    exportNoteAsPdf("  Weekly sync  ", print);

    expect(print).toHaveBeenCalledTimes(1);
    expect(document.title).toBe("June");
  });

  it("uses a readable filename for untitled notes", () => {
    const print = vi.fn(() => expect(document.title).toBe("Meeting notes"));

    exportNoteAsPdf("   ", print);
  });
});
