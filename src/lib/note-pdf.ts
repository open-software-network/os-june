/**
 * Open the platform print sheet with a useful default PDF filename.
 *
 * The native macOS print sheet exposes Save as PDF, while browsers expose
 * their equivalent PDF destination. `window.print()` blocks until that sheet
 * closes, so the app title can be restored immediately afterwards.
 */
type ExportNoteAsPdfOptions = {
  showNotes?: () => void | Promise<void>;
  waitForPaint?: () => void | Promise<void>;
  print?: () => void;
};

export async function exportNoteAsPdf(
  noteTitle: string,
  {
    showNotes,
    waitForPaint = () =>
      new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())),
    print = () => window.print(),
  }: ExportNoteAsPdfOptions = {},
) {
  if (showNotes) {
    await showNotes();
    await waitForPaint();
  }

  const previousTitle = document.title;
  document.title = noteTitle.trim() || "Meeting notes";

  try {
    print();
  } finally {
    document.title = previousTitle;
  }
}
