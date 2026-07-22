import type * as React from "react";

export type UseRecordingEventsDependencies = {
  drainPendingMeetingStartRef: React.MutableRefObject<() => void>;
  meetingStartHandlerRef: React.MutableRefObject<
    (requestId: string, noteId: string) => Promise<boolean>
  >;
  meetingStartListenerRegisteredRef: React.MutableRefObject<boolean>;
  meetingStartReadyRef: React.MutableRefObject<boolean>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
};
