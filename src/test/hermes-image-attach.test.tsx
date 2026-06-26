import { describe, expect, it, vi } from "vitest";
import type { ImportedHermesFile } from "../lib/tauri";
import {
  ATTACH_UNSUPPORTED_NOTICE,
  attachImageToSession,
  attachmentBlocksSubmit,
  attachmentStateFrom,
  isAttachableImageType,
  parseImageDataUrl,
  pendingImageAttachments,
  type HermesAttachmentState,
} from "../lib/hermes-image-attach";

const PNG: ImportedHermesFile = {
  name: "diagram.png",
  path: "/ws/uploads/diagram.png",
  rootLabel: "Workspace",
  size: 1234,
  previewDataUrl: "data:image/png;base64,aGVsbG8=",
};

const TEXT: ImportedHermesFile = {
  name: "notes.txt",
  path: "/ws/uploads/notes.txt",
  rootLabel: "Workspace",
  size: 12,
  previewDataUrl: null,
};

describe("parseImageDataUrl", () => {
  it("splits a data url into mime type and bare base64", () => {
    expect(parseImageDataUrl("data:image/png;base64,aGVsbG8=")).toEqual({
      mimeType: "image/png",
      dataBase64: "aGVsbG8=",
    });
  });

  it("returns null for non-image or malformed urls", () => {
    expect(parseImageDataUrl("data:text/plain;base64,aGk=")).toBeNull();
    expect(parseImageDataUrl("not-a-data-url")).toBeNull();
    expect(parseImageDataUrl(null)).toBeNull();
    expect(parseImageDataUrl(undefined)).toBeNull();
  });
});

describe("isAttachableImageType", () => {
  it("accepts the image mime types the bridge previews", () => {
    for (const mime of [
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/tiff",
    ]) {
      expect(isAttachableImageType(mime)).toBe(true);
    }
  });

  it("rejects non-image types", () => {
    expect(isAttachableImageType("text/plain")).toBe(false);
    expect(isAttachableImageType("application/pdf")).toBe(false);
    expect(isAttachableImageType("")).toBe(false);
  });
});

describe("attachmentStateFrom", () => {
  it("marks an imported image as a pending image attachment", () => {
    const state = attachmentStateFrom(PNG, "ws-1");
    expect(state.kind).toBe("image");
    expect(state.status).toBe("imported");
    expect(state.displayName).toBe("diagram.png");
    expect(state.workspacePath).toBe("/ws/uploads/diagram.png");
    expect(state.sessionId).toBe("ws-1");
  });

  it("marks a non-image import as a file (not for image.attach)", () => {
    const state = attachmentStateFrom(TEXT, "ws-1");
    expect(state.kind).toBe("file");
    expect(state.status).toBe("imported");
  });

  it("never carries base64 bytes on the state", () => {
    const state = attachmentStateFrom(PNG, "ws-1");
    expect(JSON.stringify(state)).not.toContain("aGVsbG8=");
  });
});

describe("pendingImageAttachments", () => {
  it("selects only imported images awaiting attach", () => {
    const states: HermesAttachmentState[] = [
      attachmentStateFrom(PNG, "ws-1"),
      attachmentStateFrom(TEXT, "ws-1"),
      { ...attachmentStateFrom(PNG, "ws-1"), status: "attached" },
    ];
    const pending = pendingImageAttachments(states);
    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe("image");
    expect(pending[0].status).toBe("imported");
  });
});

