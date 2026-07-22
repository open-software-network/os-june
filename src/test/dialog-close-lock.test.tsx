import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Dialog } from "../components/ui/Dialog";

describe("Dialog close lock", () => {
  it("keeps DOM focus inside the dialog when closeDisabled toggles while open", () => {
    // Regression: adding closeDisabled to the keydown effect deps tore the
    // effect down (and refocused `previousFocus` in its cleanup) every time
    // the close lock toggled while the dialog stayed open. With focus back on
    // the row behind an aria-modal dialog, Tab walked the settings page.
    const externalButton = document.createElement("button");
    externalButton.textContent = "Outside trigger";
    document.body.appendChild(externalButton);
    externalButton.focus();
    expect(document.activeElement).toBe(externalButton);

    const onClosed = vi.fn();
    let closeDisabled = false;

    // Render with closeDisabled=false, then re-render with true and false
    // again while the dialog stays open, and assert focus never returns to
    // the external button behind the modal.
    const { rerender } = render(
      <Dialog
        open
        onClose={onClosed}
        title="Lock test"
        closeDisabled={closeDisabled}
        footer={<button type="button">Footer action</button>}
      >
        <p>Body</p>
      </Dialog>,
    );

    const dialog = screen.getByRole("dialog", { name: "Lock test" });
    // On open, the Dialog focuses the first focusable inside the card.
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Toggle the close lock on (e.g. OAuth in flight) and back off (e.g.
    // OAuth failed, dialog stays open). Focus must stay inside the dialog,
    // not bounce back to the external trigger behind the modal.
    closeDisabled = true;
    rerender(
      <Dialog
        open
        onClose={onClosed}
        title="Lock test"
        closeDisabled={closeDisabled}
        footer={<button type="button">Footer action</button>}
      >
        <p>Body</p>
      </Dialog>,
    );
    expect(dialog.contains(document.activeElement)).toBe(true);

    closeDisabled = false;
    rerender(
      <Dialog
        open
        onClose={onClosed}
        title="Lock test"
        closeDisabled={closeDisabled}
        footer={<button type="button">Footer action</button>}
      >
        <p>Body</p>
      </Dialog>,
    );
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(externalButton.contains(document.activeElement)).toBe(false);

    document.body.removeChild(externalButton);
  });
});
