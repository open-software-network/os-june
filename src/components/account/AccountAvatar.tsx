import { useCallback, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import type { AccountStatus } from "../../lib/tauri";

const ACCOUNT_AVATAR_VARIANT_STORAGE_PREFIX = "june:account-avatar-variant:";
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
  const getSnapshot = useCallback(() => readAccountAvatarVariant(identity), [identity]);
  const variant = useSyncExternalStore(subscribeAccountAvatar, getSnapshot, () => 0);

  return {
    style: accountAvatarStyle(identity, variant),
    refresh: () => {
      const current = readAccountAvatarVariant(identity);
      const next = current >= Number.MAX_SAFE_INTEGER ? 0 : current + 1;
      writeAccountAvatarVariant(identity, next);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(ACCOUNT_AVATAR_CHANGED_EVENT));
      }
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

function accountAvatarStyle(identity: string, variant: number): AccountAvatarStyle {
  const seed = `${identity}:${variant}`;

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

function readAccountAvatarVariant(identity: string): number {
  if (typeof window === "undefined") return 0;
  try {
    const stored = Number.parseInt(
      window.localStorage.getItem(accountAvatarVariantStorageKey(identity)) ?? "0",
      10,
    );
    return Number.isSafeInteger(stored) && stored >= 0 ? stored : 0;
  } catch {
    return 0;
  }
}

function writeAccountAvatarVariant(identity: string, variant: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(accountAvatarVariantStorageKey(identity), String(variant));
  } catch {
    // A locked-down WebView can reject localStorage; the default remains usable.
  }
}

function subscribeAccountAvatar(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key?.startsWith(ACCOUNT_AVATAR_VARIANT_STORAGE_PREFIX) || event.key === null) {
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
