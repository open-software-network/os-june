import { IconGoogle } from "central-icons/IconGoogle";
import { IconLinear } from "central-icons/IconLinear";
import { IconNotion } from "central-icons/IconNotion";

const PROVIDER_ICONS = {
  google: IconGoogle,
  linear: IconLinear,
  notion: IconNotion,
} as const;

/** The monochrome provider icon (central-icons, currentColor). Shared by the
 * Connectors settings directory and approvals tray so provider identity renders
 * the same everywhere. */
export function ConnectorProviderIcon({
  provider,
  size = 18,
}: {
  provider: keyof typeof PROVIDER_ICONS;
  size?: number;
}) {
  const Icon = PROVIDER_ICONS[provider];
  return <Icon size={size} aria-hidden />;
}
