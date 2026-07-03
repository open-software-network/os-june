import { IconBubbleText } from "central-icons/IconBubbleText";
import { IconBug } from "central-icons/IconBug";
import { IconFeature } from "central-icons/IconFeature";
import { IconBubbleText as IconBubbleTextFilled } from "central-icons-filled/IconBubbleText";
import { IconBug as IconBugFilled } from "central-icons-filled/IconBug";
import { IconFeature as IconFeatureFilled } from "central-icons-filled/IconFeature";

import type { ReportCategory } from "./reportCategory";

/** The glyph paired with each report category, in menus and (optionally) the
 * chip. Inherits `currentColor`, so callers tint it per category. */
export function CategoryIcon({
  category,
  size = 16,
  filled = false,
}: {
  category: ReportCategory;
  size?: number;
  filled?: boolean;
}) {
  if (filled) {
    if (category === "bug") return <IconBugFilled size={size} aria-hidden />;
    if (category === "feedback") return <IconBubbleTextFilled size={size} aria-hidden />;
    return <IconFeatureFilled size={size} aria-hidden />;
  }
  if (category === "bug") return <IconBug size={size} aria-hidden />;
  if (category === "feedback") return <IconBubbleText size={size} aria-hidden />;
  return <IconFeature size={size} aria-hidden />;
}
