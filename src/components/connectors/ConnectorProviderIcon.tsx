import { IconGithub } from "central-icons/IconGithub";
import { IconGoogle } from "central-icons/IconGoogle";

/** The monochrome brand mark for a connector provider (central-icons,
 * currentColor). Shared by the Connectors settings directory and the
 * approvals tray so provider identity renders the same everywhere. */
export function ConnectorProviderIcon({
  provider,
  size = 18,
}: {
  provider: "google" | "github";
  size?: number;
}) {
  if (provider === "github") return <IconGithub size={size} aria-hidden />;
  return <IconGoogle size={size} aria-hidden />;
}
