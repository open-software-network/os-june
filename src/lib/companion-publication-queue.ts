export type CompanionPublicationFailure = {
  error: unknown;
  eventType: "delta" | "status";
  storedSessionId: string;
};

type CompanionPublication = {
  eventType: CompanionPublicationFailure["eventType"];
  publish: () => Promise<void>;
  storedSessionId: string;
};

type CompanionPublicationQueueOptions = {
  isSessionPublishable: (storedSessionId: string) => Promise<boolean>;
  onFailure: (failure: CompanionPublicationFailure) => void;
};

export function createCompanionPublicationQueue({
  isSessionPublishable,
  onFailure,
}: CompanionPublicationQueueOptions) {
  const tails = new Map<string, Promise<void>>();

  function enqueue(publication: CompanionPublication): Promise<void> {
    const { eventType, publish, storedSessionId } = publication;
    const previous = tails.get(storedSessionId) ?? Promise.resolve();
    let current: Promise<void>;
    current = previous
      .then(async () => {
        if (!(await isSessionPublishable(storedSessionId))) return;
        await publish();
      })
      .catch((error: unknown) => {
        onFailure({ error, eventType, storedSessionId });
      })
      .finally(() => {
        if (tails.get(storedSessionId) === current) {
          tails.delete(storedSessionId);
        }
      });
    tails.set(storedSessionId, current);
    return current;
  }

  return { enqueue };
}
