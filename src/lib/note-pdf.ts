/**
 * Open the platform print sheet with a useful default PDF filename.
 *
 * The native macOS print sheet exposes Save as PDF, while browsers expose
 * their equivalent PDF destination. `window.print()` blocks until that sheet
 * closes, so the app title can be restored immediately afterwards.
 */
export function exportNoteAsPdf(noteTitle: string, print = () => window.print()) {
  const previousTitle = document.title;
  document.title = noteTitle.trim() || "Meeting notes";

  try {
    print();
  } finally {
    document.title = previousTitle;
  }
}