describe("attachImageToSession", () => {
  function baseDeps() {
    return {
      attachImage: vi.fn().mockResolvedValue({ attachment_id: "att-9" }),
      readImageData: vi
        .fn()
        .mockResolvedValue("data:image/png;base64,aGVsbG8="),
      isSupported: () => true,
    };
  }

  it("reads bytes, calls image.attach, and flips status to attached", async () => {
    const deps = baseDeps();
    const result = await attachImageToSession(
      attachmentStateFrom(PNG, "ws-1"),
      "ws-1",
      deps,
    );

    expect(deps.readImageData).toHaveBeenCalledWith("/ws/uploads/diagram.png");
    expect(deps.attachImage).toHaveBeenCalledWith({
      sessionId: "ws-1",
      mimeType: "image/png",
      dataBase64: "aGVsbG8=",
    });
    expect(result.state.status).toBe("attached");
    expect(result.state.hermesAttachmentId).toBe("att-9");
    expect(result.state.sessionId).toBe("ws-1");
    expect(result.error).toBeUndefined();
  });

  it("emits an artifact seed with the attached action and no base64", async () => {
    const deps = baseDeps();
    const result = await attachImageToSession(
      attachmentStateFrom(PNG, "ws-1"),
      "ws-1",
      deps,
    );
    expect(result.artifact).toBeDefined();
    expect(result.artifact?.action).toBe("attached");
    expect(result.artifact?.kind).toBe("image");
    expect(result.artifact?.path).toBe("/ws/uploads/diagram.png");
    expect(JSON.stringify(result.artifact)).not.toContain("aGVsbG8=");
  });

  it("emits a redacted trace entry that never contains the base64 payload", async () => {
    const deps = baseDeps();
    const result = await attachImageToSession(
      attachmentStateFrom(PNG, "ws-1"),
      "ws-1",
      deps,
    );
    expect(result.trace).toBeDefined();
    expect(result.trace?.method).toBe("image.attach");
    const serialized = JSON.stringify(result.trace);
    expect(serialized).not.toContain("aGVsbG8=");
    expect(serialized).not.toContain("data_base64");
  });

  it("blocks with a failed status when the RPC rejects", async () => {
    const deps = baseDeps();
    deps.attachImage.mockRejectedValue(new Error("gateway down"));
    const result = await attachImageToSession(
      attachmentStateFrom(PNG, "ws-1"),
      "ws-1",
      deps,
    );
    expect(result.state.status).toBe("failed");
    expect(result.state.error).toBeTruthy();
    expect(result.error).toBeTruthy();
    expect(result.artifact?.action).toBe("failed");
  });

  it("fails an unsupported (non-image) attachment without calling the RPC", async () => {
    const deps = baseDeps();
    const result = await attachImageToSession(
      attachmentStateFrom(TEXT, "ws-1"),
      "ws-1",
      deps,
    );
    expect(deps.attachImage).not.toHaveBeenCalled();
    expect(result.state.status).toBe("failed");
    expect(result.error).toBeTruthy();
  });

  it("falls back without calling the RPC when the feature is gated off", async () => {
    const deps = { ...baseDeps(), isSupported: () => false };
    const result = await attachImageToSession(
      attachmentStateFrom(PNG, "ws-1"),
      "ws-1",
      deps,
    );
    expect(deps.attachImage).not.toHaveBeenCalled();
    // Gated: the structured attach is skipped, the image stays imported so the
    // existing path-in-prompt fallback still carries it. No hard failure.
    expect(result.state.status).toBe("imported");
    expect(result.error).toBe(ATTACH_UNSUPPORTED_NOTICE);
    expect(result.artifact).toBeUndefined();
  });

  it("fails when the workspace file can't be read as an image", async () => {
    const deps = baseDeps();
    deps.readImageData.mockResolvedValue(null);
    const result = await attachImageToSession(
      attachmentStateFrom(PNG, "ws-1"),
      "ws-1",
      deps,
    );
    expect(deps.attachImage).not.toHaveBeenCalled();
    expect(result.state.status).toBe("failed");
    expect(result.error).toBeTruthy();
  });
});

describe("attachmentBlocksSubmit", () => {
  it("blocks submit only on a failed image attachment", () => {
    expect(
      attachmentBlocksSubmit([
        { ...attachmentStateFrom(PNG, "ws"), status: "failed" },
      ]),
    ).toBe(true);
    expect(
      attachmentBlocksSubmit([
        { ...attachmentStateFrom(PNG, "ws"), status: "attached" },
      ]),
    ).toBe(false);
    expect(attachmentBlocksSubmit([])).toBe(false);
  });
});
