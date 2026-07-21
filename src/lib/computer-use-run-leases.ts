import { computerUseBeginRun, computerUseEndRun, computerUseStop } from "./tauri";

type LeaseEntry = {
  endPromise?: Promise<void>;
};

const leasesBySession = new Map<string, Map<string, LeaseEntry>>();
let lifecycleTail: Promise<void> | undefined;

function runLifecycleOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = lifecycleTail ? lifecycleTail.then(operation) : operation();
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  lifecycleTail = settled;
  void settled.then(() => {
    if (lifecycleTail === settled) lifecycleTail = undefined;
  });
  return result;
}

export function beginComputerUseRunLease(storedSessionId: string, leaseId: string): Promise<void> {
  return runLifecycleOperation(async () => {
    const existingLease = leasesBySession.get(storedSessionId)?.get(leaseId);
    if (existingLease) {
      if (!existingLease.endPromise) return;
      await existingLease.endPromise;
    }

    await computerUseBeginRun(leaseId);
    const leases = leasesBySession.get(storedSessionId) ?? new Map<string, LeaseEntry>();
    leases.set(leaseId, {});
    leasesBySession.set(storedSessionId, leases);
  });
}

export async function releaseComputerUseRunLease(
  storedSessionId: string,
  leaseId: string,
): Promise<void> {
  const leases = leasesBySession.get(storedSessionId);
  const lease = leases?.get(leaseId);
  if (!leases || !lease) return;

  if (!lease.endPromise) {
    const endPromise = computerUseEndRun(leaseId)
      .then(() => {
        if (leases.get(leaseId) !== lease) return;
        leases.delete(leaseId);
        if (leases.size === 0 && leasesBySession.get(storedSessionId) === leases) {
          leasesBySession.delete(storedSessionId);
        }
      })
      .catch((error: unknown) => {
        if (lease.endPromise === endPromise) lease.endPromise = undefined;
        throw error;
      });
    lease.endPromise = endPromise;
  }

  await lease.endPromise;
}

export async function releaseComputerUseRunsForSession(storedSessionId: string): Promise<void> {
  const leaseIds = [...(leasesBySession.get(storedSessionId)?.keys() ?? [])];
  await Promise.all(
    leaseIds.map((leaseId) => releaseComputerUseRunLease(storedSessionId, leaseId)),
  );
}

export function stopComputerUseRuns(): Promise<void> {
  return runLifecycleOperation(async () => {
    await computerUseStop();
    leasesBySession.clear();
  });
}

export function forgetComputerUseRunLeases(): void {
  leasesBySession.clear();
}
