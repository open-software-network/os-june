import { IconGoogle } from "central-icons/IconGoogle";

/** The monochrome brand mark for a connector provider (central-icons,
 * currentColor). Shared by the Connectors settings directory and the
 * approvals tray so provider identity renders the same everywhere. */
export function ConnectorProviderIcon({ size = 18 }: { provider: "google"; size?: number }) {
  return <IconGoogle size={size} aria-hidden />;
}
