import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ReportDialog, type ReportDialogAttachment } from "../components/agent/ReportDialog";
import type { ReportCategory } from "../components/agent/composer/reportCategory";

const mocks = vi.hoisted(() => ({
  submitIssueReport: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  submitIssueReport: mocks.submitIssueReport,
}));

function Harness({
  initialCategory = "bug",
  initialDescription = "",
  initialAttachments = [],
  onDropFiles = vi.fn(),
  onSent = vi.fn(),
  onClose = vi.fn(),
}: {
  initialCategory?: ReportCategory;
  initialDescription?: string;
  initialAttachments?: ReportDialogAttachment[];
  onDropFiles?: (files: File[]) => void;
  onSent?: () => void;
  onClose?: () => void;
}) {
  const [category, setCategory] = useState(initialCategory);
  const [description, setDescription] = useState(initialDescription);
  const [attachments, setAttachments] = useState(initialAttachments);

  return (
    <ReportDialog
      category={category}
      description={description}
      attachments={attachments}
      importingFiles={false}
      onCategoryChange={setCategory}
      onDescriptionChange={setDescription}
      onAddFiles={vi.fn()}
      onDropFiles={onDropFiles}
      onRemoveAttachment={(id) =>
        setAttachments((current) => current.filter((attachment) => attachment.id !== id))
      }
      onClose={onClose}
      onSent={onSent}
    />
  );
}

describe("ReportDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.submitIssueReport.mockResolvedValue({ received: true });
    if (typeof ResizeObserver === "undefined") {
      vi.stubGlobal(
        "ResizeObserver",
        class {
          observe() {}
          disconnect() {}
        },
      );
    }
  });

  it("renders all categories and honors preselection", () => {
    render(<Harness initialCategory="feedback" />);

    expect(screen.getByRole("button", { name: "Bug report" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Feedback" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Feature request" })).toBeInTheDocument();
  });

  it("disables submit while empty", () => {
    render(<Harness />);

    expect(screen.getByRole("button", { name: "Send report" })).toBeDisabled();
  });

  it("submits a direct issue report payload without session fields", async () => {
    const user = userEvent.setup();
    const onSent = vi.fn();
    render(
      <Harness
        initialCategory="feedback"
        initialAttachments={[
          {
            id: "trace",
            name: "trace.txt",
            path: "/workspace/trace.txt",
          },
        ]}
        onSent={onSent}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "Description" }), "Logs are noisy");
    await user.click(screen.getByRole("button", { name: "Send report" }));

    await waitFor(() =>
      expect(mocks.submitIssueReport).toHaveBeenCalledWith({
        category: "feedback",
        description: "Logs are noisy",
        attachmentNames: ["trace.txt"],
        attachmentPaths: ["/workspace/trace.txt"],
      }),
    );
    const payload = mocks.submitIssueReport.mock.calls[0]?.[0];
    expect(payload).not.toHaveProperty("sessionId");
    expect(payload).not.toHaveProperty("agentDiagnosis");
    expect(onSent).toHaveBeenCalledTimes(1);
  });

  it("shows the confirmation in the dialog after sending and closes via Done", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness initialDescription="Recorder bug" onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "Send report" }));

    expect(await screen.findByText(/Your report was sent to the June team/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Description" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("uses the shared fallback description for attachments-only reports", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initialCategory="feature"
        initialAttachments={[
          {
            id: "mockup",
            name: "mockup.png",
            path: "/workspace/mockup.png",
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Send report" }));

    await waitFor(() =>
      expect(mocks.submitIssueReport).toHaveBeenCalledWith({
        category: "feature",
        description: "No description was typed; see the attachments.",
        attachmentNames: ["mockup.png"],
        attachmentPaths: ["/workspace/mockup.png"],
      }),
    );
  });

  it("routes dropped files through the provided import callback", () => {
    const onDropFiles = vi.fn();
    render(<Harness onDropFiles={onDropFiles} />);
    const file = new File(["log"], "june.log", { type: "text/plain" });

    fireEvent.drop(screen.getByRole("textbox", { name: "Description" }), {
      dataTransfer: { files: [file] },
    });

    expect(onDropFiles).toHaveBeenCalledWith([file]);
  });

  it("blocks submit while a dropped file is still importing", async () => {
    let resolveImport: () => void = () => {};
    const onDropFiles = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveImport = resolve;
        }),
    );
    render(<Harness initialDescription="Recorder bug" onDropFiles={onDropFiles} />);
    const file = new File(["log"], "june.log", { type: "text/plain" });

    fireEvent.drop(screen.getByRole("textbox", { name: "Description" }), {
      dataTransfer: { files: [file] },
    });

    const submit = screen.getByRole("button", { name: "Send report" });
    expect(submit).toBeDisabled();
    resolveImport();
    await waitFor(() => expect(submit).toBeEnabled());
    expect(mocks.submitIssueReport).not.toHaveBeenCalled();
  });

  it("keeps the dialog open with the typed input after a submit failure", async () => {
    const user = userEvent.setup();
    mocks.submitIssueReport.mockRejectedValueOnce(new Error("Network down"));
    render(<Harness />);

    const textarea = screen.getByRole("textbox", { name: "Description" });
    await user.type(textarea, "The report should retry");
    await user.click(screen.getByRole("button", { name: "Send report" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The issue report could not be sent. Network down",
    );
    expect(screen.getByRole("dialog", { name: "Issue report" })).toBeInTheDocument();
    expect(textarea).toHaveValue("The report should retry");
  });
});
