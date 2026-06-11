import { IconEyeSlash } from "central-icons-filled/IconEyeSlash";
import { IconLock } from "central-icons-filled/IconLock";
import { IconShieldCheck2 } from "central-icons-filled/IconShieldCheck2";
import { IconShieldCode } from "central-icons-filled/IconShieldCode";
import { StepActions, StepHeading, StepRows, StepSpot } from "../StepChrome";

const PRIVACY_ROWS = [
  {
    icon: <IconLock size={18} aria-hidden />,
    title: "Stays on your Mac",
    body: "Your files, notes, and memory live on your disk, nowhere else.",
  },
  {
    icon: <IconEyeSlash size={18} aria-hidden />,
    title: "Nothing stored, nothing trained on",
    body: "Prompts route to zero-retention models by default.",
  },
  {
    icon: <IconShieldCode size={18} aria-hidden />,
    title: "Check for yourself",
    body: "Open code, attested backend. You don't have to trust us.",
  },
];

export function PrivacyStep({ onContinue }: { onContinue: () => void }) {
  return (
    <section className="onboarding-step">
      <StepHeading
        art={
          <StepSpot>
            <IconShieldCheck2 size={26} aria-hidden />
          </StepSpot>
        }
        title="Private by design"
      />
      <StepRows items={PRIVACY_ROWS} />
      <p className="onboarding-footnote">
        <a
          href="https://opensoftware.network/privacy"
          target="_blank"
          rel="noreferrer"
        >
          Read how it works
        </a>
      </p>
      <StepActions onContinue={onContinue} />
    </section>
  );
}
