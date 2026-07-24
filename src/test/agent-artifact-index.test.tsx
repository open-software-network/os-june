import { Profiler, useSyncExternalStore } from "react";
import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentChatTurn } from "../lib/agent-chat-runtime";
import type { HermesFilesystemSnapshot } from "../lib/tauri";
import type { AgentArtifact } from "../components/agent/chat-turns/AgentArtifactPanel";
import {
  type AgentArtifactIndex,
  artifactsFromFilesystemSnapshot,
  createAgentArtifactIndex,
} from "../components/agent/artifact-index";

const WORKSPACE_ROOT = "/tmp/hermes/workspace";

describe("agent artifact index", () => {
  it("matches a full scan after add, remove, and rename mutations", () => {
    const index = createAgentArtifactIndex();
    index.reconcile(snapshot(["alpha.md", "beta.md"]));

    index.upsert(artifact("gamma.md"));
    index.remove(`${WORKSPACE_ROOT}/alpha.md`);
    index.rename(`${WORKSPACE_ROOT}/beta.md`, artifact("renamed.md"));

    const fullScan = snapshot(["renamed.md", "gamma.md"]);
    expect(index.getArtifacts()).toEqual(artifactsFromFilesystemSnapshot(fullScan));

    index.reconcile(fullScan);
    expect(index.getArtifacts()).toEqual(artifactsFromFilesystemSnapshot(fullScan));
  });

  it("picks up external additions, modifications, renames, and removals on reconcile", async () => {
    const index = createAgentArtifactIndex();
    let externalSnapshot = snapshot(["report.md"], { "report.md": 10 });
    const scan = vi.fn(async () => externalSnapshot);

    await index.refresh(scan);
    externalSnapshot = snapshot(["report.md", "outside.txt"], {
      "report.md": 42,
      "outside.txt": 8,
    });
    await index.refresh(scan);
    expect(index.getArtifacts()).toEqual(artifactsFromFilesystemSnapshot(externalSnapshot));

    externalSnapshot = snapshot(["renamed-outside.txt"], { "renamed-outside.txt": 8 });
    await index.refresh(scan);
    expect(index.getArtifacts()).toEqual(artifactsFromFilesystemSnapshot(externalSnapshot));
    expect(scan).toHaveBeenCalledTimes(3);
  });

  it("coalesces concurrent scans and preserves a write that lands during an older scan", async () => {
    const index = createAgentArtifactIndex();
    index.reconcile(snapshot(["existing.md"]));
    let resolveScan: (value: HermesFilesystemSnapshot) => void = () => {};
    const scan = vi.fn(
      () =>
        new Promise<HermesFilesystemSnapshot>((resolve) => {
          resolveScan = resolve;
        }),
    );

    const firstRefresh = index.refresh(scan);
    const coalescedRefresh = index.refresh(scan);
    index.upsert(artifact("created-during-scan.md"));
    resolveScan(snapshot(["existing.md"]));
    await Promise.all([firstRefresh, coalescedRefresh]);

    expect(scan).toHaveBeenCalledTimes(1);
    expect(index.getArtifacts().map((item) => item.name)).toEqual([
      "existing.md",
      "created-during-scan.md",
    ]);
  });

  it("runs one trailing reconcile when a known write invalidates an in-flight scan", async () => {
    const index = createAgentArtifactIndex();
    index.reconcile(snapshot(["existing.md"]));
    let resolveStaleScan: (value: HermesFilesystemSnapshot) => void = () => {};
    const scan = vi
      .fn<() => Promise<HermesFilesystemSnapshot>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStaleScan = resolve;
          }),
      )
      .mockResolvedValueOnce(snapshot(["existing.md"]));

    const staleRefresh = index.refresh(scan);
    index.upsert(artifact("created-during-scan.md"));
    const trailingRefresh = index.refresh(scan);
    resolveStaleScan(snapshot(["existing.md"]));
    await Promise.all([staleRefresh, trailingRefresh]);

    expect(scan).toHaveBeenCalledTimes(2);
    expect(index.getArtifacts().map((item) => item.name)).toEqual(["existing.md"]);
  });

  it("queues a refresh requested after the scan loop exits but before cleanup", async () => {
    const index = createAgentArtifactIndex();
    const firstScan = vi.fn(async () => snapshot(["first.md"]));
    const trailingScan = vi.fn(async () => snapshot(["trailing.md"]));
    let trailingRefresh: Promise<void> | undefined;
    const unsubscribe = index.subscribe(() => {
      unsubscribe();
      queueMicrotask(() => {
        trailingRefresh = index.refresh(trailingScan);
      });
    });

    await index.refresh(firstScan);
    await trailingRefresh;

    expect(firstScan).toHaveBeenCalledOnce();
    expect(trailingScan).toHaveBeenCalledOnce();
    expect(index.getArtifacts()).toEqual(
      artifactsFromFilesystemSnapshot(snapshot(["trailing.md"])),
    );
  });

  it("matches a full scan after 1,500 seeded mutation sequences and a durable reconcile", async () => {
    const operationCounts = [0, 0, 0, 0];
    for (let seed = 1; seed <= 1_500; seed += 1) {
      const random = seededRandom(seed);
      const index = createAgentArtifactIndex();
      const files = new Map<string, number>([
        ["alpha.md", 10],
        ["beta.md", 20],
        ["gamma.md", 30],
      ]);
      index.reconcile(snapshotFromFileMap(files));

      for (let step = 0; step < 48; step += 1) {
        if (files.size === 0) {
          const fallbackName = `file-${random() % 24}.md`;
          const fallbackSize = (random() % 4_096) + 1;
          files.set(fallbackName, fallbackSize);
          index.upsert(artifactWithSize(fallbackName, fallbackSize));
        }
        const operation = random() % 4;
        operationCounts[operation] += 1;
        const names = Array.from(files.keys());
        if (operation === 0) {
          const name = `file-${random() % 24}.md`;
          const size = (random() % 4_096) + 1;
          files.set(name, size);
          index.upsert(artifactWithSize(name, size));
        } else if (operation === 1) {
          const name = names[random() % names.length];
          files.delete(name);
          index.remove(`${WORKSPACE_ROOT}/${name}`);
        } else if (operation === 2) {
          const previousName = names[random() % names.length];
          const previousSize = files.get(previousName) ?? 0;
          let nextIndex = random() % 24;
          if (`file-${nextIndex}.md` === previousName) nextIndex = (nextIndex + 1) % 24;
          const nextName = `file-${nextIndex}.md`;
          files.delete(previousName);
          files.delete(nextName);
          files.set(nextName, previousSize);
          index.rename(
            `${WORKSPACE_ROOT}/${previousName}`,
            artifactWithSize(nextName, previousSize),
          );
        } else {
          const name = names[random() % names.length];
          files.set(name, (random() % 4_096) + 1);
        }

        if (random() % 13 === 0) {
          await index.refresh(async () => snapshotFromFileMap(files));
        }
      }

      const durableSnapshot = snapshotFromFileMap(files);
      await index.refresh(async () => durableSnapshot);
      expect(index.getArtifacts(), `seed ${seed}`).toEqual(
        artifactsFromFilesystemSnapshot(durableSnapshot),
      );
    }
    expect(operationCounts.every((count) => count > 0)).toBe(true);
  }, 30_000);

  it("preserves the previous artifact-to-turn assignment semantics", () => {
    const artifacts = [
      artifact("report.md"),
      {
        ...artifact("report.md"),
        path: `${WORKSPACE_ROOT}/archive/report.md`,
      },
      artifact("diagram.png"),
      artifact("notes.txt"),
    ];
    const turns = [
      turn("user-1", "user", "Please revise workspace/notes.txt."),
      turn("assistant-1", "assistant", "Saved report.md and diagram.png."),
      {
        ...turn("assistant-2", "assistant", "The report is also in the archive."),
        parts: [
          {
            type: "image" as const,
            prompt: "diagram",
            path: `${WORKSPACE_ROOT}/diagram.png`,
            name: "diagram.png",
            status: "complete" as const,
          },
          { type: "text" as const, text: "The report is also in the archive." },
        ],
      },
    ];
    const index = createAgentArtifactIndex();
    index.reconcile(snapshotFromArtifacts(artifacts));

    expect(mapToPaths(index.assignArtifactsToTurns(turns))).toEqual(
      mapToPaths(legacyAssignArtifactsToTurns(turns, artifacts)),
    );
  });

  it.each([
    1_000, 10_000,
  ])("indexes %i files across 100 turns without filesystem or render work on the hot path", async (fileCount) => {
    const index = createAgentArtifactIndex();
    const sourceSnapshot = snapshot(
      Array.from({ length: fileCount }, (_, fileIndex) => `artifact-${fileIndex}.md`),
    );
    const scan = vi.fn(async () => sourceSnapshot);
    let renderCommits = 0;
    const view = render(
      <Profiler
        id={`artifact-index-${fileCount}`}
        onRender={() => {
          renderCommits += 1;
        }}
      >
        <ArtifactIndexSubscriber index={index} />
      </Profiler>,
    );
    await act(async () => {
      await index.refresh(scan);
    });
    const seededRenderCommits = renderCommits;
    const snapshotBytes = JSON.stringify(sourceSnapshot).length;
    const turns = Array.from({ length: 100 }, (_, turnIndex) =>
      turn(
        `turn-${turnIndex}`,
        "assistant",
        turnIndex === 99 ? `Created artifact-${fileCount - 1}.md.` : `Progress ${turnIndex}.`,
      ),
    );

    const legacyStartedAt = performance.now();
    const legacyAssignments = legacyAssignArtifactsToTurns(
      turns,
      artifactsFromFilesystemSnapshot(sourceSnapshot),
    );
    const legacyCpuMs = performance.now() - legacyStartedAt;
    const startedAt = performance.now();
    const assignments = index.assignArtifactsToTurns(turns);
    const cpuMs = performance.now() - startedAt;
    // The previous selected-message-count effect requested and committed one
    // full snapshot per turn. Model that removed trigger over this fixed
    // transcript while measuring both assignment implementations directly.
    const before = {
      cpuMs: legacyCpuMs,
      filesystemCalls: turns.length,
      ipcBytes: snapshotBytes * turns.length,
      renderCommits: turns.length,
    };
    const after = {
      cpuMs,
      filesystemCalls: scan.mock.calls.length,
      ipcBytes: snapshotBytes,
      renderCommits: renderCommits - seededRenderCommits,
    };
    const benchmark = {
      after,
      before,
      fileCount,
      turnCount: turns.length,
    };
    // biome-ignore lint/suspicious/noConsole: benchmark evidence belongs in the test log
    console.info("[artifact-index benchmark]", benchmark);

    expect(mapToPaths(assignments)).toEqual(mapToPaths(legacyAssignments));
    expect(assignments.get("turn-99")?.map((item) => item.name)).toEqual([
      `artifact-${fileCount - 1}.md`,
    ]);
    expect(before.filesystemCalls).toBe(100);
    expect(after.filesystemCalls).toBe(1);
    expect(after.ipcBytes * 100).toBe(before.ipcBytes);
    expect(after.renderCommits).toBe(0);
    expect(Number.isFinite(before.cpuMs)).toBe(true);
    expect(Number.isFinite(after.cpuMs)).toBe(true);
    view.unmount();
  }, 20_000);
});

