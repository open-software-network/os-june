import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  NoteFailureBanner,
  classifyFailure,
  userFacingFailureMessage,
} from "../components/note-editor/NoteFailureBanner";

describe("classifyFailure", () => {
  it("treats June's low-balance message as a balance issue", () => {
    expect(classifyFailure("Your balance is too low. Upgrade to continue.")).toBe("balance_low");
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
    expect(userFacingFailureMessage("Microphone: upstream_provider_failed; no_speech")).toBe(
      "Microphone: No speech detected. Try speaking louder or moving closer to the microphone.",
    );
  });

  it("hides raw JSON parser failures from saved notes", () => {
    expect(userFacingFailureMessage("expected value at line 1 column 1")).toBe(
      "The processing service returned an invalid response.",
    );
    expect(userFacingFailureMessage("Microphone: expected value at line 1 column 1")).toBe(
      "Microphone: The processing service returned an invalid response.",
    );
  });

  it("turns authorization denials into retry guidance", () => {
    expect(userFacingFailureMessage("authorization_denied")).toBe(
      "The service is busy right now. Wait a minute, then retry.",
    );
    expect(userFacingFailureMessage("Microphone: authorization_denied")).toBe(
      "Microphone: The service is busy right now. Wait a minute, then retry.",
    );
  });
});

describe("NoteFailureBanner", () => {
  it("offers Upgrade + Retry when the balance is too low", async () => {
    const onTopUp = vi.fn();
    const onRetry = vi.fn();
    render(
      <NoteFailureBanner
        errorMessage="Your balance is too low. Upgrade to continue."
        audioPreserved
        onRetry={onRetry}
        onTopUp={onTopUp}
      />,
    );
    // No title — one sentence carries the failure and the reassurance.
    expect(
      screen.getByText(/Your balance ran out\. Your recording is saved locally/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Upgrade/i }));
    expect(onTopUp).toHaveBeenCalledOnce();

    await userEvent.click(screen.getByRole("button", { name: /Retry/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("offers Top up credits + Retry with subscribed-user copy", async () => {
    const onTopUp = vi.fn();
    render(
      <NoteFailureBanner
        errorMessage="insufficient_credits"
        audioPreserved
        onRetry={() => undefined}
        onTopUp={onTopUp}
        topUpLabel="Top up credits"
      />,
    );

    expect(screen.getByText(/so top up credits and retry/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Upgrade/i })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Top up credits" }));
    expect(onTopUp).toHaveBeenCalledOnce();
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
    expect(screen.queryByRole("button", { name: /Upgrade/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/i })).toBeEnabled();
    expect(screen.getByText(/Your recording is saved locally/i)).toBeInTheDocument();
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
    expect(screen.queryByText(/upstream_provider_failed/i)).not.toBeInTheDocument();
  });

  it("shows a billing message for metering provider failures", () => {
    render(
      <NoteFailureBanner
        errorMessage="Microphone: metering_provider_failed"
        audioPreserved
        onRetry={() => undefined}
        onTopUp={() => undefined}
      />,
    );

    expect(screen.getByText(/Billing is temporarily unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/metering_provider_failed/i)).not.toBeInTheDocument();
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
