import { type JuneUpdate } from "../lib/updater";
import { type UpdateInstallProgress, type UpdatePromptPayload } from "./update-decision";
import type * as React from "react";

export type UseAppUpdateActionsDependencies = {
  checkingUpdateRef: React.MutableRefObject<boolean>;
  preparingUpdateRef: React.MutableRefObject<boolean>;
  readyUpdateRef: React.MutableRefObject<UpdatePromptPayload<JuneUpdate> | null>;
  relaunchingUpdateRef: React.MutableRefObject<boolean>;
  setCheckingUpdate: React.Dispatch<React.SetStateAction<boolean>>;
  setPreparingUpdate: React.Dispatch<React.SetStateAction<boolean>>;
  setReadyUpdate: React.Dispatch<React.SetStateAction<UpdatePromptPayload<JuneUpdate> | null>>;
  setUpdateProgress: React.Dispatch<React.SetStateAction<UpdateInstallProgress | null>>;
  setUpdateStatus: (status: string | null, failed?: boolean) => void;
  updateProgressHiddenRef: React.MutableRefObject<boolean>;
};
