import { IconAnonymous } from "central-icons/IconAnonymous";
import { IconGhost2 } from "central-icons/IconGhost2";
import { IconLock } from "central-icons/IconLock";
import type { ModelPrivacyBadge } from "../../lib/model-privacy";
import { HoverTip } from "./HoverTip";

/**
 * The single chip for a model's privacy badge — the icon-by-mode (lock / ghost /
 * anonymous) plus its label. Shared by the model picker (`ModelMeta`), the chat
 * model hover cards (`ComposerModelCardContent`), the chat session bar
 * (`PrivacyModeBadge`), and the session usage panel so the surfaces stay
 * identical.
 *
 * `variant` picks the visual family: the default `"muted"` renders the quiet
 * `.model-trait-icon` chip; `"themed"` renders the brand-tinted pill
 * (`.agent-safety-badge`) the chat session bar uses. `size` shrinks the themed
 * pill: `"sm"` adds the `.agent-safety-badge-sm` modifier (a shorter pill for
 * dense rows like the usage panel's model row).
 *
 * `withTip` (default true) picks the wrapper: the tip variant wraps the chip in
 * a {@link HoverTip} carrying the badge's full description (focusable, with an
 * "label: description" aria-label) for standalone placements. Pass `withTip={false}`
 * when the chip already lives inside a hover card — a nested HoverTip would be
 * wrong there — to fall back to a plain span with a native `title` tooltip.
 */
export function ModelPrivacyChip({
  badge,
  withTip = true,
  variant = "muted",
  size = "md",
}: {
  badge: ModelPrivacyBadge;
  withTip?: boolean;
  variant?: "muted" | "themed";
  size?: "md" | "sm";
}) {
  // Themed pills key off the safety-badge family; the muted chip stays on the
  // trait-icon recipe. Only the themed pill honors the small modifier.
  const className =
    variant === "themed"
      ? size === "sm"
        ? "agent-safety-badge agent-safety-badge-sm"
        : "agent-safety-badge"
      : "model-trait-icon";

  // The small themed pill drops the icon a notch to stay optically centered in
  // its shorter height; every other placement keeps the 13/14px icon.
  const iconSize = size === "sm" ? 12 : variant === "themed" ? 13 : 14;

  const icon =
    badge.mode === "e2ee" ? (
      <IconLock size={iconSize} aria-hidden />
    ) : badge.mode === "private" ? (
      <IconGhost2 size={iconSize} aria-hidden />
    ) : (
      <IconAnonymous size={iconSize} aria-hidden />
    );

  if (!withTip) {
    return (
      <span className={className} data-mode={badge.mode} title={badge.description}>
        {icon}
        <span>{badge.label}</span>
      </span>
    );
  }

  return (
    <HoverTip
      tip={badge.description}
      className={className}
      data-mode={badge.mode}
      tabIndex={0}
      aria-label={`${badge.label}: ${badge.description}`}
    >
      {icon}
      <span>{badge.label}</span>
    </HoverTip>
  );
}
