import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ShareDialog } from "../components/share/ShareDialog";
import { decryptPayload, fromBase64, fromBase64Url, unwrapKey } from "../lib/share-crypto";
import { buildNotePayload } from "../lib/share-payload";

const mocks = vi.hoisted(() => ({
  shareCreate: vi.fn(),
  shareGet: vi.fn(),
  shareDelete: vi.fn(),
  shareKeyGet: vi.fn(),
  shareKeySave: vi.fn(),
  shareInviteKeySave: vi.fn(),
  shareInviteKeysGet: vi.fn(),
  getShareBaseUrl: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  shareCreate: mocks.shareCreate,
  shareGet: mocks.shareGet,
  shareDelete: mocks.shareDelete,
  shareKeyGet: mocks.shareKeyGet,
  shareKeySave: mocks.shareKeySave,
  shareInviteKeySave: mocks.shareInviteKeySave,
  shareInviteKeysGet: mocks.shareInviteKeysGet,
  getShareBaseUrl: mocks.getShareBaseUrl,
}));

const BASE_URL = "https://june-api.opensoftware.co";

function noteItem(overrides: Partial<Parameters<typeof ShareDialog>[0]["item"]> = {}) {
  return {
    kind: "note" as const,
    itemId: "note_1",
    title: "Weekly sync",
    buildPayload: () =>
      buildNotePayload({
        title: "Weekly sync",
        markdown: "# Agenda",
        sharedAt: "2026-07-14T00:00:00.000Z",
      }),
    ...overrides,
  };
}

function mockClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getShareBaseUrl.mockResolvedValue(BASE_URL);
  mocks.shareKeyGet.mockResolvedValue(null);
  mocks.shareKeySave.mockResolvedValue(undefined);
  mocks.shareInviteKeySave.mockResolvedValue(undefined);
  mocks.shareInviteKeysGet.mockResolvedValue([]);
  mocks.shareDelete.mockResolvedValue(undefined);
});

describe("ShareDialog", () => {
  it("offers one copy-link action with an optional passcode", async () => {
    render(<ShareDialog open onClose={vi.fn()} item={noteItem()} />);
    expect(await screen.findByRole("button", { name: "Copy link" })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: "Require a passcode" })).not.toBeChecked();
    expect(screen.queryByLabelText("Passcode")).not.toBeInTheDocument();
    expect(screen.queryByText(/Invite by email/i)).not.toBeInTheDocument();
  });

  it("creates an anonymous encrypted link and copies a decryptable URL", async () => {
    mocks.shareCreate.mockImplementation(async (input) => ({
      shareId: "shr_1",
      invites: [{ inviteId: "shi_link", email: input.invites[0].email }],
    }));
    const user = userEvent.setup();
    const clipboard = mockClipboard();
    render(<ShareDialog open onClose={vi.fn()} item={noteItem()} />);

    await user.click(await screen.findByRole("button", { name: "Copy link" }));

    await waitFor(() => expect(clipboard).toHaveBeenCalledTimes(1));
    expect(mocks.shareCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        invites: [expect.objectContaining({ email: "link@share.invalid" })],
      }),
    );
    const link = clipboard.mock.calls[0][0] as string;
    const fragment = link.split("#")[1].split(".");
    expect(fragment.slice(0, 3)).toEqual(["link", "shi_link", "key"]);

    const request = mocks.shareCreate.mock.calls[0][0];
    const linkKey = fromBase64Url(fragment[3]);
    const contentKey = await unwrapKey(
      linkKey,
      fromBase64(request.invites[0].envelopeB64),
      fromBase64(request.invites[0].envelopeIvB64),
    );
    const plaintext = await decryptPayload(
      contentKey,
      fromBase64(request.ciphertextB64),
      fromBase64(request.ivB64),
    );
    expect(JSON.parse(plaintext)).toMatchObject({ kind: "note", title: "Weekly sync" });
    expect(mocks.shareInviteKeySave).toHaveBeenCalledWith(
      expect.objectContaining({ inviteId: "shi_link" }),
    );
  });

  it("creates a passcode link whose fragment carries only a salt", async () => {
    mocks.shareCreate.mockResolvedValue({
      shareId: "shr_1",
      invites: [{ inviteId: "shi_link", email: "link@share.invalid" }],
    });
    const user = userEvent.setup();
    const clipboard = mockClipboard();
    render(<ShareDialog open onClose={vi.fn()} item={noteItem()} />);

    await user.click(await screen.findByRole("checkbox", { name: "Require a passcode" }));
    await user.type(screen.getByLabelText("Passcode"), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: "Copy link" }));

    await waitFor(() => expect(clipboard).toHaveBeenCalledTimes(1));
    const fragment = (clipboard.mock.calls[0][0] as string).split("#")[1].split(".");
    expect(fragment.slice(0, 3)).toEqual(["link", "shi_link", "pass"]);
    expect(fromBase64Url(fragment[3])).toHaveLength(16);
    expect(mocks.shareInviteKeySave.mock.calls[0][0].inviteKeyB64).toBe(fragment[3]);
    expect(screen.getByText(/June does not store the passcode/i)).toBeInTheDocument();
  });

  it("loads and copies an existing link without recreating the share", async () => {
    const keyB64 = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
    mocks.shareKeyGet.mockResolvedValue({ shareId: "shr_1", contentKeyB64: keyB64 });
    mocks.shareGet.mockResolvedValue({
      shareId: "shr_1",
      kind: "note",
      invites: [{ inviteId: "shi_link", email: "link@share.invalid", state: "pending" }],
    });
    mocks.shareInviteKeysGet.mockResolvedValue([{ inviteId: "shi_link", inviteKeyB64: keyB64 }]);
    const user = userEvent.setup();
    const clipboard = mockClipboard();
    render(<ShareDialog open onClose={vi.fn()} item={noteItem()} />);

    await user.click(await screen.findByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith(expect.stringContaining("#link.")));
    expect(mocks.shareCreate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Stop sharing" })).toBeEnabled();
  });

  it("blocks every close path while link creation is in flight", async () => {
    let resolveCreate: (value: unknown) => void = () => {};
    mocks.shareCreate.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    mockClipboard();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<ShareDialog open onClose={onClose} item={noteItem()} />);

    await user.click(await screen.findByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(mocks.shareCreate).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    resolveCreate({
      shareId: "shr_1",
      invites: [{ inviteId: "shi_link", email: "link@share.invalid" }],
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Done" })).toBeEnabled());
  });

  it("surfaces legacy invite shares without making them anonymous", async () => {
    mocks.shareKeyGet.mockResolvedValue({ shareId: "shr_old", contentKeyB64: "key" });
    mocks.shareGet.mockResolvedValue({
      shareId: "shr_old",
      kind: "note",
      invites: [{ inviteId: "shi_old", email: "friend@example.com", state: "pending" }],
    });
    mocks.shareInviteKeysGet.mockResolvedValue([]);
    render(<ShareDialog open onClose={vi.fn()} item={noteItem()} />);
    expect(await screen.findByText(/previous invite-only sharing model/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy link" })).not.toBeInTheDocument();
  });
});
