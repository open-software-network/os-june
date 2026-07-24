import type { AgentChatTurn } from "../../lib/agent-chat-runtime";
import { artifactsFromToolEvent } from "../../lib/hermes-artifact-store";
import type { JuneHermesEvent } from "../../lib/hermes-control-plane";
import type {
  HermesFilesystemEntry,
  HermesFilesystemSnapshot,
  ImportedHermesFile,
} from "../../lib/tauri";
import type { AgentArtifact } from "./chat-turns/AgentArtifactPanel";

export const ARTIFACT_INDEX_RECONCILE_INTERVAL_MS = 15_000;

type ArtifactMutation =
  | { revision: number; type: "upsert"; artifact: AgentArtifact }
  | { revision: number; type: "remove"; path: string }
  | {
      revision: number;
      type: "rename";
      previousPath: string;
      artifact: AgentArtifact;
    };

type ArtifactMutationInput =
  | { type: "upsert"; artifact: AgentArtifact }
  | { type: "remove"; path: string }
  | {
      type: "rename";
      previousPath: string;
      artifact: AgentArtifact;
    };

type AliasMatch = {
  nameArtifactIndexes: Set<number>;
  pathArtifactIndexes: Set<number>;
};

type AliasOutput = {
  nameArtifactIndexes: number[];
  pathArtifactIndexes: number[];
};

type AliasNode = {
  next: Map<string, number>;
  failure: number;
  outputIndexes: number[];
};

export type AgentArtifactIndex = {
  assignArtifactsToTurns(turns: AgentChatTurn[]): Map<string, AgentArtifact[]>;
  getArtifacts(): AgentArtifact[];
  getVersion(): number;
  recordToolEvent(event: JuneHermesEvent): boolean;
  reconcile(snapshot: HermesFilesystemSnapshot): void;
  refresh(scan: () => Promise<HermesFilesystemSnapshot>): Promise<void>;
  remove(path: string): void;
  rename(previousPath: string, artifact: AgentArtifact): void;
  shouldRefreshForEvent(event: JuneHermesEvent): boolean;
  subscribe(listener: () => void): () => void;
  upsert(artifact: AgentArtifact): void;
  upsertImportedFile(file: ImportedHermesFile): void;
};

/**
 * A mutable, workspace-scoped index of the exact flat file set returned by the
 * native filesystem snapshot. Full snapshots reconcile removals and external
 * changes; June-owned writes update the hot-path index immediately.
 */
