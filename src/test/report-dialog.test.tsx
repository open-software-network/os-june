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

  // JUN-238: two videos attached, one registered. Every attached file's name
  // and path must ride in the submit payload.
  it("submits every attached file when multiple files are attached", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initialAttachments={[
          {
            id: "clip-a",
            name: "clip-a.mov",
            path: "/workspace/clip-a.mov",
          },
          {
            id: "clip-b",
            name: "clip-b.mp4",
            path: "/workspace/clip-b.mp4",
          },
        ]}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "Description" }), "Both videos matter");
    await user.click(screen.getByRole("button", { name: "Send report" }));

    await waitFor(() =>
      expect(mocks.submitIssueReport).toHaveBeenCalledWith({
        category: "bug",
        description: "Both videos matter",
        attachmentNames: ["clip-a.mov", "clip-b.mp4"],
        attachmentPaths: ["/workspace/clip-a.mov", "/workspace/clip-b.mp4"],
      }),
    );
  });

  it("names files that could not be attached in Open Software", async () => {
    const user = userEvent.setup();
    mocks.submitIssueReport.mockResolvedValue({
      received: true,
      skippedAttachmentNames: ["huge.mov"],
    });
    render(<Harness initialDescription="Recorder bug" />);

    await user.click(screen.getByRole("button", { name: "Send report" }));

    expect(await screen.findByText(/Your report was sent to the June team/)).toBeInTheDocument();
    expect(
      screen.getByText(
        /These files could not be attached to the report in Open Software and were sent by name only: huge.mov/,
      ),
    ).toBeInTheDocument();
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

  it("routes all nine valid dropped files through the provided import callback", () => {
    const onDropFiles = vi.fn();
    render(<Harness onDropFiles={onDropFiles} />);
    const files = Array.from(
      { length: 9 },
      (_, index) => new File([`log-${index + 1}`], `june-${index + 1}.log`),
    );

    fireEvent.drop(screen.getByRole("textbox", { name: "Description" }), {
      dataTransfer: { files },
    });

    expect(onDropFiles).toHaveBeenCalledWith(files);
  });

  it("rejects files that would exceed the 20-attachment report limit", () => {
    const onDropFiles = vi.fn();
    const existingAttachments = Array.from({ length: 19 }, (_, index) => ({
      id: `existing-${index}`,
      name: `existing-${index}.txt`,
      path: `/workspace/existing-${index}.txt`,
    }));
    render(<Harness initialAttachments={existingAttachments} onDropFiles={onDropFiles} />);
    const files = [new File(["a"], "a.txt"), new File(["b"], "b.txt")];

    fireEvent.drop(screen.getByRole("textbox", { name: "Description" }), {
      dataTransfer: { files },
    });

    expect(onDropFiles).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Reports can include up to 20 attachments. Remove attachments before adding these files.",
    );
  });

  it("disables submission when a native selection contains more than 20 attachments", () => {
    const attachments = Array.from({ length: 21 }, (_, index) => ({
      id: `native-${index}`,
      name: `native-${index}.mov`,
      path: `/Users/alex/Desktop/native-${index}.mov`,
    }));

    render(<Harness initialAttachments={attachments} />);

    expect(screen.getByRole("button", { name: "Send report" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Remove at least 1 attachment before sending.",
    );
  });

  it("rejects oversized Finder drops before importing and points to Add files", () => {
    const onDropFiles = vi.fn();
    render(<Harness onDropFiles={onDropFiles} />);
    const file = new File(["video"], "large.mov", { type: "video/quicktime" });
    Object.defineProperty(file, "size", { value: 50 * 1024 * 1024 + 1 });

    fireEvent.drop(screen.getByRole("textbox", { name: "Description" }), {
      dataTransfer: { files: [file] },
    });

    expect(onDropFiles).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Use Add files for videos up to 300 MB.");
  });

  it("routes pasted images through the import callback and leaves text pastes alone", () => {
    const onDropFiles = vi.fn();
    render(<Harness onDropFiles={onDropFiles} />);
    const textarea = screen.getByRole("textbox", { name: "Description" });
    const image = new File(["png-bytes"], "", { type: "image/png" });

    const defaultNotPrevented = fireEvent.paste(textarea, {
      clipboardData: { items: [], files: [image], getData: () => "" },
    });
    expect(onDropFiles).toHaveBeenCalledTimes(1);
    const [pasted] = onDropFiles.mock.calls[0][0];
    expect(pasted.name).toBe("pasted-image.png");
    // Image-only paste preventDefault's, so fireEvent returns false.
    expect(defaultNotPrevented).toBe(false);

    fireEvent.paste(textarea, {
      clipboardData: { items: [], files: [], getData: () => "" },
    });
    expect(onDropFiles).toHaveBeenCalledTimes(1);
  });

  it("imports the image but keeps the text on a mixed image-and-text paste", () => {
    const onDropFiles = vi.fn();
    render(<Harness onDropFiles={onDropFiles} />);
    const textarea = screen.getByRole("textbox", { name: "Description" });
    const image = new File(["png-bytes"], "", { type: "image/png" });

    const defaultNotPrevented = fireEvent.paste(textarea, {
      clipboardData: {
        items: [],
        files: [image],
        getData: () => "Steps to reproduce",
      },
    });

    expect(onDropFiles).toHaveBeenCalledTimes(1);
    // The browser inserts the pasted text normally: default must not be prevented.
    expect(defaultNotPrevented).toBe(true);
  });

  it("keeps drop and paste events inside the dialog", () => {
    const outerDrop = vi.fn();
    const outerPaste = vi.fn();
    render(
      <div onDrop={outerDrop} onPaste={outerPaste}>
        <Harness />
      </div>,
    );
    const textarea = screen.getByRole("textbox", { name: "Description" });
    const image = new File(["png"], "shot.png", { type: "image/png" });

    fireEvent.drop(textarea, { dataTransfer: { files: [image] } });
    fireEvent.paste(textarea, {
      clipboardData: { items: [], files: [image], getData: () => "" },
    });

    expect(outerDrop).not.toHaveBeenCalled();
    expect(outerPaste).not.toHaveBeenCalled();
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

  it("rejects a second drop while the first import batch is pending", () => {
    const onDropFiles = vi.fn(() => new Promise<void>(() => {}));
    render(<Harness initialDescription="Recorder bug" onDropFiles={onDropFiles} />);
    const textarea = screen.getByRole("textbox", { name: "Description" });
    const firstFile = new File(["first"], "first.log", { type: "text/plain" });
    const secondFile = new File(["second"], "second.log", { type: "text/plain" });

    fireEvent.drop(textarea, { dataTransfer: { files: [firstFile] } });
    fireEvent.drop(textarea, { dataTransfer: { files: [secondFile] } });

    expect(onDropFiles).toHaveBeenCalledTimes(1);
    expect(onDropFiles).toHaveBeenCalledWith([firstFile]);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Please wait for the current import or report submission to finish, then try again.",
    );
    const dataTransfer = { files: [], dropEffect: "copy" };
    fireEvent.dragOver(textarea, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe("none");
  });

  it("rejects a drop while report submission is pending", async () => {
    const user = userEvent.setup();
    const onDropFiles = vi.fn();
    mocks.submitIssueReport.mockImplementationOnce(() => new Promise(() => {}));
    render(<Harness initialDescription="Recorder bug" onDropFiles={onDropFiles} />);
    const textarea = screen.getByRole("textbox", { name: "Description" });

    await user.click(screen.getByRole("button", { name: "Send report" }));
    fireEvent.drop(textarea, {
      dataTransfer: { files: [new File(["late"], "late.log", { type: "text/plain" })] },
    });

    expect(onDropFiles).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Please wait for the current import or report submission to finish, then try again.",
    );
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