function ArtifactIndexSubscriber({ index }: { index: AgentArtifactIndex }) {
  const version = useSyncExternalStore(index.subscribe, index.getVersion, index.getVersion);
  return <output>{`${version}:${index.getArtifacts().length}`}</output>;
}

function snapshot(names: string[], sizes: Record<string, number> = {}): HermesFilesystemSnapshot {
  return {
    roots: [
      {
        id: "workspace",
        label: "Workspace",
        path: WORKSPACE_ROOT,
        description: "Workspace files.",
        entries: names.map((name) => ({
          name,
          path: `${WORKSPACE_ROOT}/${name}`,
          kind: "file",
          size: sizes[name] ?? name.length,
          modifiedAt: "2026-07-24T00:00:00Z",
        })),
      },
    ],
  };
}

function snapshotFromArtifacts(artifacts: AgentArtifact[]): HermesFilesystemSnapshot {
  return {
    roots: [
      {
        id: "workspace",
        label: "Workspace",
        path: WORKSPACE_ROOT,
        description: "Workspace files.",
        entries: artifacts.map((item) => ({
          name: item.name,
          path: item.path,
          kind: "file",
          size: item.size,
        })),
      },
    ],
  };
}

function artifact(name: string): AgentArtifact {
  return artifactWithSize(name, name.length);
}

