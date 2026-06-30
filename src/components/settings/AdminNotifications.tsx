import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { useEffect } from "react";
import type { AdminNotification } from "../../lib/hermes-admin";

/** How long a success notice stays before auto-dismissing. Errors never time
 * out. */
const NOTIFICATION_TOAST_MS = 4500;
/** Cap on simultaneously visible notices so a rapid burst of changes can't grow
 * the page. */
const MAX_VISIBLE_NOTIFICATIONS = 3;

/**
 * The one shared admin change-notice surface, rendered as toasts. A successful
 * change shows briefly then auto-dismisses so they never pile up; an error
 * stays until the user dismisses it (it must be seen). Newest first, capped.
 *
 * Decoupled from any per-surface state type: it takes the notifications and a
 * dismiss callback directly, so every admin section (installed skills, MCP
 * servers, the MCP catalog, the Skills Hub, toolsets, skill setup) renders its
 * change notices the same way.
 */
export function AdminNotifications({
  notifications,
  onDismiss,
}: {
  notifications: readonly AdminNotification[];
  onDismiss: (id: string) => void;
}) {
  // Success notices clear themselves a few seconds after activity settles;
  // errors are never timed out. Re-armed whenever the set changes.
  useEffect(() => {
    const timers = notifications
      .filter((note) => !note.isError)
      .map((note) =>
        window.setTimeout(() => onDismiss(note.id), NOTIFICATION_TOAST_MS),
      );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [notifications, onDismiss]);

  if (notifications.length === 0) return null;
  const visible = [...notifications]
    .reverse()
    .slice(0, MAX_VISIBLE_NOTIFICATIONS);
  return (
    <ul className="admin-notifications" aria-label="Recent changes">
      {visible.map((note) => (
        <li
          key={note.id}
          className="admin-notification"
          data-tone={note.isError ? "destructive" : "info"}
          role="status"
        >
          <span className="admin-notification-text">{note.message}</span>
          <button
            type="button"
            className="admin-notification-dismiss"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() => onDismiss(note.id)}
          >
            <IconCrossSmall size={13} ariaHidden />
          </button>
        </li>
      ))}
    </ul>
  );
}
