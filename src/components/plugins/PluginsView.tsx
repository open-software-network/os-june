import { ComputerUseControl } from "./ComputerUseControl";

export function PluginsView({
  onOpenModels,
  onOpenBilling,
}: {
  onOpenModels: () => void;
  onOpenBilling: () => void;
}) {
  return (
    <section className="settings-group" aria-labelledby="plugins-view-heading">
      <header className="settings-page-header">
        <h3 id="plugins-view-heading" className="settings-row-title">
          Plugins
        </h3>
        <p className="settings-page-blurb">
          Give June carefully scoped ways to work in other apps and services.
        </p>
      </header>
      <div className="plugins-grid">
        <article className="plugin-tile">
          <ComputerUseControl onOpenModels={onOpenModels} onOpenBilling={onOpenBilling} />
        </article>
      </div>
    </section>
  );
}
