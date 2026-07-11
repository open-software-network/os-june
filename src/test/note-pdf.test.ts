import { describe, expect, it, vi } from "vitest";

import { exportNoteAsPdf } from "../lib/note-pdf";

describe("note PDF export", () => {
  it("uses the note title while opening the print sheet and restores the app title", async () => {
    document.title = "June";
    const print = vi.fn(() => expect(document.title).toBe("Weekly sync"));

    await exportNoteAsPdf("  Weekly sync  ", { print });

    expect(print).toHaveBeenCalledTimes(1);
    expect(document.title).toBe("June");
  });

  it("uses a readable filename for untitled notes", async () => {
    const print = vi.fn(() => expect(document.title).toBe("Meeting notes"));

    await exportNoteAsPdf("   ", { print });
  });

  it("renders the formatted notes view before printing", async () => {
    const order: string[] = [];

    await exportNoteAsPdf("Weekly sync", {
      showNotes: async () => {
        order.push("show notes");
      },
      waitForPaint: () => {
        order.push("paint");
      },
      print: () => {
        order.push("print");
      },
    });

    expect(order).toEqual(["show notes", "paint", "print"]);
  });
});
