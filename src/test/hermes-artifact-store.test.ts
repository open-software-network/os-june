import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyHermesEvent } from "../lib/hermes-control-plane";
import {
  ARTIFACTS_PER_SESSION_CAP,
  artifactsFromToolEvent,
  createHermesArtifactStore,
} from "../lib/hermes-artifact-store";

// Build a classified `tool` event from a raw `tool.*` frame — the store's only
// ingest input. Throws if the frame didn't classify as a tool event so a test
// can't silently feed the wrong kind.
function toolClassified(
  type: "tool.start" | "tool.progress" | "tool.complete",
  sessionId: string | undefined,
  payload?: Record<string, unknown>,
) {
  const event = classifyHermesEvent({ type, session_id: sessionId, payload });
  if (event.kind !== "tool") {
    throw new Error(`expected tool, got ${event.kind} for ${type}`);
  }
  return event;
}

describe("artifactsFromToolEvent", () => {
  it("extracts a created file from a tool-complete write_file payload", () => {
    const event = toolClassified("tool.complete", "s1", {
      name: "write_file",
      tool_call_id: "call-1",
      path: "/Users/me/project/notes.md",
    });
    const artifacts = artifactsFromToolEvent(event);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      kind: "file",
      action: "created",
      path: "/Users/me/project/notes.md",
      displayName: "notes.md",
      sourceToolCallId: "call-1",
    });
  });

  it("maps an edit tool to a modified file", () => {
    const event = toolClassified("tool.complete", "s1", {
      name: "edit_file",
      path: "/tmp/app.ts",
    });
    const [artifact] = artifactsFromToolEvent(event);
    expect(artifact.action).toBe("modified");
    expect(artifact.kind).toBe("file");
  });

  it("maps a read tool to a read file", () => {
    const event = toolClassified("tool.complete", "s1", {
      name: "read_file",
      path: "/tmp/config.json",
    });
    const [artifact] = artifactsFromToolEvent(event);
    expect(artifact.action).toBe("read");
  });

  it("marks an errored tool result as a failed access", () => {
    const event = toolClassified("tool.complete", "s1", {
      name: "write_file",
      path: "/root/protected.txt",
      error: "permission denied",
    });
    const [artifact] = artifactsFromToolEvent(event);
    expect(artifact.action).toBe("failed");
  });

  it("classifies a directory path as a directory artifact", () => {
    const event = toolClassified("tool.complete", "s1", {
      name: "list_directory",
      path: "/Users/me/project/src/",
    });
    const [artifact] = artifactsFromToolEvent(event);
    expect(artifact.kind).toBe("directory");
  });

  it("classifies an http url as a url artifact", () => {
    const event = toolClassified("tool.complete", "s1", {
      name: "fetch_url",
      url: "https://example.com/report.pdf",
    });
    const [artifact] = artifactsFromToolEvent(event);
    expect(artifact.kind).toBe("url");
    expect(artifact.path).toBe("https://example.com/report.pdf");
  });

  it("derives the display name from the path basename", () => {
    const event = toolClassified("tool.complete", "s1", {
      name: "write_file",
      path: "/a/b/c/deep-file.txt",
    });
    expect(artifactsFromToolEvent(event)[0].displayName).toBe("deep-file.txt");
  });

  it("ignores tool-start and tool-progress events (only completions matter)", () => {
    expect(
      artifactsFromToolEvent(
        toolClassified("tool.start", "s1", {
          name: "write_file",
          path: "/tmp/x.txt",
        }),
      ),
    ).toEqual([]);
    expect(
      artifactsFromToolEvent(
        toolClassified("tool.progress", "s1", {
          name: "write_file",
          path: "/tmp/x.txt",
        }),
      ),
    ).toEqual([]);
  });

  it("ignores tools with no recognizable file/url field (no prose parsing)", () => {
    const event = toolClassified("tool.complete", "s1", {
      name: "run_command",
      // A command string is prose, not a path — must NOT be parsed as one.
      command: "rm -rf /Users/me/secret && echo done",
      output: "done",
    });
    expect(artifactsFromToolEvent(event)).toEqual([]);
  });

  it("ignores a non-path destination (queue/channel/host, not a file)", () => {
    const event = toolClassified("tool.complete", "s1", {
      name: "send_to_queue",
      // A queue name is not a filesystem path — must NOT mint a phantom artifact.
      destination: "my-queue",
    });
    expect(artifactsFromToolEvent(event)).toEqual([]);
  });

  it("still extracts a path-shaped destination", () => {
    const event = toolClassified("tool.complete", "s1", {
      name: "copy_file",
      destination: "/tmp/out/report.txt",
    });
    const [artifact] = artifactsFromToolEvent(event);
    expect(artifact.path).toBe("/tmp/out/report.txt");
    expect(artifact.kind).toBe("file");
  });

  it("extracts multiple files from a known array field", () => {
    const event = toolClassified("tool.complete", "s1", {
      name: "write_files",
      paths: ["/tmp/a.txt", "/tmp/b.txt"],
    });
    const artifacts = artifactsFromToolEvent(event);
    expect(artifacts.map((a) => a.path)).toEqual(["/tmp/a.txt", "/tmp/b.txt"]);
  });

  it("treats an image extension as an image artifact", () => {
    const event = toolClassified("tool.complete", "s1", {
      name: "save_image",
      path: "/tmp/chart.png",
    });
    expect(artifactsFromToolEvent(event)[0].kind).toBe("image");
  });

  it("keeps a long workspace path verbatim through sanitize (not [redacted])", () => {
    // Regression for the value-shape secret backstop: a normal long workspace
    // path (single token, >31 chars) used to be masked by the classifier's
    // sanitize step, so the artifact pointed at "[redacted]". The classifier
    // here runs the real sanitize path, so this proves the real file survives.
    const path =
      "/Users/me/code/project/src/components/agent/AgentWorkspace.tsx";
    expect(path.length).toBeGreaterThan(31);
    const event = toolClassified("tool.complete", "s1", {
      name: "edit_file",
      path,
    });
    const [artifact] = artifactsFromToolEvent(event);
    expect(artifact.path).toBe(path);
    expect(artifact.path).not.toBe("[redacted]");
    expect(artifact.displayName).toBe("AgentWorkspace.tsx");
  });
});

