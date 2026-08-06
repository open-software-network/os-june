import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ReportDialog } from "../components/agent/ReportDialog";

const mocks = vi.hoisted(() => ({ submitIssueReport: vi.fn() }));

vi.mock("../lib/tauri", () => ({ submitIssueReport: mocks.submitIssueReport }));

describe("ReportDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.submitIssueReport.mockResolvedValue({ received: true });
  });

  it("submits the selected session so native diagnostics can be attached", async () => {
    const user = userEvent.setup();
    render(
      <ReportDialog
        category="bug"
        storedSessionId="session-failed"
        onCategoryChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "Description" }), "Clovy stopped");
    await user.click(screen.getByRole("button", { name: "Send report" }));

    await waitFor(() =>
      expect(mocks.submitIssueReport).toHaveBeenCalledWith({
        category: "bug",
        description: "Clovy stopped",
        attachmentNames: [],
        attachmentPaths: [],
        storedSessionId: "session-failed",
      }),
    );
    expect(await screen.findByText(/Your report was sent to the Clovy team/)).toBeVisible();
  });

  it("lets the user omit generated failure diagnostics", async () => {
    const user = userEvent.setup();
    render(
      <ReportDialog
        category="bug"
        storedSessionId="session-failed"
        onCategoryChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: /Include recent failure details/ }));
    await user.type(screen.getByRole("textbox", { name: "Description" }), "Clovy stopped");
    await user.click(screen.getByRole("button", { name: "Send report" }));

    await waitFor(() =>
      expect(mocks.submitIssueReport).toHaveBeenCalledWith({
        category: "bug",
        description: "Clovy stopped",
        attachmentNames: [],
        attachmentPaths: [],
      }),
    );
  });
});
