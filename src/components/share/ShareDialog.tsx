import { IconCircleInfo } from "central-icons/IconCircleInfo";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { IconEyeOpen } from "central-icons/IconEyeOpen";
import { IconEyeSlash } from "central-icons/IconEyeSlash";
import { useCallback, useEffect, useRef, useState } from "react";
import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";

import { describeShareError, isShareNotFoundError } from "../../lib/errors";
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
import { CopyLinkField } from "../ui/CopyLinkField";
import { CopyStateIcon } from "../ui/CopyStateIcon";
import { Dialog } from "../ui/Dialog";
import { HoverTip } from "../ui/HoverTip";
import { InlineNotice } from "../ui/InlineNotice";
import { Switch } from "../ui/Switch";

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
  onLinkChange,
  item,
}: {
  open: boolean;
  onClose: () => void;
  onLinkChange?: (url: string | null) => void;
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
  const [revealPasscode, setRevealPasscode] = useState(false);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState<"link" | "passcode" | null>(null);
  const [copying, setCopying] = useState(false);
  const [legacyShare, setLegacyShare] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);
  const [confirmStop, setConfirmStop] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const copyingRef = useRef(false);
  const copyResetTimerRef = useRef<number>();
  const activeItemRef = useRef(`${item.kind}:${item.itemId}`);
  const previousOpenRef = useRef(open);
  activeItemRef.current = `${item.kind}:${item.itemId}`;
  const shouldLoadShare = open || Boolean(onLinkChange);

  useEffect(() => {
    const wasOpen = previousOpenRef.current;
    previousOpenRef.current = open;
    if (open && !wasOpen) setLoadVersion((version) => version + 1);
  }, [open]);

  const clearCopyFeedback = useCallback(() => {
    if (copyResetTimerRef.current !== undefined) {
      window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = undefined;
    }
    setCopied(null);
  }, []);

  const showCopyFeedback = useCallback((kind: "link" | "passcode") => {
    if (copyResetTimerRef.current !== undefined) {
      window.clearTimeout(copyResetTimerRef.current);
    }
    setCopied(kind);
    copyResetTimerRef.current = window.setTimeout(() => {
      setCopied(null);
      copyResetTimerRef.current = undefined;
    }, 1600);
  }, []);

  useEffect(
    () => () => {
      if (copyResetTimerRef.current !== undefined) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!shouldLoadShare) return;
    const startedItem = `${item.kind}:${item.itemId}`;
    let cancelled = false;
    setLoading(true);
    setShareId(null);
    setInviteId(null);
    setLinkMaterialB64(null);
    setPasswordProtected(false);
    setRequirePasscode(false);
    setPasscode("");
    setRevealPasscode(false);
    clearCopyFeedback();
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
        if (!cancelled) setError(describeShareError(loadError));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shouldLoadShare, item.kind, item.itemId, clearCopyFeedback, loadVersion]);

  const copyExistingLink = useCallback(
    async (
      nextShareId: string,
      nextInviteId: string,
      materialB64: string,
      protectedLink: boolean,
      showFeedback = true,
    ) => {
      const url = baseUrl ?? (await getShareBaseUrl());
      const fragment = buildLinkShareFragment(
        nextInviteId,
        fromBase64Url(materialB64),
        protectedLink,
      );
      await writeClipboardText(`${url}/s/${nextShareId}#${fragment}`);
      setBaseUrl(url);
      if (showFeedback) showCopyFeedback("link");
    },
    [baseUrl, showCopyFeedback],
  );

  const runClipboardCopy = useCallback(async (copy: () => Promise<void>) => {
    copyingRef.current = true;
    setCopying(true);
    try {
      await copy();
    } finally {
      copyingRef.current = false;
      setCopying(false);
    }
  }, []);

  const handleCopyLink = useCallback(async () => {
    if (busyRef.current || copyingRef.current || loading || legacyShare || loadFailed) return;
    setError(null);
    clearCopyFeedback();
    if (shareId && inviteId && linkMaterialB64) {
      try {
        await runClipboardCopy(() =>
          copyExistingLink(shareId, inviteId, linkMaterialB64, passwordProtected),
        );
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
      createdShareId = null;
      if (activeItemRef.current === startedItem) {
        setShareId(created.shareId);
        setInviteId(createdInvite.inviteId);
        setLinkMaterialB64(materialB64);
        setPasswordProtected(Boolean(salt));
        try {
          await runClipboardCopy(() =>
            copyExistingLink(
              created.shareId,
              createdInvite.inviteId,
              materialB64,
              Boolean(salt),
              false,
            ),
          );
        } catch {
          setError("Link created, but couldn't copy it. Select Copy to try again.");
        }
      }
    } catch (createError) {
      if (createdShareId) await shareDelete(createdShareId).catch(() => {});
      if (activeItemRef.current === startedItem) setError(describeShareError(createError));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [
    copyExistingLink,
    clearCopyFeedback,
    inviteId,
    item,
    legacyShare,
    linkMaterialB64,
    loadFailed,
    loading,
    passcode,
    passwordProtected,
    requirePasscode,
    runClipboardCopy,
    shareId,
  ]);

  const handleCopyPasscode = useCallback(async () => {
    if (!passcode || busyRef.current || copyingRef.current) return;
    setError(null);
    clearCopyFeedback();
    try {
      await runClipboardCopy(() => writeClipboardText(passcode));
      showCopyFeedback("passcode");
    } catch {
      setError("Couldn't copy the passcode. Try again.");
    }
  }, [clearCopyFeedback, passcode, runClipboardCopy, showCopyFeedback]);

  const handleStopSharing = useCallback(async () => {
    if (!shareId) return;
    await shareDelete(shareId).catch((stopError) => {
      setError(describeShareError(stopError));
      throw stopError;
    });
    setShareId(null);
    setInviteId(null);
    setLinkMaterialB64(null);
    setPasswordProtected(false);
    setLegacyShare(false);
    clearCopyFeedback();
  }, [clearCopyFeedback, shareId]);

  const handleClose = useCallback(() => {
    if (!busyRef.current) onClose();
  }, [onClose]);

  const itemNoun = item.kind === "note" ? "note" : "session";
  const hasLink = Boolean(shareId && inviteId && linkMaterialB64);
  const requiresPasscode = requirePasscode || passwordProtected;
  const shareUrl =
    shareId && inviteId && linkMaterialB64 && baseUrl
      ? `${baseUrl}/s/${shareId}#${buildLinkShareFragment(
          inviteId,
          fromBase64Url(linkMaterialB64),
          passwordProtected,
        )}`
      : null;

  useEffect(() => {
    onLinkChange?.(shareUrl);
  }, [onLinkChange, shareUrl]);

  return (
    <>
      <Dialog
        open={open}
        onClose={handleClose}
        disableBackdropClose={busy}
        title={`Share ${itemNoun}`}
        description={`Anyone with the link${requiresPasscode ? " and passcode" : ""} can view an encrypted snapshot of "${item.title || `Untitled ${itemNoun}`}".${requiresPasscode ? " June never stores the passcode." : ""}`}
        width={480}
        className="share-dialog"
        footer={
          shareId ? (
            <button
              type="button"
              className="primary-action share-unshare"
              disabled={busy}
              onClick={() => setConfirmStop(true)}
            >
              Stop sharing
            </button>
          ) : !loading && !legacyShare ? (
            <button
              type="button"
              className="primary-action primary-solid"
              disabled={busy || loadFailed}
              onClick={() => void handleCopyLink()}
            >
              {busy ? "Creating link..." : "Create link"}
            </button>
          ) : undefined
        }
      >
        <div className="dialog-body share-dialog-body">
          {loading ? <p className="share-dialog-caption">Loading share...</p> : null}
          {!loading && legacyShare ? (
            <InlineNotice
              tone="info"
              aria-label="Legacy share notice"
              icon={<IconCircleInfo size={14} aria-hidden />}
              body="This item uses the previous invite-only sharing model. Stop sharing it to create a simpler link."
            />
          ) : null}
          {!loading && !legacyShare && !hasLink ? (
            <div className="share-dialog-section">
              <div className="share-option-row">
                <div className="share-option-info">
                  <span className="share-option-title" id="share-passcode-label">
                    Require a passcode
                  </span>
                  <span className="share-option-description">
                    June never stores the passcode. Send it separately.
                  </span>
                </div>
                <Switch
                  checked={requirePasscode}
                  disabled={busy || loadFailed}
                  aria-labelledby="share-passcode-label"
                  onCheckedChange={(next) => {
                    setRequirePasscode(next);
                    setError(null);
                  }}
                />
              </div>
              {requirePasscode ? (
                <div className="share-option-row">
                  <label className="share-option-title" htmlFor="share-passcode">
                    Passcode
                  </label>
                  <div className="share-passcode-control">
                    <input
                      id="share-passcode"
                      className="dialog-input"
                      type={revealPasscode ? "text" : "password"}
                      autoComplete="new-password"
                      disabled={loadFailed}
                      value={passcode}
                      placeholder="At least 8 characters"
                      onChange={(event) => setPasscode(event.currentTarget.value)}
                    />
                    <button
                      type="button"
                      className="icon-button share-passcode-reveal"
                      aria-label={revealPasscode ? "Hide passcode" : "Show passcode"}
                      aria-pressed={revealPasscode}
                      onClick={() => setRevealPasscode((value) => !value)}
                    >
                      {revealPasscode ? <IconEyeSlash size={16} /> : <IconEyeOpen size={16} />}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          {hasLink && shareUrl ? (
            <div className="share-link-block">
              <CopyLinkField
                value={shareUrl}
                label={`Share link for ${item.title || `Untitled ${itemNoun}`}`}
                copied={copied === "link"}
                disabled={busy || copying}
                onCopy={() => void handleCopyLink()}
              />
              {passwordProtected && passcode ? (
                <HoverTip
                  compact
                  width={112}
                  tip={copied === "passcode" ? "Copied" : "Copy passcode"}
                  forceOpen={copied === "passcode"}
                  suppressed={busy || copying}
                  className="share-link-copy-passcode-tip"
                >
                  <button
                    type="button"
                    className="share-link-copy-passcode"
                    aria-label={copied === "passcode" ? "Passcode copied" : "Copy passcode"}
                    data-copied={copied === "passcode" ? "true" : undefined}
                    disabled={busy || copying}
                    onClick={() => void handleCopyPasscode()}
                  >
                    <CopyStateIcon copied={copied === "passcode"} />
                    Copy passcode
                  </button>
                </HoverTip>
              ) : null}
            </div>
          ) : null}
          {error ? (
            <InlineNotice
              tone="destructive"
              role="alert"
              aria-label="Share error"
              icon={<IconExclamationCircle size={14} aria-hidden />}
              body={error}
            />
          ) : null}
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
