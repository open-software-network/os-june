import { installStorageCompatibilityBridge } from "./storage-compat";

// This side effect must evaluate before App and its transitive imports. Some
// modules snapshot persisted values during module evaluation, so installing in
// main.tsx's body is already too late for an upgrade from a June-era key.
installStorageCompatibilityBridge();
