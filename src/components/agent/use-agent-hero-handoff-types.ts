import type * as React from "react";

export type UseAgentHeroHandoffDependencies = {
  composerBoxRef: React.MutableRefObject<HTMLDivElement | null>;
  heroExitRectRef: React.MutableRefObject<DOMRect | null>;
  heroExitViaThreadRef: React.MutableRefObject<boolean>;
  heroMode: boolean;
  listRef: React.MutableRefObject<HTMLDivElement | null>;
  prevHeroModeRef: React.MutableRefObject<boolean>;
};
