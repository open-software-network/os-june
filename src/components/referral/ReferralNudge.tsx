import { IconCrossMedium } from "central-icons/IconCrossMedium";
import { useEffect, useState } from "react";
import type { ReferralNudgeMoment } from "../../lib/referral-nudge";
import { JuneGlassMark } from "../brand/JuneGlassMark";

export type { ReferralNudgeMoment };

/**
 * The referral delight nudge: a rare, dismissible invite card that appears at
 * moments June has just delivered value (5th meeting note, first successful
 * agent task, 25th dictation, positive feedback). Deliberately a small cousin
 * of the referral dialog's hero — the same terracotta gradient, grain, and
 * June mark — so clicking through into that dialog feels continuous.
 *
 * The card never auto-dismisses (a dictation lands while June is backgrounded;
 * the card waits to be found) and never steals focus. Trigger moments and
 * frequency caps live with the caller, not here.
 */

/** Fired on click-through; the sidebar owns the referral dialog and listens. */
export const OPEN_REFERRAL_DIALOG_EVENT = "june:open-referral-dialog";

const MOMENT_COPY: Record<ReferralNudgeMoment, { title: string; body: string }> = {
  meetings: {
    title: "Five meetings, all captured",
    body: "Know someone who lives in meetings? They get a free month of June, and when they subscribe, so do you.",
  },
  agent: {
    title: "Give a month, get a month",
    body: "Share June with a friend. They get a free month, and when they subscribe, so do you.",
  },
  dictation: {
    title: "Twenty-five dictations in",
    body: "Know someone who types too much? They get a free month of June, and when they subscribe, so do you.",
  },
  feedback: {
    title: "Glad you're enjoying June",
    body: "Share it with a friend. They get a free month, and when they subscribe, so do you.",
  },
};

/** Matches the card's --t-med exit transition. */
const EXIT_MS = 160;

export function ReferralNudge({
  moment,
  onInvite,
  onDismiss,
}: {
  moment: ReferralNudgeMoment;
  onInvite: () => void;
  onDismiss: () => void;
}) {
  // Dismiss plays a short fade-down before the caller unmounts the card;
  // click-through is immediate (the opening dialog covers the exit).
  const [leaving, setLeaving] = useState(false);
  const copy = MOMENT_COPY[moment];

  function dismiss() {
    if (leaving) return;
    setLeaving(true);
    window.setTimeout(onDismiss, EXIT_MS);
  }

  // Escape clears the card from anywhere — it must never demand a mouse trip
  // to its X. Dialogs keep first claim on the key: while one is open (it sits
  // above the card anyway), Escape belongs to it, not to us.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (document.querySelector('[role="dialog"]')) return;
      dismiss();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <aside className="referral-nudge" role="status" data-leaving={leaving || undefined}>
      <div className="referral-nudge-hero">
        {/* The sign-in surfaces' 3D glass mark, reprised at gift scale — the
            same object the user met at their first sign-in, now the thing
            they're invited to hand to a friend. Falls back to the flat
            gradient mark (recolored white via --brand below) without WebGL
            or under reduced motion. */}
        <span className="referral-nudge-mark-glass" aria-hidden>
          <JuneGlassMark />
        </span>
        <p className="referral-nudge-title">{copy.title}</p>
      </div>
      <button
        type="button"
        className="referral-nudge-dismiss"
        aria-label="Dismiss"
        onClick={dismiss}
      >
        <IconCrossMedium size={14} />
      </button>
      <div className="referral-nudge-body">
        <p className="referral-nudge-copy">{copy.body}</p>
      </div>
      <div className="referral-nudge-footer">
        <button
          type="button"
          className="primary-action primary-solid"
          onClick={onInvite}
          disabled={leaving}
        >
          Invite friends
        </button>
      </div>
    </aside>
  );
}