export function createAgentArtifactIndex(): AgentArtifactIndex {
  let artifacts: AgentArtifact[] = [];
  let matcher = new ArtifactAliasMatcher([]);
  let version = 0;
  let revision = 0;
  let mutations: ArtifactMutation[] = [];
  let refreshInFlight: Promise<void> | null = null;
  let activeRefreshRevision: number | null = null;
  let refreshQueued = false;
  let queuedScan: (() => Promise<HermesFilesystemSnapshot>) | null = null;
  const listeners = new Set<() => void>();

  function publish(nextArtifacts: AgentArtifact[]) {
    if (artifactListsEqual(artifacts, nextArtifacts)) return;
    artifacts = nextArtifacts;
    matcher = new ArtifactAliasMatcher(artifacts);
    version += 1;
    for (const listener of listeners) listener();
  }

  function recordMutation(mutation: ArtifactMutationInput) {
    revision += 1;
    const nextMutation = { ...mutation, revision } as ArtifactMutation;
    mutations.push(nextMutation);
    publish(applyArtifactMutation(artifacts, nextMutation));
  }

  function applySnapshot(snapshot: HermesFilesystemSnapshot, startedRevision: number) {
    let nextArtifacts = artifactsFromFilesystemSnapshot(snapshot);
    const concurrentMutations = mutations.filter((mutation) => mutation.revision > startedRevision);
    for (const mutation of concurrentMutations) {
      nextArtifacts = applyArtifactMutation(nextArtifacts, mutation);
    }
    const appliedRevision = revision;
    publish(nextArtifacts);
    mutations = mutations.filter((mutation) => mutation.revision > appliedRevision);
  }

  function reconcile(snapshot: HermesFilesystemSnapshot) {
    applySnapshot(snapshot, revision);
  }

  function refresh(scan: () => Promise<HermesFilesystemSnapshot>) {
    if (refreshInFlight) {
      if (activeRefreshRevision === null || revision > activeRefreshRevision) {
        refreshQueued = true;
        queuedScan = scan;
      }
      return refreshInFlight;
    }
    const pending = (async () => {
      let nextScan = scan;
      do {
        refreshQueued = false;
        queuedScan = null;
        const startedRevision = revision;
        activeRefreshRevision = startedRevision;
        const snapshot = await nextScan();
        activeRefreshRevision = null;
        if (refreshQueued && revision > startedRevision) {
          nextScan = queuedScan ?? scan;
          continue;
        }
        applySnapshot(snapshot, startedRevision);
        nextScan = queuedScan ?? scan;
      } while (refreshQueued);
    })();
    const wrapped = pending.finally(() => {
      if (refreshInFlight === wrapped) {
        const trailingScan = refreshQueued ? (queuedScan ?? scan) : null;
        activeRefreshRevision = null;
        refreshInFlight = null;
        refreshQueued = false;
        queuedScan = null;
        // A caller can arrive after the scan loop exits but before this
        // cleanup microtask runs. Start its queued scan after releasing the
        // shared slot, and keep existing waiters pending through it.
        if (trailingScan) return refresh(trailingScan);
      }
    });
    refreshInFlight = wrapped;
    return wrapped;
  }

  function upsert(artifact: AgentArtifact) {
    const path = artifact.path.trim();
    const name = artifact.name.trim();
    if (!path || !name) return;
    recordMutation({
      type: "upsert",
      artifact: { ...artifact, name, path },
    });
  }

  function remove(path: string) {
    const normalized = path.trim();
    if (!normalized) return;
    recordMutation({ type: "remove", path: normalized });
  }

  function rename(previousPath: string, artifact: AgentArtifact) {
    const normalizedPreviousPath = previousPath.trim();
    const path = artifact.path.trim();
    const name = artifact.name.trim();
    if (!normalizedPreviousPath || !path || !name) return;
    recordMutation({
      type: "rename",
      previousPath: normalizedPreviousPath,
      artifact: { ...artifact, name, path },
    });
  }

  function upsertImportedFile(file: ImportedHermesFile) {
    upsert({
      name: file.name,
      path: file.path,
      rootLabel: file.rootLabel,
      size: file.size,
    });
  }

  function shouldRefreshForEvent(event: JuneHermesEvent) {
    if (event.kind !== "tool" || event.phase !== "complete") return false;
    const toolName = event.name?.toLowerCase() ?? "";
    if (
      /(delete|remove|rename|move|write|create|save|generate|export|edit|patch|append|replace)/.test(
        toolName,
      )
    ) {
      return true;
    }
    return artifactsFromToolEvent(event).some(
      (artifact) =>
        artifact.action !== "failed" &&
        artifact.action !== "read" &&
        artifact.kind !== "url" &&
        artifact.kind !== "directory",
    );
  }

  function recordToolEvent(event: JuneHermesEvent) {
    const shouldRefresh = shouldRefreshForEvent(event);
    if (shouldRefresh) revision += 1;
    return shouldRefresh;
  }

  function assignArtifactsToTurns(turns: AgentChatTurn[]) {
    return assignIndexedArtifactsToTurns(turns, artifacts, matcher);
  }

  return {
    assignArtifactsToTurns,
    getArtifacts: () => artifacts,
    getVersion: () => version,
    recordToolEvent,
    reconcile,
    refresh,
    remove,
    rename,
    shouldRefreshForEvent,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    upsert,
    upsertImportedFile,
  };
}

export function artifactsFromFilesystemSnapshot(
  snapshot: HermesFilesystemSnapshot | null,
): AgentArtifact[] {
  return (snapshot?.roots ?? []).flatMap((root) =>
    filesystemEntriesToArtifacts(root.entries, root.label),
  );
}

