import { useState } from "react";
import { Dialog } from "../ui/Dialog";

export type ImageSafeModeConsentDialogProps = {
  /** "slash" = pre-generation (/image); "agent" = non-blocking, generation already running. */
  variant: "slash" | "agent";
  onKeepSafeMode: (dontAskAgain: boolean) => void;
  onTurnOffSafeMode: (dontAskAgain: boolean) => void;
  /** Close/Escape/backdrop. Slash flow treats this as cancel-generation. */
  onDismiss: () => void;
};

export function ImageSafeModeConsentDialog({
  variant,
  onKeepSafeMode,
  onTurnOffSafeMode,
  onDismiss,
}: ImageSafeModeConsentDialogProps) {
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const body =
    variant === "slash"
      ? "This prompt may include adult content, which safe mode blurs. Generate with safe mode on, or turn it off? You can change this anytime in Settings."
      : "June is generating an image that may include adult content, so it will be blurred. Keep safe mode on for future images, or turn it off? You can change this anytime in Settings.";

  return (
    <Dialog
      open
      onClose={onDismiss}
      title="Safe mode is on"
      description={body}
      initialFocusSelector="[data-image-safe-mode-primary]"
      footer={
        <>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => onTurnOffSafeMode(dontAskAgain)}
          >
            Turn off safe mode
          </button>
          <button
            type="button"
            className="primary-action"
            data-image-safe-mode-primary
            onClick={() => onKeepSafeMode(dontAskAgain)}
          >
            Keep safe mode on
          </button>
        </>
      }
    >
      <label className="image-safe-mode-consent-checkbox">
        <input
          type="checkbox"
          checked={dontAskAgain}
          onChange={(event) => setDontAskAgain(event.currentTarget.checked)}
        />
        <span>Don't ask again</span>
      </label>
    </Dialog>
  );
}
