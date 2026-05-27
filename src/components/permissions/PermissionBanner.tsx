import { IconLock } from "central-icons/IconLock";
import { openPrivacySettings } from "../../lib/tauri";

export function PermissionBanner() {
  return (
    <section
      className="message-card permission-banner"
      aria-label="Accessibility access needed"
    >
      <p className="permission-banner-message">
        <span className="permission-banner-eyebrow">
          <IconLock size={14} aria-hidden />
          Accessibility needed
        </span>
        <span className="permission-banner-body">
          Dictation can't paste into other apps until you grant access.
        </span>
      </p>
      <div className="permission-banner-actions">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            void openPrivacySettings("accessibility");
          }}
        >
          Open System Settings
        </button>
      </div>
    </section>
  );
}