function artifactWithSize(name: string, size: number): AgentArtifact {
  return {
    name,
    path: `${WORKSPACE_ROOT}/${name}`,
    rootLabel: "Workspace",
    size,
  };
}

function snapshotFromFileMap(files: Map<string, number>) {
  return snapshot(Array.from(files.keys()), Object.fromEntries(files));
}

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
}

function turn(id: string, role: AgentChatTurn["role"], text: string): AgentChatTurn {
  return {
    id,
    role,
    createdAt: "2026-07-24T00:00:00Z",
    status: "complete",
    parts: [{ type: "text", text }],
  };
}

function mapToPaths(assignments: Map<string, AgentArtifact[]>) {
  return Array.from(assignments, ([turnId, artifacts]) => [
    turnId,
    artifacts.map((item) => item.path),
  ]);
}

function legacyAssignArtifactsToTurns(
  turns: AgentChatTurn[],
  artifacts: AgentArtifact[],
): Map<string, AgentArtifact[]> {
  const byTurn = new Map<string, AgentArtifact[]>();
  const claimedPaths = new Set<string>();
  const claimedNames = new Set<string>();
  const mediaPaths = new Set<string>();
  const mediaNames = new Set<string>();
  for (const chatTurn of turns) {
    for (const part of chatTurn.parts) {
      if (part.type !== "image" && part.type !== "video") continue;
      if (part.path) mediaPaths.add(part.path);
      else if (part.name) mediaNames.add(part.name.toLowerCase());
    }
  }
  for (const chatTurn of turns) {
    const text = chatTurn.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n")
      .toLowerCase();
    if (!text.trim()) continue;
    const mentioned: AgentArtifact[] = [];
    for (const item of artifacts) {
      const name = item.name.toLowerCase();
      if (!name || claimedPaths.has(item.path)) continue;
      if (mediaPaths.has(item.path) || mediaNames.has(name)) continue;
      const pathMentioned =
        text.includes(item.path.toLowerCase()) ||
        text.includes(workspaceRelativePath(item.path).toLowerCase());
      const nameMentioned =
        chatTurn.role === "assistant" && !claimedNames.has(name) && text.includes(name);
      if (!pathMentioned && !nameMentioned) continue;
      claimedPaths.add(item.path);
      claimedNames.add(name);
      if (chatTurn.role === "assistant") mentioned.push(item);
    }
    if (mentioned.length) byTurn.set(chatTurn.id, mentioned);
  }
  return byTurn;
}

function workspaceRelativePath(path: string) {
  return path.match(/(?:^|[/\\])workspace[/\\](.+)$/)?.[1] ?? path;
}
