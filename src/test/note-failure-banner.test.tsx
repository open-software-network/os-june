import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  NoteFailureBanner,
  classifyFailure,
} from "../components/note-editor/NoteFailureBanner";

describe("classifyFailure", () => {
  it("treats Scribe's low-balance message as a balance issue", () => {
    expect(
      classifyFailure("Your balance is too low. Add funds to continue."),
    ).toBe("balance_low");
  });

  it("also matches the structured error code if it leaks through", () => {
    expect(classifyFailure("insufficient_credits")).toBe("balance_low");
  });

  it("falls back to generic for unknown failures", () => {
    expect(classifyFailure("network timeout")).toBe("generic");
    expect(classifyFailure(undefined)).toBe("generic");
  });
});

describe("NoteFailureBanner", () => {
  it("offers Add funds + Retry when the balance is too low", async () => {
    const onTopUp = vi.fn();
    const onRetry = vi.fn();
    render(
      <NoteFailureBanner
        errorMessage="Your balance is too low. Add funds to continue."
        audioPreserved
        onRetry={onRetry}
        onTopUp={onTopUp}
      />,
    );
    expect(
      screen.getByRole("heading", { name: /Add funds to finish this note/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Your recording is saved locally/i),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Add funds/i }));
    expect(onTopUp).toHaveBeenCalledOnce();

    await userEvent.click(
      screen.getByRole("button", { name: /Retry transcription/i }),
    );
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("shows only Retry for generic failures and reassures audio is saved", () => {
    render(
      <NoteFailureBanner
        errorMessage="Network unreachable"
        audioPreserved
        onRetry={() => undefined}
        onTopUp={() => undefined}
      />,
    );
    expect(
      screen.getByRole("heading", { name: /Transcription failed/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Add funds/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Retry transcription/i }),
    ).toBeEnabled();
    expect(
      screen.getByText(/Your recording is saved locally/i),
    ).toBeInTheDocument();
  });

  it("guards against double-click while a retry is in flight", async () => {
    let resolveRetry: () => void = () => {};
    const onRetry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRetry = resolve;
        }),
    );
    render(
      <NoteFailureBanner
        errorMessage="Network unreachable"
        audioPreserved
        onRetry={onRetry}
        onTopUp={() => undefined}
      />,
    );

    const retryButton = screen.getByRole("button", {
      name: /Retry transcription/i,
    });
    await userEvent.click(retryButton);

    // Label flips, button is disabled, aria-busy reflects the state.
    expect(screen.getByRole("button", { name: /Retrying…/i })).toBeDisabled();
    expect(onRetry).toHaveBeenCalledTimes(1);

    // A second click while pending must not fire onRetry again.
    await userEvent.click(screen.getByRole("button", { name: /Retrying…/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    // Resolve so the test doesn't hang on cleanup.
    resolveRetry();
  });

  it("disables Retry when no audio is preserved (e.g., recording itself failed)", () => {
    render(
      <NoteFailureBanner
        errorMessage="Recording sources not ready"
        audioPreserved={false}
        onRetry={() => undefined}
        onTopUp={() => undefined}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Retry transcription/i }),
    ).toBeDisabled();
  });
});
