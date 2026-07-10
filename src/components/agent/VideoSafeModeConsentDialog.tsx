import { useState } from "react";
import { Dialog } from "../ui/Dialog";

export type VideoSafeModeConsentDialogProps = {
  /** Skip this generation, leaving safe mode (and the draft) untouched. */
  onSkipVideo: (dontAskAgain: boolean) => void;
  /** Turn the shared safe switch off (images stop blurring too) and generate. */
  onTurnOffSafeMode: (dontAskAgain: boolean) => void;
  /** Close/Escape/backdrop: cancel the generation, don't touch settings. */
  onDismiss: () => void;
};

/** The video counterpart of ImageSafeModeConsentDialog. Venice cannot blur
 * video, so there is no "generate blurred" middle ground to offer: safe mode
 * on means the generation is skipped, and the only way to generate is to turn
 * the one shared safe switch off. */
export function VideoSafeModeConsentDialog({
  onSkipVideo,
  onTurnOffSafeMode,
  onDismiss,
}: VideoSafeModeConsentDialogProps) {
  const [dontAskAgain, setDontAskAgain] = useState(false);

  return (
    <Dialog
      open
      onClose={onDismiss}
      title="Safe mode is on"
      description="This prompt may include adult content. Safe mode can't blur videos, so June skips generating them instead. Turn safe mode off to generate this video (this also stops blurring images). You can change this anytime in Settings."
      initialFocusSelector="[data-video-safe-mode-primary]"
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
            data-video-safe-mode-primary
            onClick={() => onSkipVideo(dontAskAgain)}
          >
            Skip this video
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
