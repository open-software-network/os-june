import { scribeOpenVerifyPage } from "../../../lib/tauri";
import { StepActions, StepHeading } from "../StepChrome";

const PRIVACY_CARDS = [
  {
    title: "Local by default",
    body: "The agent runs on your Mac, built on open-source Hermes. Your files, sessions, and memory stay on your disk, never mirrored to a cloud.",
  },
  {
    title: "Private inference",
    body: "Prompts leave your Mac only for model inference, routed to zero-retention models by default. Nothing stored, nothing trained on. The few models that work differently say so on their label.",
  },
  {
    title: "Verifiable",
    body: "Our code is open source and our backend runs in a secure enclave. You don't have to trust us. You can check.",
  },
];

export function PrivacyStep({ onContinue }: { onContinue: () => void }) {
  return (
    <section className="onboarding-step">
      <StepHeading
        title="Private by architecture, not by promise"
        subtitle="Every layer of June defaults to private. The ones that matter most, you can verify."
      />
      <div className="onboarding-card-grid">
        {PRIVACY_CARDS.map((card) => (
          <article key={card.title} className="onboarding-info-card">
            <h2>{card.title}</h2>
            <p>{card.body}</p>
          </article>
        ))}
      </div>
      <p className="onboarding-footnote">
        <button
          type="button"
          className="onboarding-footnote-link"
          onClick={() => void scribeOpenVerifyPage().catch(() => undefined)}
        >
          Verify it yourself
        </button>: how routing, retention, and attestation work.
      </p>
      <StepActions onContinue={onContinue} />
    </section>
  );
}

export function DataPracticesStep({ onContinue }: { onContinue: () => void }) {
  return (
    <section className="onboarding-step">
      <StepHeading
        title="June doesn't collect your data"
        subtitle="We store only what it takes to run the service. Everything else stays yours."
      />
      <div className="onboarding-card-grid">
        <article className="onboarding-info-card">
          <h2>What we store</h2>
          <p>Your account, login, and billing records. That's the list.</p>
        </article>
        <article className="onboarding-info-card">
          <h2>What we never store</h2>
          <p>
            Your prompts, transcripts, files, and memory. They stay on your Mac,
            and inference runs through zero-retention models by default.
          </p>
        </article>
      </div>
      <StepActions onContinue={onContinue} />
    </section>
  );
}
