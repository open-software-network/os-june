// Dev-only console driver for the referral delight nudge card.
//
//   window.__referralNudge()             show the T2 agent variant
//   window.__referralNudge("meetings")   T1: 5th meeting note captured
//   window.__referralNudge("agent")      T2: first successful agent task
//   window.__referralNudge("dictation")  T3: 25th dictation landed
//   window.__referralNudge("feedback")   T4: positive feedback sent
//   window.__referralNudge("clear")      dismiss the card
//
// Parks the card bottom-left on any view so its styling, motion, and both
// actions can be inspected without earning a real delight moment. The
// "Invite friends" click-through opens the real referral dialog (signed-in
// accounts only; local-dev accounts skip the dialog by design). Never bundled
// in production: App gates the dynamic import on import.meta.env.DEV.

import type { ReferralNudgeMoment } from "../components/referral/ReferralNudge";

export type ReferralNudgeDemoApi = {
  /** Remove the window hook. */
  dispose: () => void;
};

const MOMENTS: ReferralNudgeMoment[] = ["meetings", "agent", "dictation", "feedback"];

const HELP = [
  "Referral delight nudge demo:",
  "  __referralNudge()             show the T2 agent variant",
  '  __referralNudge("meetings")   T1: 5th meeting note captured',
  '  __referralNudge("agent")      T2: first successful agent task',
  '  __referralNudge("dictation")  T3: 25th dictation landed',
  '  __referralNudge("feedback")   T4: positive feedback sent',
  '  __referralNudge("clear")      dismiss the card',
  "",
  "Parks the card bottom-left on any view. Dev only.",
].join("\n");

export function registerReferralNudgeDemo({
  setMoment,
}: {
  setMoment: (moment: ReferralNudgeMoment | null) => void;
}): ReferralNudgeDemoApi {
  const hook = (state?: string) => {
    if (state === "clear" || state === "stop") {
      setMoment(null);
      return "Referral nudge dismissed.";
    }
    if (state === undefined || state === "agent") {
      setMoment("agent");
      return 'Agent variant parked. __referralNudge("clear") to dismiss.';
    }
    if ((MOMENTS as string[]).includes(state)) {
      setMoment(state as ReferralNudgeMoment);
      return `${state} variant parked. __referralNudge("clear") to dismiss.`;
    }
    return HELP;
  };

  (window as unknown as Record<string, unknown>).__referralNudge = hook;

  function dispose() {
    delete (window as unknown as Record<string, unknown>).__referralNudge;
  }

  return { dispose };
}