describe("createHermesArtifactStore", () => {
  let now: number;

  function setNow(value: number): void {
    now = value;
    vi.setSystemTime(now);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    setNow(Date.UTC(2026, 5, 24, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a tool-complete event with a file path records one artifact for the session", () => {
    const store = createHermesArtifactStore();
    store.record(
      toolClassified("tool.complete", "s1", {
        name: "write_file",
        path: "/tmp/out.md",
      }),
      "sandboxed",
    );
    const artifacts = store.getRecordsForSession("s1");
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      sessionId: "s1",
      mode: "sandboxed",
      action: "created",
      path: "/tmp/out.md",
    });
    expect(typeof artifacts[0].id).toBe("string");
    expect(artifacts[0].createdAt).toBe(now);
  });

  it("the timeline shows the real long path, not [redacted]", () => {
    // End-to-end: classify (which sanitizes) -> store.record -> drawer read.
    // Proves the artifact a user clicks opens the real file.
    const store = createHermesArtifactStore();
    const path =
      "/Users/me/code/project/src/components/agent/AgentWorkspace.tsx";
    store.record(
      toolClassified("tool.complete", "s1", { name: "edit_file", path }),
      "unrestricted",
    );
    const [artifact] = store.getRecordsForSession("s1");
    expect(artifact.path).toBe(path);
    expect(artifact.path).not.toBe("[redacted]");
  });

  it("carries the session mode onto the artifact (unrestricted)", () => {
    const store = createHermesArtifactStore();
    store.record(
      toolClassified("tool.complete", "s2", {
        name: "write_file",
        path: "/etc/hosts",
      }),
      "unrestricted",
    );
    expect(store.getRecordsForSession("s2")[0].mode).toBe("unrestricted");
  });

  it("records a failed file access as a failed artifact", () => {
    const store = createHermesArtifactStore();
    store.record(
      toolClassified("tool.complete", "s1", {
        name: "read_file",
        path: "/root/secret",
        error: "EACCES",
      }),
      "sandboxed",
    );
    expect(store.getRecordsForSession("s1")[0].action).toBe("failed");
  });

  it("ignores events that produce no artifacts", () => {
    const store = createHermesArtifactStore();
    store.record(
      toolClassified("tool.complete", "s1", { name: "run_command" }),
      "sandboxed",
    );
    expect(store.getRecordsForSession("s1")).toEqual([]);
    expect(store.getVersion()).toBe(0);
  });

  it("ignores events with no session id", () => {
    const store = createHermesArtifactStore();
    store.record(
      toolClassified("tool.complete", undefined, {
        name: "write_file",
        path: "/tmp/x",
      }),
      "sandboxed",
    );
    expect(store.getVersion()).toBe(0);
  });

  it("keeps artifacts newest-first within a session", () => {
    const store = createHermesArtifactStore();
    store.record(
      toolClassified("tool.complete", "s1", {
        name: "write_file",
        path: "/tmp/first.txt",
      }),
      "sandboxed",
    );
    setNow(now + 1000);
    store.record(
      toolClassified("tool.complete", "s1", {
        name: "write_file",
        path: "/tmp/second.txt",
      }),
      "sandboxed",
    );
    const paths = store.getRecordsForSession("s1").map((a) => a.path);
    expect(paths).toEqual(["/tmp/second.txt", "/tmp/first.txt"]);
  });

  it("dedupes repeated identical actions on the same path (keeps the latest)", () => {
    const store = createHermesArtifactStore();
    const write = () =>
      store.record(
        toolClassified("tool.complete", "s1", {
          name: "write_file",
          path: "/tmp/same.txt",
        }),
        "sandboxed",
      );
    write();
    setNow(now + 1000);
    write();
    const artifacts = store.getRecordsForSession("s1");
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].createdAt).toBe(now);
  });

  it("bounds the per-session artifact list to the cap", () => {
    const store = createHermesArtifactStore();
    for (let i = 0; i < ARTIFACTS_PER_SESSION_CAP + 10; i += 1) {
      setNow(now + 1000);
      store.record(
        toolClassified("tool.complete", "s1", {
          name: "write_file",
          path: `/tmp/file-${i}.txt`,
        }),
        "sandboxed",
      );
    }
    expect(store.getRecordsForSession("s1")).toHaveLength(
      ARTIFACTS_PER_SESSION_CAP,
    );
  });

  it("keeps artifacts partitioned per session", () => {
    const store = createHermesArtifactStore();
    store.record(
      toolClassified("tool.complete", "s1", {
        name: "write_file",
        path: "/tmp/a.txt",
      }),
      "sandboxed",
    );
    store.record(
      toolClassified("tool.complete", "s2", {
        name: "write_file",
        path: "/tmp/b.txt",
      }),
      "unrestricted",
    );
    expect(store.getRecordsForSession("s1")).toHaveLength(1);
    expect(store.getRecordsForSession("s2")).toHaveLength(1);
    expect(store.getRecordsForSession("missing")).toEqual([]);
  });

  it("clears a session's artifacts", () => {
    const store = createHermesArtifactStore();
    store.record(
      toolClassified("tool.complete", "s1", {
        name: "write_file",
        path: "/tmp/a.txt",
      }),
      "sandboxed",
    );
    store.clearSession("s1");
    expect(store.getRecordsForSession("s1")).toEqual([]);
  });

  it("notifies subscribers and bumps the version on a recorded artifact", () => {
    const store = createHermesArtifactStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.record(
      toolClassified("tool.complete", "s1", {
        name: "write_file",
        path: "/tmp/a.txt",
      }),
      "sandboxed",
    );
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getVersion()).toBe(1);
    unsubscribe();
    store.record(
      toolClassified("tool.complete", "s1", {
        name: "write_file",
        path: "/tmp/b.txt",
      }),
      "sandboxed",
    );
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("counts the artifacts a session has touched", () => {
    const store = createHermesArtifactStore();
    expect(store.countForSession("s1")).toBe(0);
    store.record(
      toolClassified("tool.complete", "s1", {
        name: "write_file",
        path: "/tmp/a.txt",
      }),
      "sandboxed",
    );
    expect(store.countForSession("s1")).toBe(1);
  });
});
