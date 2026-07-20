import { IconGithub } from "central-icons/IconGithub";
import { IconGoogle } from "central-icons/IconGoogle";
import { IconLinear } from "central-icons/IconLinear";

const PROVIDER_ICONS = {
  github: IconGithub,
  google: IconGoogle,
  linear: IconLinear,
} as const;

/** The monochrome brand mark for a connector provider (central-icons,
 * currentColor). Shared by the Connectors settings directory and the
 * approvals tray so provider identity renders the same everywhere. */
export function ConnectorProviderIcon({
  provider,
  size = 18,
}: {
  provider: "google" | "github" | "linear";
  size?: number;
}) {
  const Icon = PROVIDER_ICONS[provider];
  return <Icon size={size} aria-hidden />;
}
