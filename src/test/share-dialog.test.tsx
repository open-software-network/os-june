import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

  it("resets to the unshared view on an ambiguous 404 without purging local keys", async () => {
    mocks.shareKeyGet.mockResolvedValue({
      shareId: "shr_maybe",
      contentKeyB64: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    });
    // share_not_found is returned both for a deleted share and for one owned by
    // a different account now signed in on the same local notes; the store is
    // not account-scoped, so we must not delete the keys on this ambiguous 404.
    mocks.shareGet.mockRejectedValue({ code: "june_request_failed", message: "share_not_found" });
    render(<ShareDialog open onClose={vi.fn()} item={noteItem()} />);

    // The item resets to the unshared state so it can be shared again...
    expect(
      await screen.findByText("Not shared yet. This note stays private until you invite someone."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unshare" })).not.toBeInTheDocument();
    // ...but nothing purges the local keys, which may belong to the real owner.
    expect(mocks.shareDelete).not.toHaveBeenCalled();
  });

  it("blocks inviting when an existing share's invite state fails to load", async () => {
    mocks.shareKeyGet.mockResolvedValue({
      shareId: "shr_1",
      contentKeyB64: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    });
    // Transient failure (NOT share_not_found): shareId is pinned but the invite
    // list can't be loaded. Inviting must stay disabled so we never add against
    // an empty list that can't see the existing invites (a second active invite
    // would survive revoking the first). Reopening retries the load.
    mocks.shareGet.mockRejectedValue({ code: "june_request_failed", message: "network error" });
    const user = userEvent.setup();
    render(<ShareDialog open onClose={vi.fn()} item={noteItem()} />);

    expect(
      await screen.findByText("Couldn't load who's invited. Close and reopen to try again."),
    ).toBeInTheDocument();
    // The share id is known (Unshare is still offered), but inviting is blocked
    // even with a valid address entered.
    expect(screen.getByRole("button", { name: "Unshare" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Invite by email"), "friend@example.com");
    expect(screen.getByRole("button", { name: "Invite" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Invite" }));
    expect(mocks.shareAddInvites).not.toHaveBeenCalled();
    expect(mocks.shareCreate).not.toHaveBeenCalled();
  });

  it("rolls the created share back when persisting its content key fails", async () => {
    mocks.shareKeyGet.mockResolvedValue(null); // item not shared yet
    mocks.shareCreate.mockResolvedValue({
      shareId: "shr_1",
      invites: [{ inviteId: "shi_1", email: "first@example.com" }],
    });
    // The server share is minted, then the local content-key save fails.
    // Leaving shr_1 alive would orphan it: no local key to manage or revoke it,
    // and the next invite would mint a second share beside the live link.
    mocks.shareKeySave.mockRejectedValueOnce(new Error("disk full"));
    const user = userEvent.setup();
    render(<ShareDialog open onClose={vi.fn()} item={noteItem()} />);

    const field = await screen.findByLabelText("Invite by email");
    await user.type(field, "first@example.com");
    await user.click(screen.getByRole("button", { name: "Invite" }));
    await waitFor(() => expect(mocks.shareCreate).toHaveBeenCalledTimes(1));
    // The failed save triggers a best-effort delete of the just-created share.
    await waitFor(() => expect(mocks.shareDelete).toHaveBeenCalledWith("shr_1"));
    expect(await screen.findByText("disk full")).toBeInTheDocument();

    // State was reset by the rollback, so a retry starts a fresh share rather
    // than taking the add path against the rolled-back shr_1.
    await user.clear(field);
    await user.type(field, "second@example.com");
    await user.click(screen.getByRole("button", { name: "Invite" }));
    await waitFor(() => expect(mocks.shareCreate).toHaveBeenCalledTimes(2));
    expect(mocks.shareAddInvites).not.toHaveBeenCalled();
  });

  it("does not commit an in-flight invite after the dialog switches items", async () => {
    mocks.shareKeyGet.mockResolvedValue(null); // neither item shared yet
    // Hold shareCreate pending so we can switch items while it is in flight.
    let resolveCreate: (value: {
      shareId: string;
      invites: { inviteId: string; email: string }[];
    }) => void = () => {};
    mocks.shareCreate.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const user = userEvent.setup();
    const { rerender } = render(
      <ShareDialog open onClose={vi.fn()} item={noteItem({ itemId: "note_A" })} />,
    );

    const field = await screen.findByLabelText("Invite by email");
    await user.type(field, "first@example.com");
    await user.click(screen.getByRole("button", { name: "Invite" }));
    await waitFor(() => expect(mocks.shareCreate).toHaveBeenCalledTimes(1));

    // The user switches the dialog to a different item mid-flight; the parents
    // reuse the same component, so the effect reloads for note_B.
    rerender(<ShareDialog open onClose={vi.fn()} item={noteItem({ itemId: "note_B" })} />);
    await waitFor(() =>
      expect(
        screen.getByText("Not shared yet. This note stays private until you invite someone."),
      ).toBeInTheDocument(),
    );

    // Now note_A's create resolves and its continuation runs to completion.
    resolveCreate({
      shareId: "shr_A",
      invites: [{ inviteId: "shi_A", email: "first@example.com" }],
    });
    await waitFor(() => expect(mocks.shareInviteKeySave).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: "Invite" })).toBeInTheDocument());

    // note_A's share was still persisted locally (keyed to note_A)...
    expect(mocks.shareKeySave).toHaveBeenCalledWith(expect.objectContaining({ itemId: "note_A" }));
    // ...but nothing from note_A leaked into note_B's dialog.
    expect(screen.queryByText("first@example.com")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unshare" })).not.toBeInTheDocument();
  });

  it("revokes a just-added invite when persisting its key fails, keeping the share", async () => {
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
    // The invite is created on the existing share, then its local key save fails.
    mocks.shareInviteKeySave.mockRejectedValueOnce(new Error("disk full"));
    const user = userEvent.setup();
    render(<ShareDialog open onClose={vi.fn()} item={noteItem()} />);

    expect(await screen.findByText("first@example.com")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Invite by email"), "second@example.com");
    await user.click(screen.getByRole("button", { name: "Invite" }));

    // The dangling invite is revoked; the pre-existing share is left intact.
    await waitFor(() => expect(mocks.shareRevokeInvite).toHaveBeenCalledWith("shr_1", "shi_2"));
    expect(mocks.shareDelete).not.toHaveBeenCalled();
    expect(await screen.findByText("disk full")).toBeInTheDocument();
  });

  it("disables unshare while an invite is in flight", async () => {
    mocks.shareKeyGet.mockResolvedValue({
      shareId: "shr_1",
      contentKeyB64: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    });
    mocks.shareGet.mockResolvedValue({
      shareId: "shr_1",
      kind: "note",
      invites: [{ inviteId: "shi_1", email: "first@example.com", state: "accepted" }],
    });
    // Hold shareAddInvites pending to keep the invite in flight.
    let resolveAdd: (value: { invites: { inviteId: string; email: string }[] }) => void = () => {};
    mocks.shareAddInvites.mockReturnValue(
      new Promise((resolve) => {
        resolveAdd = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<ShareDialog open onClose={vi.fn()} item={noteItem()} />);

    expect(await screen.findByText("first@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unshare" })).toBeEnabled();

    await user.type(screen.getByLabelText("Invite by email"), "second@example.com");
    await user.click(screen.getByRole("button", { name: "Invite" }));

    // While the add is in flight, unsharing is blocked (it would delete the
    // share out from under the invite's continuation).
    await waitFor(() => expect(screen.getByRole("button", { name: "Unshare" })).toBeDisabled());

    // Once it settles, unshare is available again.
    resolveAdd({ invites: [{ inviteId: "shi_2", email: "second@example.com" }] });
    await waitFor(() => expect(screen.getByRole("button", { name: "Unshare" })).toBeEnabled());
  });

  it("blocks every close path while an invite is in flight", async () => {
    let resolveCreate: (value: {
      shareId: string;
      invites: { inviteId: string; email: string }[];
    }) => void = () => {};
    mocks.shareCreate.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<ShareDialog open onClose={onClose} item={noteItem()} />);

    await user.type(await screen.findByLabelText("Invite by email"), "friend@example.com");
    await user.click(screen.getByRole("button", { name: "Invite" }));
    await waitFor(() => expect(mocks.shareCreate).toHaveBeenCalledTimes(1));

    expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    resolveCreate({
      shareId: "shr_1",
      invites: [{ inviteId: "shi_1", email: "friend@example.com" }],
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Done" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clears a pending unshare confirmation when the dialog switches items", async () => {
    mocks.shareKeyGet.mockResolvedValue({
      shareId: "shr_A",
      contentKeyB64: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    });
    mocks.shareGet.mockResolvedValue({
      shareId: "shr_A",
      kind: "note",
      invites: [{ inviteId: "shi_1", email: "friend@example.com", state: "accepted" }],
    });
    const user = userEvent.setup();
    const { rerender } = render(
      <ShareDialog open onClose={vi.fn()} item={noteItem({ itemId: "note_A" })} />,
    );

    // Open the unshare confirmation for item A.
    await user.click(await screen.findByRole("button", { name: "Unshare" }));
    expect(await screen.findByRole("dialog", { name: "Unshare" })).toBeInTheDocument();

    // Switch the dialog to a different item before confirming.
    rerender(<ShareDialog open onClose={vi.fn()} item={noteItem({ itemId: "note_B" })} />);

    // The stale confirmation is cleared, so it can't delete the new item's share.
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Unshare" })).not.toBeInTheDocument(),
    );
    expect(mocks.shareDelete).not.toHaveBeenCalled();
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
