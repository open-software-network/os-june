import type { ReactNode } from "react";

/**
 * Shared empty-state surface: a quiet contained panel with a muted glyph, serif
 * title, supporting copy, and an optional action button under the copy. Used
 * anywhere a view has nothing to show yet, so Dictation, Routines, Agents,
 * etc. stay visually consistent.
 *
 * `action` and `footer` are different slots on purpose: calls to action live
 * in the content column, while the full-width inset footer is reserved for
 * supplementary reference material (the dictation shortcut hints) — a button
 * down there reads as a second surface rather than the next step.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  footer,
  label,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Call to action rendered in the content column, under the copy. */
  action?: ReactNode;
  /** Full-width inset panel below the content (e.g. shortcut hints). */
  footer?: ReactNode;
  /** Accessible label for the region. */
  label?: string;
  /** Extra class on the section — e.g. `empty-state-compact` to tighten the
   * vertical padding when the empty state sits inside an already-boxed card. */
  className?: string;
}) {
  return (
    <section className={`empty-state${className ? ` ${className}` : ""}`} aria-label={label}>
      <div className="empty-state-content">
        {icon ? (
          <span className="empty-state-icon" aria-hidden>
            {icon}
          </span>
        ) : null}
        <h2 className="empty-state-title">{title}</h2>
        {description ? <p className="empty-state-description">{description}</p> : null}
        {action ? <div className="empty-state-action">{action}</div> : null}
      </div>
      {footer ? <div className="empty-state-footer">{footer}</div> : null}
    </section>
  );
}
