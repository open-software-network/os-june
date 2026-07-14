import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ShareDialog } from "../components/share/ShareDialog";
import { decryptPayload, fromBase64Url, parseShareFragment, unwrapKey } from "../lib/share-crypto";
import { buildNotePayload } from "../lib/share-payload";

const mocks = vi.hoisted(() => ({
  shareCreate: vi.fn(),
  shareGet: vi.fn(),
  shareAddInvites: vi.fn(),
  shareRevokeInvite: vi.fn(),
  shareDelete: vi.fn(),
  shareKeyGet: vi.fn(),
  shareKeysForget: vi.fn(),
  shareKeySave: vi.fn(),
  shareInviteKeySave: vi.fn(),
  shareInviteKeysGet: vi.fn(),
  getShareBaseUrl: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  shareCreate: mocks.shareCreate,
  shareGet: mocks.shareGet,
  shareAddInvites: mocks.shareAddInvites,
  shareRevokeInvite: mocks.shareRevokeInvite,
  shareDelete: mocks.shareDelete,
  shareKeyGet: mocks.shareKeyGet,
  shareKeysForget: mocks.shareKeysForget,
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
  mocks.shareRevokeInvite.mockResolvedValue(undefined);
  mocks.shareDelete.mockResolvedValue(undefined);
  mocks.shareKeysForget.mockResolvedValue(undefined);
});

describe("ShareDialog", () => {
  it("shows the private empty state when the item has no share", async () => {
    render(<ShareDialog open onClose={vi.fn()} item={noteItem()} />);
    expect(
      await screen.findByText("Not shared yet. This note stays private until you invite someone."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unshare" })).not.toBeInTheDocument();
  });

  it("creates the share lazily on the first invite and the copied link decrypts it", async () => {
    mocks.shareCreate.mockImplementation(async (input) => ({
      shareId: "shr_1",
      invites: input.invites.map((invite: { email: string }, index: number) => ({
        inviteId: `shi_${index + 1}`,
        email: invite.email,
      })),
    }));
    const user = userEvent.setup();
    // After setup: user-event installs its own clipboard stub on setup, which
    // would otherwise replace this spy.
    const writeText = mockClipboard();
    render(<ShareDialog open onClose={vi.fn()} item={noteItem()} />);

    await user.type(await screen.findByLabelText("Invite by email"), "Friend@Example.com");
    await user.click(screen.getByRole("button", { name: "Invite" }));

    await waitFor(() => expect(mocks.shareCreate).toHaveBeenCalledTimes(1));
    const createInput = mocks.shareCreate.mock.calls[0][0];
    expect(createInput.kind).toBe("note");
    // Owner email handling: invited addresses are lowercased.
    expect(createInput.invites).toHaveLength(1);
    expect(createInput.invites[0].email).toBe("friend@example.com");
    // The request carries ciphertext only, never the payload.
    expect(JSON.stringify(createInput)).not.toContain("Agenda");

    // Content and invite keys are persisted locally for later invites and
    // for copy-link across restarts.
    await waitFor(() => expect(mocks.shareKeySave).toHaveBeenCalledTimes(1));
    expect(mocks.shareKeySave.mock.calls[0][0]).toMatchObject({
      shareId: "shr_1",
      itemKind: "note",
      itemId: "note_1",
    });
    await waitFor(() => expect(mocks.shareInviteKeySave).toHaveBeenCalledTimes(1));

    const row = await screen.findByText("friend@example.com");
    expect(row).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const link: string = writeText.mock.calls[0][0];
    expect(link.startsWith(`${BASE_URL}/s/shr_1#`)).toBe(true);

    // End to end: the fragment key unwraps the submitted envelope, and the
    // unwrapped content key decrypts the submitted ciphertext.
    const fragment = parseShareFragment(link.split("#")[1]);
    expect(fragment?.inviteId).toBe("shi_1");
    const contentKey = await unwrapKey(
      fragment?.inviteKey ?? new Uint8Array(),
      fromBase64Url(createInput.invites[0].envelopeB64),
      fromBase64Url(createInput.invites[0].envelopeIvB64),
    );
    const plaintext = await decryptPayload(
      contentKey,
      fromBase64Url(createInput.ciphertextB64),
      fromBase64Url(createInput.ivB64),
    );
    expect(JSON.parse(plaintext)).toMatchObject({
      v: 1,
      kind: "note",
      title: "Weekly sync",
      markdown: "# Agenda",
    });
  });

  it("adds later invites by wrapping the stored content key without re-encrypting", async () => {
    mocks.shareKeyGet.mockResolvedValue({
      shareId: "shr_1",
      contentKeyB64: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    });
    mocks.shareGet.mockResolvedValue({
      shareId: "shr_1",
      kind: "note",
      invites: [{ inviteId: "shi_1", email: "first@example.com", state: "accepted" }],
    });
    mocks.shareInviteKeysGet.mockResolvedValue([
      { inviteId: "shi_1", inviteKeyB64: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8" },
    ]);
    mocks.shareAddInvites.mockResolvedValue({
      invites: [{ inviteId: "shi_2", email: "second@example.com" }],
    });
    const user = userEvent.setup();
    render(<ShareDialog open onClose={vi.fn()} item={noteItem()} />);

    expect(await screen.findByText("first@example.com")).toBeInTheDocument();
    expect(screen.getByText("Accepted")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Invite by email"), "second@example.com");
    await user.click(screen.getByRole("button", { name: "Invite" }));

    await waitFor(() => expect(mocks.shareAddInvites).toHaveBeenCalledTimes(1));
    expect(mocks.shareCreate).not.toHaveBeenCalled();
    expect(mocks.shareAddInvites.mock.calls[0][0]).toBe("shr_1");
    expect(await screen.findByText("second@example.com")).toBeInTheDocument();
  });

  it("disables copy link for revoked invites and for invites without a local key", async () => {
    mocks.shareKeyGet.mockResolvedValue({
      shareId: "shr_1",
      contentKeyB64: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    });
    mocks.shareGet.mockResolvedValue({
      shareId: "shr_1",
      kind: "note",
      invites: [
        { inviteId: "shi_1", email: "revoked@example.com", state: "revoked" },
        { inviteId: "shi_2", email: "otherdevice@example.com", state: "pending" },
      ],
    });
    mocks.shareInviteKeysGet.mockResolvedValue([
      { inviteId: "shi_1", inviteKeyB64: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8" },
    ]);
    render(<ShareDialog open onClose={vi.fn()} item={noteItem()} />);

    const list = await screen.findByRole("list", { name: "Invited people" });
    const [revokedRow, keylessRow] = within(list).getAllByRole("listitem");
    expect(within(revokedRow).getByText("Revoked")).toBeInTheDocument();
    expect(within(revokedRow).getByRole("button", { name: "Copy link" })).toBeDisabled();
    // A revoked invite can no longer be revoked again.
    expect(within(revokedRow).queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
    expect(within(keylessRow).getByRole("button", { name: "Copy link" })).toBeDisabled();
    expect(within(keylessRow).getByRole("button", { name: "Copy link" })).toHaveAttribute(
      "title",
      "Link unavailable on this device",
    );
  });

  it("revokes an invite after confirmation", async () => {
    mocks.shareKeyGet.mockResolvedValue({
      shareId: "shr_1",
      contentKeyB64: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    });
    mocks.shareGet.mockResolvedValue({
      shareId: "shr_1",
      kind: "note",
      invites: [{ inviteId: "shi_1", email: "friend@example.com", state: "pending" }],
    });
    const user = userEvent.setup();
    render(<ShareDialog open onClose={vi.fn()} item={noteItem()} />);

    await user.click(await screen.findByRole("button", { name: "Revoke" }));
    expect(
      await screen.findByText(
        "friend@example.com will no longer be able to open their link. Revoking cannot erase content they already viewed or copied.",
      ),
    ).toBeInTheDocument();
    const confirmDialog = screen.getByRole("dialog", { name: "Revoke access" });
    await user.click(within(confirmDialog).getByRole("button", { name: "Revoke" }));

    await waitFor(() => expect(mocks.shareRevokeInvite).toHaveBeenCalledWith("shr_1", "shi_1"));
    expect(await screen.findByText("Revoked")).toBeInTheDocument();
  });

  it("unshares after confirmation and returns to the private state", async () => {
    mocks.shareKeyGet.mockResolvedValue({
      shareId: "shr_1",
      contentKeyB64: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    });
    mocks.shareGet.mockResolvedValue({
      shareId: "shr_1",
      kind: "note",
      invites: [{ inviteId: "shi_1", email: "friend@example.com", state: "accepted" }],
    });
    const user = userEvent.setup();
    render(<ShareDialog open onClose={vi.fn()} item={noteItem()} />);

    await user.click(await screen.findByRole("button", { name: "Unshare" }));
    expect(
      await screen.findByText(
        "Everyone loses access to this shared note. Unsharing cannot erase content people already viewed or copied.",
      ),
    ).toBeInTheDocument();
    const confirmDialog = screen.getByRole("dialog", { name: "Unshare" });
    await user.click(within(confirmDialog).getByRole("button", { name: "Unshare" }));

    await waitFor(() => expect(mocks.shareDelete).toHaveBeenCalledWith("shr_1"));
    expect(
      await screen.findByText("Not shared yet. This note stays private until you invite someone."),
    ).toBeInTheDocument();
  });

  it("rejects a duplicate active invite for the same address", async () => {
    mocks.shareKeyGet.mockResolvedValue({
      shareId: "shr_1",
      contentKeyB64: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    });
    mocks.shareGet.mockResolvedValue({
      shareId: "shr_1",
      kind: "note",
      invites: [{ inviteId: "shi_1", email: "friend@example.com", state: "accepted" }],
    });
    const user = userEvent.setup();
    render(<ShareDialog open onClose={vi.fn()} item={noteItem()} />);

    expect(await screen.findByText("friend@example.com")).toBeInTheDocument();
    // Same address, different casing: still a duplicate.
    await user.type(screen.getByLabelText("Invite by email"), "Friend@Example.com");
    await user.click(screen.getByRole("button", { name: "Invite" }));

    expect(await screen.findByText("That person is already invited.")).toBeInTheDocument();
    expect(mocks.shareAddInvites).not.toHaveBeenCalled();
    expect(mocks.shareCreate).not.toHaveBeenCalled();
  });

  it("forgets a stale local key when the server reports the share gone", async () => {
    mocks.shareKeyGet.mockResolvedValue({
      shareId: "shr_dead",
      contentKeyB64: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    });
    // The share no longer exists for this account (definitive 404).
    mocks.shareGet.mockRejectedValue({ code: "june_request_failed", message: "share_not_found" });
    render(<ShareDialog open onClose={vi.fn()} item={noteItem()} />);

    // The stale key is dropped and the item resets to the unshared state.
    await waitFor(() => expect(mocks.shareKeysForget).toHaveBeenCalledWith("shr_dead"));
    expect(
      await screen.findByText("Not shared yet. This note stays private until you invite someone."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unshare" })).not.toBeInTheDocument();
  });

  it("keeps the invite button disabled while an existing share is still loading", async () => {
    // Hold shareKeyGet pending so the open effect never settles during the
    // assertion window; a submit now would wrongly take the first-invite path.
    let resolveKey: (value: unknown) => void = () => {};
    mocks.shareKeyGet.mockReturnValue(
      new Promise((resolve) => {
        resolveKey = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<ShareDialog open onClose={vi.fn()} item={noteItem()} />);

    await user.type(await screen.findByLabelText("Invite by email"), "friend@example.com");
    expect(screen.getByRole("button", { name: "Invite" })).toBeDisabled();
    expect(mocks.shareCreate).not.toHaveBeenCalled();

    // Once the load settles with no existing share, inviting is enabled again.
    resolveKey(null);
    await waitFor(() => expect(screen.getByRole("button", { name: "Invite" })).toBeEnabled());
    expect(mocks.shareCreate).not.toHaveBeenCalled();
  });
});
