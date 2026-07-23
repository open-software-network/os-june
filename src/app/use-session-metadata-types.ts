import type * as React from "react";

export type UseSessionMetadataDependencies = {
  appBlocked: boolean;
  bootstrapped: boolean;
  sessionCompletionTouchedRef: React.MutableRefObject<Set<string>>;
  setCompletedSessions: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setSessionFolders: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
};
