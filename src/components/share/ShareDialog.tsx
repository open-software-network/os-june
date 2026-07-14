import { useCallback, useEffect, useId, useRef, useState } from "react";

import { messageFromError } from "../../lib/errors";
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
    void (async () => {
      const base = await getShareBaseUrl().catch(() => null);
      if (!cancelled && base) setBaseUrl(base);
      try {
        const key = await shareKeyGet(item.kind, item.itemId);
        if (cancelled || !key) return;
        const [share, inviteKeys] = await Promise.all([
          shareGet(key.shareId),
          shareInviteKeysGet(key.shareId),
        ]);
        if (cancelled) return;
        const keyByInvite = new Map(
          inviteKeys.map((entry) => [entry.inviteId, entry.inviteKeyB64]),
        );
        setShareId(key.shareId);
        setContentKeyB64(key.contentKeyB64);
        setInvites(
          share.invites.map((invite) => ({
            inviteId: invite.inviteId,
            email: invite.email,
            state: invite.state,
            inviteKeyB64: keyByInvite.get(invite.inviteId),
          })),
        );
      } catch (err) {
        if (!cancelled) setError(messageFromError(err));
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
    if (!EMAIL_PATTERN.test(normalized) || invitingRef.current) return;
    invitingRef.current = true;
    setInviteBusy(true);
    setError(null);
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
      }
      if (!created) throw new Error("June returned no invite.");
      const inviteKeyB64 = toBase64Url(inviteKey);
      await shareInviteKeySave({
        inviteId: created.inviteId,
        shareId: nextShareId,
        inviteKeyB64,
      });
      setShareId(nextShareId);
      setContentKeyB64(nextContentKeyB64);
      setInvites((current) => [
        ...current,
        { inviteId: created.inviteId, email: created.email, state: "pending", inviteKeyB64 },
      ]);
      setEmail("");
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      invitingRef.current = false;
      setInviteBusy(false);
    }
  }, [email, shareId, contentKeyB64, item]);

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
                disabled={!emailValid || inviteBusy}
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
