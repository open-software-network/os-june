import type * as React from "react";

export type useAgentHeroRotationDependencies = {
  composerHasContent: boolean;
  heroChipsHoverRef: React.MutableRefObject<boolean>;
  heroMode: boolean;
  setHeroChipPhase: React.Dispatch<React.SetStateAction<"in" | "out">>;
  setHeroDeckStart: React.Dispatch<React.SetStateAction<number>>;
};