export function workspaceRelativeArtifactPath(path: string) {
  const workspaceMatch = path.match(/(?:^|[/\\])workspace[/\\](.+)$/);
  if (workspaceMatch?.[1]) return workspaceMatch[1];
  return path;
}

function filesystemEntriesToArtifacts(
  entries: HermesFilesystemEntry[],
  rootLabel: string,
): AgentArtifact[] {
  return entries.flatMap((entry) => {
    const children = filesystemEntriesToArtifacts(entry.children ?? [], rootLabel);
    if (entry.kind !== "file") return children;
    return [
      {
        name: entry.name,
        path: entry.path,
        rootLabel,
        size: entry.size,
      },
      ...children,
    ];
  });
}

function applyArtifactMutation(
  current: AgentArtifact[],
  mutation: ArtifactMutation,
): AgentArtifact[] {
  if (mutation.type === "remove") {
    return current.filter((artifact) => artifact.path !== mutation.path);
  }
  if (mutation.type === "rename") {
    const previousIndex = current.findIndex((artifact) => artifact.path === mutation.previousPath);
    const withoutPrevious = current.filter(
      (artifact) =>
        artifact.path !== mutation.previousPath && artifact.path !== mutation.artifact.path,
    );
    const insertionIndex =
      previousIndex === -1
        ? withoutPrevious.length
        : Math.min(previousIndex, withoutPrevious.length);
    withoutPrevious.splice(insertionIndex, 0, mutation.artifact);
    return withoutPrevious;
  }
  const existingIndex = current.findIndex((artifact) => artifact.path === mutation.artifact.path);
  if (existingIndex === -1) return [...current, mutation.artifact];
  const next = [...current];
  next[existingIndex] = { ...next[existingIndex], ...mutation.artifact };
  return next;
}

// Preserve the original first-mention semantics while querying only aliases
// present in each turn. User turns claim path mentions without rendering cards;
// assistant turns may also claim an unclaimed filename; inline media owns its
// matching file and suppresses the duplicate artifact card.
function assignIndexedArtifactsToTurns(
  turns: AgentChatTurn[],
  artifacts: AgentArtifact[],
  matcher: ArtifactAliasMatcher,
): Map<string, AgentArtifact[]> {
  const byTurn = new Map<string, AgentArtifact[]>();
  if (!artifacts.length) return byTurn;
  const claimedPaths = new Set<string>();
  const claimedNames = new Set<string>();
  const mediaPaths = new Set<string>();
  const mediaNames = new Set<string>();
  for (const turn of turns) {
    for (const part of turn.parts) {
      if (part.type !== "image" && part.type !== "video") continue;
      if (part.path) mediaPaths.add(part.path);
      else if (part.name) mediaNames.add(part.name.toLowerCase());
    }
  }

  for (const turn of turns) {
    const text = turn.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n")
      .toLowerCase();
    if (!text.trim()) continue;
    const matches = matcher.match(text);
    const candidateIndexes = Array.from(
      new Set([...matches.pathArtifactIndexes, ...matches.nameArtifactIndexes]),
    ).sort((left, right) => left - right);
    const mentioned: AgentArtifact[] = [];
    for (const artifactIndex of candidateIndexes) {
      const artifact = artifacts[artifactIndex];
      if (!artifact) continue;
      const name = artifact.name.toLowerCase();
      if (!name || claimedPaths.has(artifact.path)) continue;
      if (mediaPaths.has(artifact.path) || mediaNames.has(name)) continue;
      const pathMentioned = matches.pathArtifactIndexes.has(artifactIndex);
      const nameMentioned =
        turn.role === "assistant" &&
        !claimedNames.has(name) &&
        matches.nameArtifactIndexes.has(artifactIndex);
      if (!pathMentioned && !nameMentioned) continue;
      claimedPaths.add(artifact.path);
      claimedNames.add(name);
      if (turn.role === "assistant") mentioned.push(artifact);
    }
    if (mentioned.length) byTurn.set(turn.id, mentioned);
  }
  return byTurn;
}

