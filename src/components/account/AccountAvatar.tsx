import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import { osAccountsSetAvatarSeed } from "../../lib/tauri";
import type { AccountStatus } from "../../lib/tauri";

const ACCOUNT_AVATAR_VARIANT_STORAGE_PREFIX = "june:account-avatar-variant:";
const ACCOUNT_AVATAR_PENDING_STORAGE_PREFIX = "june:account-avatar-pending:";
const ACCOUNT_AVATAR_CHANGED_EVENT = "june://account-avatar-change";

type AccountAvatarStyle = CSSProperties & {
  "--avatar-cloud-x": string;
  "--avatar-cloud-y": string;
  "--avatar-cloud-angle": string;
  "--avatar-cloud-strength": string;
};

export function AccountAvatar({
  account,
  className,
}: {
  account: AccountStatus;
  className?: string;
}) {
  const { style } = useAccountAvatar(account);

  return (
    <span
      className={["account-avatar", className].filter(Boolean).join(" ")}
      style={style}
      aria-hidden
    />
  );
}

export function useAccountAvatar(account: AccountStatus) {
  const identity = accountAvatarIdentity(account);
  const userId = account.user?.id?.trim() || identity;
  const remoteSeed = supportedAccountAvatarSeed(account.user?.avatarSeed);
  const defaultSeed = resolvedAccountAvatarSeed(account.user?.avatarSeed, userId);
  const getSnapshot = useCallback(
    () =>
      readPendingAccountAvatarSeed(identity) ??
      (account.localDev ? readLocalAccountAvatarSeed(identity) : undefined) ??
      defaultSeed,
    [account.localDev, defaultSeed, identity],
  );
  const seed = useSyncExternalStore(subscribeAccountAvatar, getSnapshot, () => defaultSeed);

  useEffect(() => {
    if (remoteSeed && readPendingAccountAvatarSeed(identity) === remoteSeed) {
      clearPendingAccountAvatarSeed(identity);
    }
  }, [identity, remoteSeed]);

  return {
    style: accountAvatarStyle(seed),
    refresh: async () => {
      const next = createAccountAvatarSeed();
      if (account.signedIn && !account.localDev) {
        writePendingAccountAvatarSeed(identity, next);
      }
      writeLocalAccountAvatarSeed(identity, next);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(ACCOUNT_AVATAR_CHANGED_EVENT));
      }
      if (!account.signedIn || account.localDev) return undefined;
      return osAccountsSetAvatarSeed(next);
    },
  };
}

export function accountDisplayName(account: AccountStatus) {
  return (
    account.user?.displayName?.trim() ||
    account.user?.email?.trim() ||
    account.user?.handle?.trim() ||
    "Account"
  );
}

function accountAvatarIdentity(account: AccountStatus): string {
  return (
    account.user?.id?.trim() ||
    account.user?.email?.trim() ||
    account.user?.handle?.trim() ||
    accountDisplayName(account)
  );
}

export function accountAvatarStyle(seed: string): AccountAvatarStyle {
  return {
    "--avatar-cloud-x": `${seededInteger(seed, "x", 14, 40)}%`,
    "--avatar-cloud-y": `${seededInteger(seed, "y", 12, 38)}%`,
    "--avatar-cloud-angle": `${seededInteger(seed, "angle", 0, 359)}deg`,
    "--avatar-cloud-strength": `${seededInteger(seed, "strength", 42, 66)}%`,
  };
}

function seededInteger(seed: string, channel: string, min: number, max: number): number {
  const hash = avatarHash(`${seed}:${channel}`);
  const unit = hash / 0xffffffff;
  return Math.round(min + unit * (max - min));
}

function avatarHash(value: string): number {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function accountAvatarVariantStorageKey(identity: string): string {
  return `${ACCOUNT_AVATAR_VARIANT_STORAGE_PREFIX}${avatarHash(identity).toString(36)}`;
}

function accountAvatarPendingStorageKey(identity: string): string {
  return `${ACCOUNT_AVATAR_PENDING_STORAGE_PREFIX}${avatarHash(identity).toString(36)}`;
}

function readLocalAccountAvatarSeed(identity: string): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const stored = window.localStorage.getItem(accountAvatarVariantStorageKey(identity));
    return supportedAccountAvatarSeed(stored);
  } catch {
    return undefined;
  }
}

function writeLocalAccountAvatarSeed(identity: string, seed: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(accountAvatarVariantStorageKey(identity), seed);
  } catch {
    // A locked-down WebView can reject localStorage; the default remains usable.
  }
}

function readPendingAccountAvatarSeed(identity: string): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return supportedAccountAvatarSeed(
      window.localStorage.getItem(accountAvatarPendingStorageKey(identity)),
    );
  } catch {
    return undefined;
  }
}

function writePendingAccountAvatarSeed(identity: string, seed: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(accountAvatarPendingStorageKey(identity), seed);
  } catch {
    // A locked-down WebView can reject localStorage; the remote write can still succeed.
  }
}

function clearPendingAccountAvatarSeed(identity: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(accountAvatarPendingStorageKey(identity));
  } catch {
    // Best-effort reconciliation; a matching remote seed renders identically.
  }
}

export function supportedAccountAvatarSeed(value: string | null | undefined): string | undefined {
  if (!value?.startsWith("v1:") || value.length < 4 || value.length > 128) return undefined;
  const payload = value.slice(3);
  const isPrintableAscii = [...payload].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code <= 126;
  });
  return payload && isPrintableAscii ? value : undefined;
}

export function resolvedAccountAvatarSeed(
  avatarSeed: string | null | undefined,
  userId: string,
): string {
  return supportedAccountAvatarSeed(avatarSeed) ?? `v1:default:${userId}`;
}

export function createAccountAvatarSeed(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `v1:${hex}`;
}

function subscribeAccountAvatar(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (
      event.key?.startsWith(ACCOUNT_AVATAR_VARIANT_STORAGE_PREFIX) ||
      event.key?.startsWith(ACCOUNT_AVATAR_PENDING_STORAGE_PREFIX) ||
      event.key === null
    ) {
      onChange();
    }
  };
  window.addEventListener(ACCOUNT_AVATAR_CHANGED_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(ACCOUNT_AVATAR_CHANGED_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}
