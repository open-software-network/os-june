import type { ReactNode } from "react";

export type InlineNoticeTone = "warning" | "destructive";

type InlineNoticeProps = {
  eyebrow: ReactNode;
  body: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  tone?: InlineNoticeTone;
  role?: "status" | "alert";
  className?: string;
  "aria-label"?: string;
};

export function InlineNotice({
  eyebrow,
  body,
  actions,
  icon,
  tone = "warning",
  role = "status",
  className,
  "aria-label": ariaLabel,
}: InlineNoticeProps) {
  const classes = ["inline-notice", className].filter(Boolean).join(" ");
  return (
    <section
      className={classes}
      data-tone={tone}
      role={role}
      aria-label={ariaLabel}
    >
      <p className="inline-notice-message">
        <span className="inline-notice-eyebrow">
          {icon}
          {eyebrow}
        </span>
        <span className="inline-notice-body">{body}</span>
      </p>
      {actions ? (
        <div className="inline-notice-actions">{actions}</div>
      ) : null}
    </section>
  );
}
