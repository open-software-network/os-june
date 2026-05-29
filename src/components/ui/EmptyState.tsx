import type { ReactNode } from "react";

/**
 * Shared empty-state surface: a quiet contained panel with a muted glyph, serif
 * title, supporting copy, and an optional full-width inset footer (e.g. the
 * dictation shortcut hints). Used anywhere a view has nothing to show yet, so
 * Dictation, Folders, etc. stay visually consistent.
 */
export function EmptyState({
  icon,
  title,
  description,
  footer,
  label,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Full-width inset panel below the content (e.g. shortcut hints). */
  footer?: ReactNode;
  /** Accessible label for the region. */
  label?: string;
}) {
  return (
    <section className="empty-state" aria-label={label}>
      <div className="empty-state-content">
        {icon ? (
          <span className="empty-state-icon" aria-hidden>
            {icon}
          </span>
        ) : null}
        <h2 className="empty-state-title">{title}</h2>
        {description ? (
          <p className="empty-state-description">{description}</p>
        ) : null}
      </div>
      {footer ? <div className="empty-state-footer">{footer}</div> : null}
    </section>
  );
}
