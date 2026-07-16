import { IconGoogle } from "central-icons/IconGoogle";
import { IconNotion } from "central-icons/IconNotion";

/** The monochrome provider icon (central-icons, currentColor). Shared by the
 * Connectors settings directory and approvals tray so provider identity renders
 * the same everywhere. */
export function ConnectorProviderIcon({
  provider,
  size = 18,
}: {
  provider: "google" | "notion";
  size?: number;
}) {
  if (provider === "notion") return <IconNotion size={size} aria-hidden />;
  return <IconGoogle size={size} aria-hidden />;
}
