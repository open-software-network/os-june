import { useCallback, useEffect, useId, useRef, useState } from "react";

import { isShareNotFoundError, messageFromError } from "../../lib/errors";
import {
  buildShareFragment,
  encryptPayload,
  fromBase64Url,
  generateKey,
  toBase64,
  toBase64Url,
  wrapKey,
} from "../../lib/share-crypto";
import {
  getShareBaseUrl,
  shareAddInvites,
  shareCreate,
  shareDelete,
  shareGet,
  shareInviteKeySave,
  shareInviteKeysGet,
  shareKeyGet,
  shareKeysForget,
  shareKeySave,
  shareRevokeInvite,
  type ShareInviteState,
  type ShareKind,
} from "../../lib/tauri";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Dialog } from "../ui/Dialog";

type InviteRow = {
  inviteId: string;
  email: string;
  state: ShareInviteState;
  /** Present when this device holds the invite key; copy link needs it. */
  inviteKeyB64?: string;
};

export type ShareDialogItem = {
  kind: ShareKind;
  itemId: string;
  title: string;
  /** Canonical JSON payload snapshot, built lazily on the first invite. */
  buildPayload: () => string;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Owner-side sharing dialog (JUN-308). A share is created lazily on the
 * first invite, so an item stays fully private until at least one recipient
 * is explicitly invited. All crypto runs here in the webview; the Tauri
 * layer only moves ciphertext, envelopes, and metadata.
 */
export function ShareDialog({
  open,
  onClose,
  item,
}: {
  open: boolean;
  onClose: () => void;
  item: ShareDialogItem;
}) {
  const emailInputId = useId();
  const [loading, setLoading] = useState(false);
  // Set when opening an already-shared item but loading its invite state fails
  // transiently. shareId is pinned yet `invites` is unknown, so inviting is
  // blocked until a clean reload rather than acting on an empty list that can't
  // see the existing invites.
  const [loadFailed, setLoadFailed] = useState(false);
  const [shareId, setShareId] = useState<string | null>(null);
  const [contentKeyB64, setContentKeyB64] = useState<string | null>(null);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedInviteId, setCopiedInviteId] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<InviteRow | null>(null);
  const [confirmUnshare, setConfirmUnshare] = useState(false);
  // Synchronous guard: React state (inviteBusy) updates asynchronously, so two
  // submits fired in the same tick could both pass the check and create two
  // separate server shares for the same item. A ref blocks the second entrant.
  const invitingRef = useRef(false);
  // The item the dialog currently represents, kept fresh on every render. The
  // parents reuse this component across items rather than remounting it, so an
  // invite that began for one item must not commit its share into the dialog
  // after the user has switched to another; async commits compare against this.
  const activeItemKeyRef = useRef(`${item.kind}:${item.itemId}`);
  activeItemKeyRef.current = `${item.kind}:${item.itemId}`;

  useEffect(() => {
    if (!copiedInviteId) return;
    const timer = window.setTimeout(() => setCopiedInviteId(null), 1600);
    return () => window.clearTimeout(timer);
  }, [copiedInviteId]);

  // Load any existing share for this item when the dialog opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setEmail("");
    setShareId(null);
    setContentKeyB64(null);
    setInvites([]);
    setLoadFailed(false);
    void (async () => {
      const base = await getShareBaseUrl().catch(() => null);
      if (!cancelled && base) setBaseUrl(base);
      let existing: { shareId: string; contentKeyB64: string } | null = null;
      try {
        existing = await shareKeyGet(item.kind, item.itemId);
        if (cancelled || !existing) return;
        // This item is already shared locally. Pin its share id and content
        // key up front, before fetching invite state: if shareGet then fails
        // with a transient error, the dialog must not fall back into the
        // first-invite path, which would mint a duplicate server share and
        // orphan this one. A later invite adds to the existing share instead.
        setShareId(existing.shareId);
        setContentKeyB64(existing.contentKeyB64);
        const [share, inviteKeys] = await Promise.all([
          shareGet(existing.shareId),
          shareInviteKeysGet(existing.shareId),
        ]);
        if (cancelled) return;
        const keyByInvite = new Map(
          inviteKeys.map((entry) => [entry.inviteId, entry.inviteKeyB64]),
        );
        setInvites(
          share.invites.map((invite) => ({
            inviteId: invite.inviteId,
            email: invite.email,
            state: invite.state,
            inviteKeyB64: keyByInvite.get(invite.inviteId),
          })),
        );
      } catch (err) {
        if (cancelled) return;
        if (existing && isShareNotFoundError(err)) {
          // The share is definitively gone or owned by a different account
          // (e.g. re-signed-in on the same local notes). Forget the stale
          // local key and reset to the unshared state so the item can be
          // shared again, rather than pointing Invite/Unshare at a dead share.
          await shareKeysForget(existing.shareId).catch(() => {});
          if (cancelled) return;
          setShareId(null);
          setContentKeyB64(null);
          setInvites([]);
        } else {
          // Loading the existing share's invite state failed transiently.
          // Keep shareId pinned so a later action still targets the right
          // share, but block inviting: `invites` is unknown, and adding against
          // an empty list could duplicate an invite the client can't see.
          // Server-side active-invite uniqueness is the backstop; the client
          // still must not knowingly act on unknown state.
          setLoadFailed(true);
          setError(messageFromError(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, item.kind, item.itemId]);

  const handleInvite = useCallback(async () => {
    const normalized = email.trim().toLowerCase();
    // `loading` guards the async open effect that resolves an existing share:
    // submitting before it settles would take the first-invite path and mint a
    // second, orphaned share for an already-shared item.
    if (!EMAIL_PATTERN.test(normalized) || invitingRef.current || loading || loadFailed) return;
    // Reject a duplicate active invite for the same address. The viewer
    // authorizes by any non-revoked invite matching the email, so a second
    // active row would survive revoking the first and leave that person able
    // to open the share.
    if (invites.some((invite) => invite.state !== "revoked" && invite.email === normalized)) {
      setError("That person is already invited.");
      return;
    }
    invitingRef.current = true;
    setInviteBusy(true);
    setError(null);
    // The item this invite is for, captured up front. If the user switches the
    // dialog to another item while the async work below is in flight, the
    // commit guards compare against this so a share is never attached to, or an
    // error shown on, the wrong item.
    const startedItemKey = `${item.kind}:${item.itemId}`;
    // Tracks a share minted in *this* call so the catch can delete it if a
    // local key save fails. A server share whose content key never persisted
    // is an orphan: the owner can't find it (shareKeyGet is null), can't revoke
    // it from this item, and future invites mint a second share beside it.
    let createdShareId: string | null = null;
    // Tracks an invite added to an *existing* share this call (the add branch),
    // so the catch can revoke it if the local invite-key save then fails. Unlike
    // the create branch we must not delete the whole share (it predates this
    // call); revoking just the new invite drops the active-but-unusable row
    // whose link we could never produce.
    let addedInviteId: string | null = null;
    try {
      const inviteKey = await generateKey();
      let nextShareId = shareId;
      let nextContentKeyB64 = contentKeyB64;
      let created: { inviteId: string; email: string };
      if (!nextShareId || !nextContentKeyB64) {
        // First invite: mint the content key and create the share lazily so
        // nothing exists server-side until someone is explicitly invited.
        const contentKey = await generateKey();
        const { ciphertext, iv } = await encryptPayload(contentKey, item.buildPayload());
        const { envelope, iv: envelopeIv } = await wrapKey(inviteKey, contentKey);
        const response = await shareCreate({
          kind: item.kind,
          ciphertextB64: toBase64(ciphertext),
          ivB64: toBase64(iv),
          invites: [
            {
              email: normalized,
              envelopeB64: toBase64(envelope),
              envelopeIvB64: toBase64(envelopeIv),
            },
          ],
        });
        nextShareId = response.shareId;
        nextContentKeyB64 = toBase64Url(contentKey);
        // Arm rollback: the share now exists server-side. If either local save
        // below fails, the catch deletes it rather than leaving an orphan.
        createdShareId = nextShareId;
        await shareKeySave({
          shareId: nextShareId,
          itemKind: item.kind,
          itemId: item.itemId,
          contentKeyB64: nextContentKeyB64,
        });
        created = response.invites[0];
      } else {
        const contentKey = fromBase64Url(nextContentKeyB64);
        const { envelope, iv: envelopeIv } = await wrapKey(inviteKey, contentKey);
        const response = await shareAddInvites(nextShareId, [
          {
            email: normalized,
            envelopeB64: toBase64(envelope),
            envelopeIvB64: toBase64(envelopeIv),
          },
        ]);
        created = response.invites[0];
        // Arm invite rollback: the invite now exists on the existing share.
        if (created) addedInviteId = created.inviteId;
      }
      if (!created) throw new Error("June returned no invite.");
      const inviteKeyB64 = toBase64Url(inviteKey);
      await shareInviteKeySave({
        inviteId: created.inviteId,
        shareId: nextShareId,
        inviteKeyB64,
      });
      // The share and its invite key are fully persisted now (server + local,
      // keyed to the started item), so disarm both rollbacks regardless. Only
      // reflect it in the dialog if we're still on that item: committing after
      // the user switched items would attach this share to the wrong one.
      createdShareId = null;
      addedInviteId = null;
      if (activeItemKeyRef.current === startedItemKey) {
        setShareId(nextShareId);
        setContentKeyB64(nextContentKeyB64);
        setInvites((current) => [
          ...current,
          { inviteId: created.inviteId, email: created.email, state: "pending", inviteKeyB64 },
        ]);
        setEmail("");
      }
    } catch (err) {
      const stillOnStartedItem = activeItemKeyRef.current === startedItemKey;
      if (createdShareId) {
        // Roll the just-created share back so no locally-unmanageable orphan
        // survives. Best-effort: if the delete also fails there's nothing more
        // the client can do, and the original error is what we surface. The
        // delete runs regardless of item switches (it targets the started
        // item's share); the state reset only applies if we're still on it.
        await shareDelete(createdShareId).catch(() => {});
        if (stillOnStartedItem) {
          setShareId(null);
          setContentKeyB64(null);
        }
      } else if (addedInviteId && shareId) {
        // The invite was added to an existing share but its key never persisted;
        // revoke it so no active invite lingers whose link we can never produce.
        // Best-effort, and it targets the share the invite was added to.
        await shareRevokeInvite(shareId, addedInviteId).catch(() => {});
      }
      // Don't surface this item's error on a different item's dialog.
      if (stillOnStartedItem) setError(messageFromError(err));
    } finally {
      invitingRef.current = false;
      setInviteBusy(false);
    }
  }, [email, loading, loadFailed, invites, shareId, contentKeyB64, item]);

  const handleCopyLink = useCallback(
    async (invite: InviteRow) => {
      if (!shareId || !invite.inviteKeyB64 || !baseUrl) return;
      const fragment = buildShareFragment(invite.inviteId, fromBase64Url(invite.inviteKeyB64));
      const link = `${baseUrl}/s/${shareId}#${fragment}`;
      try {
        await navigator.clipboard.writeText(link);
        setCopiedInviteId(invite.inviteId);
      } catch {
        setError("Couldn't copy the link. Try again.");
      }
    },
    [shareId, baseUrl],
  );

  const handleRevoke = useCallback(async () => {
    if (!shareId || !revokeTarget) return;
    await shareRevokeInvite(shareId, revokeTarget.inviteId).catch((err) => {
      setError(messageFromError(err));
      throw err;
    });
    setInvites((current) =>
      current.map((invite) =>
        invite.inviteId === revokeTarget.inviteId ? { ...invite, state: "revoked" } : invite,
      ),
    );
  }, [shareId, revokeTarget]);

  const handleUnshare = useCallback(async () => {
    if (!shareId) return;
    await shareDelete(shareId).catch((err) => {
      setError(messageFromError(err));
      throw err;
    });
    setShareId(null);
    setContentKeyB64(null);
    setInvites([]);
    setLoadFailed(false);
  }, [shareId]);

  const emailValid = EMAIL_PATTERN.test(email.trim().toLowerCase());
  const itemNoun = item.kind === "note" ? "note" : "session";

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title={`Share ${itemNoun}`}
        description={`Invite people by email. Each person gets their own private link to "${item.title || (item.kind === "note" ? "Untitled note" : "Untitled session")}".`}
        width={480}
        className="share-dialog"
        initialFocusSelector="[data-share-email-input]"
        footer={
          <>
            {shareId ? (
              <button
                type="button"
                className="primary-action share-unshare"
                // Blocked while an invite is in flight: unsharing mid-invite
                // would delete the share, then the invite's continuation could
                // save a key and set shareId back to the now-deleted share.
                disabled={inviteBusy}
                onClick={() => setConfirmUnshare(true)}
              >
                Unshare
              </button>
            ) : null}
            <button type="button" className="primary-action primary-solid" onClick={onClose}>
              Done
            </button>
          </>
        }
      >
        <div className="dialog-body share-dialog-body">
          <form
            className="share-invite-row"
            onSubmit={(event) => {
              event.preventDefault();
              void handleInvite();
            }}
          >
            <label className="dialog-field-label" htmlFor={emailInputId}>
              Invite by email
            </label>
            <div className="share-invite-controls">
              <input
                id={emailInputId}
                data-share-email-input=""
                className="dialog-input"
                type="email"
                autoComplete="off"
                placeholder="name@example.com"
                value={email}
                onChange={(event) => setEmail(event.currentTarget.value)}
              />
              <button
                type="submit"
                className="primary-action primary-solid"
                disabled={!emailValid || inviteBusy || loading || loadFailed}
              >
                {inviteBusy ? "Inviting..." : "Invite"}
              </button>
            </div>
          </form>
          {error ? (
            <p className="share-dialog-error" role="alert">
              {error}
            </p>
          ) : null}
          {loading ? (
            <p className="share-dialog-caption">Loading share...</p>
          ) : loadFailed ? (
            <p className="share-dialog-caption">
              Couldn't load who's invited. Close and reopen to try again.
            </p>
          ) : invites.length > 0 ? (
            <ul className="share-invite-list" aria-label="Invited people">
              {invites.map((invite) => {
                const copyDisabled = invite.state === "revoked" || !invite.inviteKeyB64;
                return (
                  <li key={invite.inviteId} className="share-invite-item">
                    <span className="share-invite-email" title={invite.email}>
                      {invite.email}
                    </span>
                    <span className="share-invite-state" data-state={invite.state}>
                      {invite.state === "pending"
                        ? "Pending"
                        : invite.state === "accepted"
                          ? "Accepted"
                          : "Revoked"}
                    </span>
                    <button
                      type="button"
                      className="primary-action share-invite-copy"
                      disabled={copyDisabled}
                      title={
                        invite.state === "revoked"
                          ? "Invite revoked"
                          : invite.inviteKeyB64
                            ? "Copy this person's link"
                            : "Link unavailable on this device"
                      }
                      onClick={() => void handleCopyLink(invite)}
                    >
                      {copiedInviteId === invite.inviteId ? "Copied" : "Copy link"}
                    </button>
                    {invite.state !== "revoked" ? (
                      <button
                        type="button"
                        className="primary-action share-invite-revoke"
                        onClick={() => setRevokeTarget(invite)}
                      >
                        Revoke
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="share-dialog-caption">
              Not shared yet. This {itemNoun} stays private until you invite someone.
            </p>
          )}
          <p className="share-dialog-caption">
            Shares are a snapshot from when you shared. Only invited people can open their link,
            after signing in with the invited email.
          </p>
        </div>
      </Dialog>
      <ConfirmDialog
        open={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        onConfirm={handleRevoke}
        title="Revoke access"
        description={`${revokeTarget?.email ?? "This person"} will no longer be able to open their link. Revoking cannot erase content they already viewed or copied.`}
        confirmLabel="Revoke"
        confirmBusyLabel="Revoking..."
        destructive
      />
      <ConfirmDialog
        open={confirmUnshare}
        onClose={() => setConfirmUnshare(false)}
        onConfirm={handleUnshare}
        title="Unshare"
        description={`Everyone loses access to this shared ${itemNoun}. Unsharing cannot erase content people already viewed or copied.`}
        confirmLabel="Unshare"
        confirmBusyLabel="Unsharing..."
        destructive
      />
    </>
  );
}
