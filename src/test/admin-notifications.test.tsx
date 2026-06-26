import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AdminNotifications } from "../components/settings/AdminNotifications";
import type { AdminNotification } from "../lib/hermes-admin";

/** Build a durable admin notification with sensible defaults for the test. */
function note(overrides: Partial<AdminNotification> = {}): AdminNotification {
  return {
    id: "n1",
    message: "Saved. New sessions can use it.",
    timing: "next-session",
    mutation: "skill.toggle",
    at: 0,
    ...overrides,
  };
}

describe("AdminNotifications", () => {
  it("renders nothing when there are no notifications", () => {
    const { container } = render(
      <AdminNotifications notifications={[]} onDismiss={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders dismissible notices and reports the dismissed id", () => {
    const onDismiss = vi.fn();
    render(
      <AdminNotifications
        notifications={[note({ id: "n1", message: "Skill updated." })]}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getByText("Skill updated.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledWith("n1");
  });

  it("auto-dismisses a success notice like a toast but keeps an error", () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      render(
        <AdminNotifications
          notifications={[
            note({ id: "ok1", message: "Skill updated." }),
            note({
              id: "err1",
              message: "Could not update the skill.",
              isError: true,
            }),
          ]}
          onDismiss={onDismiss}
        />,
      );
      // Nothing auto-dismisses before the toast timeout.
      expect(onDismiss).not.toHaveBeenCalled();
      vi.advanceTimersByTime(5000);
      // The success notice cleared itself; the error was left for the user.
      expect(onDismiss).toHaveBeenCalledWith("ok1");
      expect(onDismiss).not.toHaveBeenCalledWith("err1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps visible notices at three, newest first", () => {
    render(
      <AdminNotifications
        notifications={[
          note({ id: "n1", message: "First." }),
          note({ id: "n2", message: "Second." }),
          note({ id: "n3", message: "Third." }),
          note({ id: "n4", message: "Fourth." }),
        ]}
        onDismiss={vi.fn()}
      />,
    );
    // Only three render, and the oldest (First.) is dropped.
    expect(screen.getAllByRole("status")).toHaveLength(3);
    expect(screen.queryByText("First.")).not.toBeInTheDocument();
    expect(screen.getByText("Fourth.")).toBeInTheDocument();
  });
});
