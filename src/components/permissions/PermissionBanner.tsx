import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconLock } from "central-icons/IconLock";

export function PermissionBanner({
  onDismiss,
  onEnableAccessibility,
}: {
  onDismiss: () => void;
  onEnableAccessibility: () => void;
}) {
  return (
    <section
      className="message-card permission-banner"
      aria-label="Accessibility access needed"
    >
      <p className="permission-banner-message">
        <span className="permission-banner-eyebrow">
          <IconLock size={14} aria-hidden />
        </span>
        <span className="permission-banner-body">
          Dictation can't paste into other apps until you grant accessibility
          access.
        </span>
      </p>
      <div className="permission-banner-actions">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onEnableAccessibility}
        >
          Grant access
        </button>
        <button
          type="button"
          className="permission-banner-dismiss"
          aria-label="Dismiss accessibility reminder"
          title="Dismiss"
          onClick={onDismiss}
        >
          <IconCrossSmall size={14} aria-hidden />
        </button>
      </div>
    </section>
  );
}