/** Aho-Corasick matcher over normalized full-path, workspace-relative, and
 * filename aliases. It is rebuilt only when the indexed artifact set changes. */
class ArtifactAliasMatcher {
  private readonly nodes: AliasNode[] = [
    { next: new Map<string, number>(), failure: 0, outputIndexes: [] },
  ];
  private readonly outputs: AliasOutput[] = [];

  constructor(artifacts: AgentArtifact[]) {
    const outputsByAlias = new Map<string, AliasOutput>();
    artifacts.forEach((artifact, artifactIndex) => {
      addAlias(outputsByAlias, artifact.path.toLowerCase(), "pathArtifactIndexes", artifactIndex);
      addAlias(
        outputsByAlias,
        workspaceRelativeArtifactPath(artifact.path).toLowerCase(),
        "pathArtifactIndexes",
        artifactIndex,
      );
      addAlias(outputsByAlias, artifact.name.toLowerCase(), "nameArtifactIndexes", artifactIndex);
    });
    for (const [alias, output] of outputsByAlias) this.insert(alias, output);
    this.buildFailureLinks();
  }

  match(text: string): AliasMatch {
    const result: AliasMatch = {
      nameArtifactIndexes: new Set<number>(),
      pathArtifactIndexes: new Set<number>(),
    };
    let state = 0;
    for (const character of text) {
      while (state !== 0 && !this.nodes[state].next.has(character)) {
        state = this.nodes[state].failure;
      }
      state = this.nodes[state].next.get(character) ?? 0;
      for (const outputIndex of this.nodes[state].outputIndexes) {
        const output = this.outputs[outputIndex];
        if (!output) continue;
        for (const artifactIndex of output.nameArtifactIndexes) {
          result.nameArtifactIndexes.add(artifactIndex);
        }
        for (const artifactIndex of output.pathArtifactIndexes) {
          result.pathArtifactIndexes.add(artifactIndex);
        }
      }
    }
    return result;
  }

  private insert(alias: string, output: AliasOutput) {
    if (!alias) return;
    let state = 0;
    for (const character of alias) {
      const existing = this.nodes[state].next.get(character);
      if (existing !== undefined) {
        state = existing;
        continue;
      }
      const nextState = this.nodes.length;
      this.nodes.push({ next: new Map(), failure: 0, outputIndexes: [] });
      this.nodes[state].next.set(character, nextState);
      state = nextState;
    }
    const outputIndex = this.outputs.length;
    this.outputs.push(output);
    this.nodes[state].outputIndexes.push(outputIndex);
  }

  private buildFailureLinks() {
    const queue: number[] = [];
    for (const child of this.nodes[0].next.values()) {
      queue.push(child);
      this.nodes[child].failure = 0;
    }
    for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      const state = queue[queueIndex];
      for (const [character, child] of this.nodes[state].next) {
        queue.push(child);
        let failure = this.nodes[state].failure;
        while (failure !== 0 && !this.nodes[failure].next.has(character)) {
          failure = this.nodes[failure].failure;
        }
        this.nodes[child].failure = this.nodes[failure].next.get(character) ?? 0;
        this.nodes[child].outputIndexes.push(
          ...this.nodes[this.nodes[child].failure].outputIndexes,
        );
      }
    }
  }
}

function addAlias(
  outputsByAlias: Map<string, AliasOutput>,
  alias: string,
  kind: keyof AliasOutput,
  artifactIndex: number,
) {
  if (!alias) return;
  const output = outputsByAlias.get(alias) ?? {
    nameArtifactIndexes: [],
    pathArtifactIndexes: [],
  };
  if (!output[kind].includes(artifactIndex)) output[kind].push(artifactIndex);
  outputsByAlias.set(alias, output);
}

function artifactListsEqual(left: AgentArtifact[], right: AgentArtifact[]) {
  return (
    left.length === right.length &&
    left.every((artifact, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        artifact.name === candidate.name &&
        artifact.path === candidate.path &&
        artifact.rootLabel === candidate.rootLabel &&
        artifact.size === candidate.size
      );
    })
  );
}
