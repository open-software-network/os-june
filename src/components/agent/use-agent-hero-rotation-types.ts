import type * as React from "react";

export type useAgentHeroRotationDependencies = {
  draftRef: React.MutableRefObject<string>;
  heroChipsHoverRef: React.MutableRefObject<boolean>;
  heroMode: boolean;
  setHeroChipPhase: React.Dispatch<React.SetStateAction<"in" | "out">>;
  setHeroDeckStart: React.Dispatch<React.SetStateAction<number>>;
};
