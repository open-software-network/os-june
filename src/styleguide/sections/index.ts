// Section registry. Each entry drops into the nav + content pane. New
// Components / Patterns sections register here once they exist — keep the
// shape stable so they slot in with a { id, label, group, component } row.

import type { ComponentType } from "react";
import { Color } from "./Color";
import { Controls } from "./Controls";
import { Elevation } from "./Elevation";
import { Motion } from "./Motion";
import { Radius } from "./Radius";
import { Spacing } from "./Spacing";
import { Type } from "./Type";

export type SectionGroup = "Foundations" | "Components" | "Patterns";

export type Section = {
  id: string;
  label: string;
  group: SectionGroup;
  component: ComponentType;
};

export const SECTIONS: Section[] = [
  // Foundations -----------------------------------------------------------
  { id: "color", label: "Color", group: "Foundations", component: Color },
  { id: "type", label: "Type", group: "Foundations", component: Type },
  { id: "spacing", label: "Spacing", group: "Foundations", component: Spacing },
  { id: "radius", label: "Radius", group: "Foundations", component: Radius },
  { id: "elevation", label: "Elevation", group: "Foundations", component: Elevation },
  { id: "motion", label: "Motion", group: "Foundations", component: Motion },
  { id: "controls", label: "Controls", group: "Foundations", component: Controls },

  // Components ------------------------------------------------------------
  // (register real component sections here, e.g.
  //   { id: "buttons", label: "Buttons", group: "Components", component: Buttons })

  // Patterns --------------------------------------------------------------
  // (register real pattern sections here)
];

// Group labels rendered in the nav, in order. Groups with no registered
// sections yet show a placeholder row.
export const SECTION_GROUPS: SectionGroup[] = ["Foundations", "Components", "Patterns"];
