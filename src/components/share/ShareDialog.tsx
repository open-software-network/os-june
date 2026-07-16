import { useCallback, useEffect, useRef, useState } from "react";

import { isShareNotFoundError, messageFromError } from "../../lib/errors";
import {
  buildLinkShareFragment,
  derivePasscodeKey,
  encryptPayload,
  fromBase64Url,
  generateKey,
  generatePasscodeSalt,
  toBase64,
  toBase64Url,
  wrapKey,
} from "../../lib/share-crypto";
import {
  getShareBaseUrl,
  shareCreate,
  shareDelete,
  shareGet,
  shareInviteKeySave,
  shareInviteKeysGet,
  shareKeyGet,
  shareKeySave,
  type ShareKind,
} from "../../lib/tauri";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Dialog } from "../ui/Dialog";

export type ShareDialogItem = {
  kind: ShareKind;
  itemId: string;
  title: string;
  buildPayload: () => string;
};

const LINK_EMAIL = "link@share.invalid";
const PASSCODE_SALT_BYTES = 16;
const MIN_PASSCODE_LENGTH = 8;

export function ShareDialog({
  open,
  onClose,
  item,
}: {
  open: boolean;
  onClose: () => void;
  item: ShareDialogItem;
}) {
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shareId, setShareId] = useState<string | null>(null);
  const [inviteId, setInviteId] = useState<string | null>(null);
  const [linkMaterialB64, setLinkMaterialB64] = useState<string | null>(null);
  const [passwordProtected, setPasswordProtected] = useState(false);
  const [requirePasscode, setRequirePasscode] = useState(false);
  const [passcode, setPasscode] = useState("");
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState<"link" | "passcode" | null>(null);
  const [legacyShare, setLegacyShare] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const activeItemRef = useRef(`${item.kind}:${item.itemId}`);
  activeItemRef.current = `${item.kind}:${item.itemId}`;

  useEffect(() => {
    if (!open) return;
    const startedItem = `${item.kind}:${item.itemId}`;
    let cancelled = false;
    setLoading(true);
    setShareId(null);
    setInviteId(null);
    setLinkMaterialB64(null);
    setPasswordProtected(false);
    setRequirePasscode(false);
    setPasscode("");
    setCopied(null);
    setLegacyShare(false);
    setLoadFailed(false);
    setConfirmStop(false);
    setError(null);

    void (async () => {
      try {
        const [saved, url] = await Promise.all([
          shareKeyGet(item.kind, item.itemId),
          getShareBaseUrl(),
        ]);
        if (cancelled || activeItemRef.current !== startedItem) return;
        setBaseUrl(url);
        if (!saved) return;
        setShareId(saved.shareId);
        try {
          const [remote, localKeys] = await Promise.all([
            shareGet(saved.shareId),
            shareInviteKeysGet(saved.shareId),
          ]);
          if (cancelled || activeItemRef.current !== startedItem) return;
          const linkInvite = remote.invites.find(
            (invite) => invite.email === LINK_EMAIL && invite.state !== "revoked",
          );
          const localKey = linkInvite
            ? localKeys.find((key) => key.inviteId === linkInvite.inviteId)
            : undefined;
          if (!linkInvite || !localKey) {
            setLegacyShare(true);
            return;
          }
          const material = fromBase64Url(localKey.inviteKeyB64);
          if (material.length !== PASSCODE_SALT_BYTES && material.length !== 32) {
            throw new Error("The local share link is invalid.");
          }
          setInviteId(linkInvite.inviteId);
          setLinkMaterialB64(localKey.inviteKeyB64);
          setPasswordProtected(material.length === PASSCODE_SALT_BYTES);
        } catch (loadError) {
          if (cancelled || activeItemRef.current !== startedItem) return;
          if (!isShareNotFoundError(loadError)) {
            setLoadFailed(true);
            throw loadError;
          }
          // The remote share is gone. Keep the ambiguous local key mapping so
          // another signed-in owner cannot destroy the original owner's keys.
          setShareId(null);
        }
      } catch (loadError) {
        if (!cancelled) setError(messageFromError(loadError));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, item.kind, item.itemId]);

  const copyExistingLink = useCallback(
    async (
      nextShareId: string,
      nextInviteId: string,
      materialB64: string,
      protectedLink: boolean,
    ) => {
      const url = baseUrl ?? (await getShareBaseUrl());
      const fragment = buildLinkShareFragment(
        nextInviteId,
        fromBase64Url(materialB64),
        protectedLink,
      );
      await navigator.clipboard.writeText(`${url}/s/${nextShareId}#${fragment}`);
      setBaseUrl(url);
      setCopied("link");
    },
    [baseUrl],
  );

  const handleCopyLink = useCallback(async () => {
    if (busyRef.current || loading || legacyShare || loadFailed) return;
    setError(null);
    setCopied(null);
    if (shareId && inviteId && linkMaterialB64) {
      try {
        await copyExistingLink(shareId, inviteId, linkMaterialB64, passwordProtected);
      } catch {
        setError("Couldn't copy the link. Try again.");
      }
      return;
    }
    if (requirePasscode && passcode.length < MIN_PASSCODE_LENGTH) {
      setError(`Use at least ${MIN_PASSCODE_LENGTH} characters for the passcode.`);
      return;
    }

    const startedItem = `${item.kind}:${item.itemId}`;
    busyRef.current = true;
    setBusy(true);
    let createdShareId: string | null = null;
    try {
      const contentKey = await generateKey();
      const salt = requirePasscode ? generatePasscodeSalt() : null;
      const linkKey = salt ? await derivePasscodeKey(passcode, salt) : await generateKey();
      const storedMaterial = salt ?? linkKey;
      const { ciphertext, iv } = await encryptPayload(contentKey, item.buildPayload());
      const { envelope, iv: envelopeIv } = await wrapKey(linkKey, contentKey);
      const created = await shareCreate({
        kind: item.kind,
        ciphertextB64: toBase64(ciphertext),
        ivB64: toBase64(iv),
        invites: [
          {
            email: LINK_EMAIL,
            envelopeB64: toBase64(envelope),
            envelopeIvB64: toBase64(envelopeIv),
          },
        ],
      });
      createdShareId = created.shareId;
      const createdInvite = created.invites[0];
      if (!createdInvite) throw new Error("June returned no share link.");
      const materialB64 = toBase64Url(storedMaterial);
      await shareKeySave({
        shareId: created.shareId,
        itemKind: item.kind,
        itemId: item.itemId,
        contentKeyB64: toBase64Url(contentKey),
      });
      await shareInviteKeySave({
        inviteId: createdInvite.inviteId,
        shareId: created.shareId,
        inviteKeyB64: materialB64,
      });
      if (activeItemRef.current === startedItem) {
        setShareId(created.shareId);
        setInviteId(createdInvite.inviteId);
        setLinkMaterialB64(materialB64);
        setPasswordProtected(Boolean(salt));
      }
      createdShareId = null;
      await copyExistingLink(created.shareId, createdInvite.inviteId, materialB64, Boolean(salt));
    } catch (createError) {
      if (createdShareId) await shareDelete(createdShareId).catch(() => {});
      if (activeItemRef.current === startedItem) setError(messageFromError(createError));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [
    copyExistingLink,
    inviteId,
    item,
    legacyShare,
    linkMaterialB64,
    loadFailed,
    loading,
    passcode,
    passwordProtected,
    requirePasscode,
    shareId,
  ]);

  const handleStopSharing = useCallback(async () => {
    if (!shareId) return;
    await shareDelete(shareId).catch((stopError) => {
      setError(messageFromError(stopError));
      throw stopError;
    });
    setShareId(null);
    setInviteId(null);
    setLinkMaterialB64(null);
    setPasswordProtected(false);
    setLegacyShare(false);
    setCopied(null);
  }, [shareId]);

  const handleClose = useCallback(() => {
    if (!busyRef.current) onClose();
  }, [onClose]);

  const itemNoun = item.kind === "note" ? "note" : "session";
  const hasLink = Boolean(shareId && inviteId && linkMaterialB64);

  return (
    <>
      <Dialog
        open={open}
        onClose={handleClose}
        disableBackdropClose={busy}
        title={`Share ${itemNoun}`}
        description={`Anyone with the link can view a snapshot of "${item.title || `Untitled ${itemNoun}`}".`}
        width={480}
        className="share-dialog"
        footer={
          <>
            {shareId ? (
              <button
                type="button"
                className="primary-action share-unshare"
                disabled={busy}
                onClick={() => setConfirmStop(true)}
              >
                Stop sharing
              </button>
            ) : null}
            <button
              type="button"
              className="primary-action primary-solid"
              disabled={busy}
              onClick={handleClose}
            >
              Done
            </button>
          </>
        }
      >
        <div className="dialog-body share-dialog-body">
          {loading ? <p className="share-dialog-caption">Loading share...</p> : null}
          {!loading && legacyShare ? (
            <p className="share-dialog-caption">
              This item uses the previous invite-only sharing model. Stop sharing it to create a
              simpler link.
            </p>
          ) : null}
          {!loading && !legacyShare && !hasLink ? (
            <label className="share-dialog-caption">
              <input
                type="checkbox"
                checked={requirePasscode}
                disabled={busy || loadFailed}
                onChange={(event) => {
                  setRequirePasscode(event.currentTarget.checked);
                  setError(null);
                }}
              />{" "}
              Require a passcode
            </label>
          ) : null}
          {!loading && !legacyShare && !hasLink && requirePasscode ? (
            <div className="share-invite-row">
              <label className="dialog-field-label" htmlFor="share-passcode">
                Passcode
              </label>
              <input
                id="share-passcode"
                className="dialog-input"
                type="password"
                autoComplete="new-password"
                disabled={loadFailed}
                value={passcode}
                placeholder="At least 8 characters"
                onChange={(event) => setPasscode(event.currentTarget.value)}
              />
              <p className="share-dialog-caption">
                June never stores this passcode. Send it separately from the link.
              </p>
            </div>
          ) : null}
          {!loading && !legacyShare ? (
            <button
              type="button"
              className="primary-action primary-solid"
              disabled={busy || loadFailed}
              onClick={() => void handleCopyLink()}
            >
              {busy ? "Creating link..." : copied === "link" ? "Link copied" : "Copy link"}
            </button>
          ) : null}
          {hasLink ? (
            <p className="share-dialog-caption">
              {passwordProtected
                ? "This link requires the passcode you chose. June does not store the passcode."
                : "Anyone with this encrypted link can view the snapshot without signing in."}
            </p>
          ) : null}
          {hasLink && passwordProtected && passcode ? (
            <button
              type="button"
              className="primary-action"
              onClick={() => {
                void navigator.clipboard.writeText(passcode).then(() => setCopied("passcode"));
              }}
            >
              {copied === "passcode" ? "Passcode copied" : "Copy passcode"}
            </button>
          ) : null}
          {error ? (
            <p className="share-dialog-error" role="alert">
              {error}
            </p>
          ) : null}
          <p className="share-dialog-caption">
            Shares are encrypted snapshots. Anyone can forward the link and passcode; stopping
            sharing disables the link for everyone.
          </p>
        </div>
      </Dialog>
      <ConfirmDialog
        open={confirmStop}
        onClose={() => setConfirmStop(false)}
        onConfirm={handleStopSharing}
        title="Stop sharing"
        description={`This shared ${itemNoun} will stop opening for everyone. This cannot erase content people already viewed or copied.`}
        confirmLabel="Stop sharing"
        confirmBusyLabel="Stopping..."
        destructive
      />
    </>
  );
}
