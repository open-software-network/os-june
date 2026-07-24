import { useSyncExternalStore } from "react";

type Listener = () => void;

export type CurrentDataPartition = {
  name: string;
  confirmed: boolean;
};

export const DEFAULT_DATA_PARTITION = "default";
export const DATA_PARTITION_CHANGED_EVENT = "june:data-partition-changed";
// Keep the legacy storage key so existing local data partition selection is
// preserved even though the removed UI concept is no longer exposed by name.
const CURRENT_DATA_PARTITION_STORAGE_KEY = "june:active-agent-profile";

export type DataPartitionChangedDetail = { partition: string };

let currentDataPartitionName = storedDataPartitionName();
let snapshot: CurrentDataPartition = { name: currentDataPartitionName, confirmed: true };
const listeners = new Set<Listener>();

function normalizeDataPartitionName(name: string | null | undefined) {
  return name?.trim() || DEFAULT_DATA_PARTITION;
}

function storedDataPartitionName() {
  try {
    return normalizeDataPartitionName(
      window.localStorage.getItem(CURRENT_DATA_PARTITION_STORAGE_KEY),
    );
  } catch {
    return DEFAULT_DATA_PARTITION;
  }
}

function emit() {
  for (const listener of listeners) listener();
}

export function dispatchDataPartitionChanged(partition: string) {
  window.dispatchEvent(
    new CustomEvent<DataPartitionChangedDetail>(DATA_PARTITION_CHANGED_EVENT, {
      detail: { partition: normalizeDataPartitionName(partition) },
    }),
  );
}

export function getCurrentDataPartitionName() {
  return currentDataPartitionName;
}

export function getCurrentDataPartition() {
  return snapshot;
}

export function isCurrentDataPartitionConfirmed() {
  return true;
}

export function useCurrentDataPartition() {
  return useSyncExternalStore(subscribe, getCurrentDataPartition, getCurrentDataPartition);
}

export function useCurrentDataPartitionName() {
  return useCurrentDataPartition().name;
}

export function setCurrentDataPartitionName(name: string) {
  const next = normalizeDataPartitionName(name);
  if (next === currentDataPartitionName) return;
  currentDataPartitionName = next;
  snapshot = { name: next, confirmed: true };
  try {
    window.localStorage.setItem(CURRENT_DATA_PARTITION_STORAGE_KEY, next);
  } catch {
    // Restricted WebViews may not expose storage. The in-memory partition still works.
  }
  emit();
}

export function refreshCurrentDataPartition() {
  setCurrentDataPartitionName(storedDataPartitionName());
  return Promise.resolve(currentDataPartitionName);
}

export function resetCurrentDataPartitionForTests() {
  currentDataPartitionName = DEFAULT_DATA_PARTITION;
  snapshot = { name: currentDataPartitionName, confirmed: true };
}

export function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
