import { writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { IconChainLink1 } from "central-icons/IconChainLink1";
import { useEffect, useRef, useState } from "react";

import { CopyStateIcon } from "../ui/CopyStateIcon";
import { HoverTip } from "../ui/HoverTip";

export function ShareLinkCopyAction({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const copyingRef = useRef(false);
  const copyResetTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    setCopied(false);
    if (copyResetTimerRef.current !== undefined) {
      window.clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = undefined;
    }
    return () => {
      if (copyResetTimerRef.current !== undefined) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    };
  }, [url]);

  async function copyShareLink() {
    if (copyingRef.current) return;
    copyingRef.current = true;
    try {
      await writeClipboardText(url);
      setCopied(true);
      if (copyResetTimerRef.current !== undefined) {
        window.clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copyResetTimerRef.current = undefined;
      }, 1600);
    } catch {
      // Keep the action retryable. The full Share dialog owns detailed errors.
    } finally {
      copyingRef.current = false;
    }
  }

  return (
    <HoverTip
      compact
      width={128}
      tip={copied ? "Copied" : "Copy share link"}
      forceOpen={copied}
      className="detail-breadcrumb-share-tip"
    >
      <button
        type="button"
        className="detail-breadcrumb-share"
        aria-label={copied ? "Share link copied" : "Copy share link"}
        data-copied={copied ? "true" : undefined}
        onClick={() => void copyShareLink()}
      >
        <CopyStateIcon copied={copied} idleIcon={<IconChainLink1 size={14} />} />
      </button>
    </HoverTip>
  );
}
