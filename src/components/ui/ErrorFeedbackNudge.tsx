import type { ReactNode } from "react";
import { requestErrorFeedback } from "../../lib/error-feedback";

export const ERROR_FEEDBACK_NUDGE_TEXT =
  "Please send feedback if this looks like a bug. Your sessions stay private, and the team cannot view them, so your report is needed.";

type ErrorFeedbackNudgeProps = {
  className?: string;
  actionLabel?: ReactNode;
};

export function ErrorFeedbackNudge({
  className,
  actionLabel = "Send feedback",
}: ErrorFeedbackNudgeProps) {
  const classes = ["error-feedback-nudge", className].filter(Boolean).join(" ");

  return (
    <span className={classes}>
      <span>{ERROR_FEEDBACK_NUDGE_TEXT}</span>
      <button type="button" onClick={() => requestErrorFeedback()}>
        {actionLabel}
      </button>
    </span>
  );
}

type ErrorBannerProps = {
  children: ReactNode;
  className?: string;
};

export function ErrorBanner({ children, className }: ErrorBannerProps) {
  const classes = ["error-banner", className].filter(Boolean).join(" ");

  return (
    <div className={classes} role="alert">
      <p className="error-banner-message">{children}</p>
      <ErrorFeedbackNudge />
    </div>
  );
}

type SettingsRowErrorProps = {
  children: ReactNode;
  className?: string;
  id?: string;
};

export function SettingsRowError({
  children,
  className,
  id,
}: SettingsRowErrorProps) {
  const classes = ["settings-row-error", className].filter(Boolean).join(" ");

  return (
    <p id={id} className={classes}>
      <span className="settings-row-error-message">{children}</span>
      <ErrorFeedbackNudge className="settings-error-feedback" />
    </p>
  );
}
