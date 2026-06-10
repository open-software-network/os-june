import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  NoteFailureBanner,
  classifyFailure,
  userFacingFailureMessage,
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

describe("userFacingFailureMessage", () => {
  it("turns no-speech provider codes into useful guidance", () => {
    expect(
      userFacingFailureMessage(
        "Microphone: upstream_provider_failed; no_speech",
      ),
    ).toBe(
      "Microphone: No speech detected. Try speaking louder or moving closer to the microphone.",
    );
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
    // No title — one sentence carries the failure and the reassurance.
    expect(
      screen.getByText(
        /Your balance ran out\. Your recording is saved locally/i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Add funds/i }));
    expect(onTopUp).toHaveBeenCalledOnce();

    await userEvent.click(screen.getByRole("button", { name: /Retry/i }));
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
    expect(screen.getByText(/Network unreachable/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Add funds/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/i })).toBeEnabled();
    expect(
      screen.getByText(/Your recording is saved locally/i),
    ).toBeInTheDocument();
  });

  it("shows a friendly message for no-speech transcription failures", () => {
    render(
      <NoteFailureBanner
        errorMessage="Microphone: upstream_provider_failed; no_speech"
        audioPreserved
        onRetry={() => undefined}
        onTopUp={() => undefined}
      />,
    );

    expect(screen.getByText(/No speech detected/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/upstream_provider_failed/i),
    ).not.toBeInTheDocument();
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

    const retryButton = screen.getByRole("button", { name: /Retry/i });
    await userEvent.click(retryButton);

    // Button disables while the retry is in flight; aria-busy reflects it.
    expect(screen.getByRole("button", { name: /Retry/i })).toBeDisabled();
    expect(onRetry).toHaveBeenCalledTimes(1);

    // A second click while pending must not fire onRetry again.
    await userEvent.click(screen.getByRole("button", { name: /Retry/i }));
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
    expect(screen.getByRole("button", { name: /Retry/i })).toBeDisabled();
  });
});
