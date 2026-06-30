import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ErrorBanner } from "../components/ui/ErrorFeedbackNudge";
import {
  ERROR_FEEDBACK_REQUESTED_EVENT,
  type ErrorFeedbackRequestedDetail,
} from "../lib/error-feedback";

describe("Error feedback nudge", () => {
  it("reminds users that sessions are private and requests feedback", async () => {
    const user = userEvent.setup();
    const requests: ErrorFeedbackRequestedDetail[] = [];
    const onRequest = (event: Event) => {
      requests.push(
        (event as CustomEvent<ErrorFeedbackRequestedDetail>).detail,
      );
    };
    window.addEventListener(ERROR_FEEDBACK_REQUESTED_EVENT, onRequest);

    try {
      render(<ErrorBanner>Could not load routines.</ErrorBanner>);

      expect(screen.getByText("Could not load routines.")).toBeInTheDocument();
      expect(
        screen.getByText(/Your sessions stay private/i),
      ).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Send feedback" }));

      expect(requests).toEqual([{ category: "bug" }]);
    } finally {
      window.removeEventListener(ERROR_FEEDBACK_REQUESTED_EVENT, onRequest);
    }
  });
});
