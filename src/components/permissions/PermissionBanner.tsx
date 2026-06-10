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
          onClick={() => {
            // Fire the helper's prompting check first: it registers the
            // dictation helper in the Accessibility list (so there's a toggle
            // to flip) and shows the native system dialog. Open the pane only
            // after that IPC resolves — sequenced, not concurrent, so the
            // registration lands before System Settings can steal focus from
            // the prompt. The pane is the fallback for repeat clicks, where
            // macOS suppresses the one-time dialog.
            void dictationHelperCommand({
              type: "request_accessibility_permission",
            })
              .catch(() => undefined)
              .finally(() => {
                void openPrivacySettings("accessibility");
              });
          }}
        >
          Open System Settings
        </button>
      </div>
    </section>
  );
}
