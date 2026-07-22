import { type ModelPickerFlyout } from "../settings/ModelPickerPopover";
import { type ComposerEditorHandle } from "./composer/ComposerEditor";
import type * as React from "react";

export type useComposerMenuDismissDependencies = {
  composerEditorRef: React.MutableRefObject<ComposerEditorHandle | null>;
  composerModelFlyout: ModelPickerFlyout;
  composerModelFromSlash: boolean;
  composerModelOpen: boolean;
  composerModelPopoverRef: React.RefObject<HTMLDivElement>;
  composerModelTriggerRef: React.RefObject<HTMLButtonElement>;
  modelRootSearch: string;
  setComposerModelFlyout: React.Dispatch<React.SetStateAction<ModelPickerFlyout>>;
  setComposerModelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setModelRootSearch: React.Dispatch<React.SetStateAction<string>>;
  setModelSearch: React.Dispatch<React.SetStateAction<string>>;
};
