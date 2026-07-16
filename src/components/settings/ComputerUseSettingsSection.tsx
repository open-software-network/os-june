import { ComputerUseControl } from "../plugins/ComputerUseControl";

export function ComputerUseSettingsSection({
  onOpenModels,
  onOpenBilling,
}: {
  onOpenModels: () => void;
  onOpenBilling: () => void;
}) {
  return (
    <section className="settings-group" aria-labelledby="computer-use-heading">
      <header className="settings-page-header">
        <h2 id="computer-use-heading" className="settings-page-title">
          Computer use
        </h2>
        <p className="settings-page-blurb">
          Control the attended Mac app capability, macOS access, selected model, and emergency stop
          from one place.
        </p>
      </header>
      <div className="settings-card computer-use-settings-card">
        <ComputerUseControl
          surface="settings"
          onOpenModels={onOpenModels}
          onOpenBilling={onOpenBilling}
        />
      </div>
    </section>
  );
}
