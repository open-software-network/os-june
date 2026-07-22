import { CopyStateIcon } from "./CopyStateIcon";
import { HoverTip } from "./HoverTip";

export function CopyLinkField({
  value,
  label,
  copied,
  disabled = false,
  onCopy,
  id,
}: {
  value: string;
  label: string;
  copied: boolean;
  disabled?: boolean;
  onCopy: () => void;
  id?: string;
}) {
  return (
    <div className="copy-link-field">
      <input
        id={id}
        className="copy-link-url"
        value={value}
        readOnly
        aria-label={label}
        onFocus={(event) => event.currentTarget.select()}
      />
      <HoverTip
        compact
        width={104}
        tip={copied ? "Copied" : "Copy link"}
        forceOpen={copied}
        suppressed={disabled}
        className="copy-link-action-tip"
      >
        <button
          type="button"
          className="copy-link-action"
          aria-label={copied ? "Link copied" : "Copy link"}
          data-copied={copied ? "true" : undefined}
          disabled={disabled}
          onClick={onCopy}
        >
          <CopyStateIcon copied={copied} />
        </button>
      </HoverTip>
    </div>
  );
}
