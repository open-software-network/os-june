import { type HermesSkillInfo } from "../../../lib/tauri";
import { type HermesSessionDispatchReservation } from "../../../lib/hermes-session-dispatch-mutex";
import { type ReportCategory } from "./reportCategory";
import { type AgentWorkspaceErrorOptions } from "../agent-workspace-errors";
import { type CapturedSessionModelTarget } from "./follow-up-queue";
import type * as React from "react";

export type CreateComposerPreparationDependencies = {
  categoryRef: React.MutableRefObject<ReportCategory | null>;
  loadSkillCommands: (options?: { silent?: boolean }) => Promise<HermesSkillInfo[]>;
  runFileSlashCommand: (argument: string, commandText: string) => Promise<void>;
  runImageSlashCommand: (
    argument: string,
    commandText: string,
    modelTarget?: CapturedSessionModelTarget,
    dispatchReservation?: HermesSessionDispatchReservation,
  ) => Promise<void>;
  runModelSlashCommand: (
    argument: string,
    commandText: string,
    modelTarget?: CapturedSessionModelTarget,
  ) => Promise<void>;
  runVideoSlashCommand: (
    argument: string,
    commandText: string,
    modelTarget?: CapturedSessionModelTarget,
    dispatchReservation?: HermesSessionDispatchReservation,
  ) => Promise<void>;
  setError: (message: string | null, options?: AgentWorkspaceErrorOptions) => void;
};
