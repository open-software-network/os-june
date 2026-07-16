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
  const remoteSeed = validAccountAvatarSeed(account.user?.avatarSeed);
  const getSnapshot = useCallback(
    () =>
      readPendingAccountAvatarSeed(identity) ?? remoteSeed ?? readLocalAccountAvatarSeed(identity),
    [identity, remoteSeed],
  );
  const seed = useSyncExternalStore(subscribeAccountAvatar, getSnapshot, () => `${identity}:0`);

  useEffect(() => {
    if (remoteSeed && readPendingAccountAvatarSeed(identity) === remoteSeed) {
      clearPendingAccountAvatarSeed(identity);
    }
  }, [identity, remoteSeed]);

  return {
    style: accountAvatarStyle(seed),
    refresh: async () => {
      const next = createAccountAvatarSeed();
      writeLocalAccountAvatarSeed(identity, next);
      if (account.signedIn && !account.localDev) {
        writePendingAccountAvatarSeed(identity, next);
      }
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

function accountAvatarStyle(seed: string): AccountAvatarStyle {
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

function readLocalAccountAvatarSeed(identity: string): string {
  if (typeof window === "undefined") return `${identity}:0`;
  try {
    const stored = window.localStorage.getItem(accountAvatarVariantStorageKey(identity));
    const legacyVariant = Number.parseInt(stored ?? "0", 10);
    if (stored !== null && /^\d+$/.test(stored)) {
      const variant = Number.isSafeInteger(legacyVariant) && legacyVariant >= 0 ? legacyVariant : 0;
      return `${identity}:${variant}`;
    }
    return validAccountAvatarSeed(stored) ?? `${identity}:0`;
  } catch {
    return `${identity}:0`;
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
    return validAccountAvatarSeed(
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

function validAccountAvatarSeed(value: string | null | undefined): string | undefined {
  const hasNonAscii = value ? [...value].some((character) => character.charCodeAt(0) > 127) : false;
  if (!value || value.length > 128 || hasNonAscii) return undefined;
  return value;
}

function createAccountAvatarSeed(): string {
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
