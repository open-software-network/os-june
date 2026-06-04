import { IconLock } from "central-icons/IconLock";
import { dictationHelperCommand, openPrivacySettings } from "../../lib/tauri";

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
            // Fire the helper's prompting check first: it registers the
            // dictation helper in the Accessibility list (so there's a toggle
            // to flip) and shows the native system dialog. Then open the pane
            // as a reliable fallback for repeat clicks, where macOS suppresses
            // the one-time dialog.
            void dictationHelperCommand({
              type: "request_accessibility_permission",
            }).catch(() => undefined);
            void openPrivacySettings("accessibility");
          }}
        >
          Open System Settings
        </button>
      </div>
    </section>
  );
}
