import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadEvent } from "../lib/updater";
import {
  checkJuneUpdate,
  getReleaseChannel,
  reconcileToStable,
  relaunchJune,
  setReleaseChannel,
} from "../lib/updater";

// A minimal stand-in for @tauri-apps/api/core's Channel: the install command
// drives progress by calling the channel's onmessage, exactly as Rust's
// `Channel::send` does at runtime.
vi.mock("@tauri-apps/api/core", () => {
  class Channel<T> {
    onmessage: ((message: T) => void) | null = null;
  }
  return { Channel, invoke: vi.fn() };
});

const invokeMock = vi.mocked(invoke);

// install_update receives a progress Channel under `onEvent`; invoke's args are
// loosely typed, so name the shape we assert against rather than inline-casting.
type InstallUpdateArgs = {
  onEvent: { onmessage: ((message: DownloadEvent) => void) | null };
};

beforeEach(() => {
  invokeMock.mockReset();
});

describe("checkJuneUpdate", () => {
  it("returns null when fetch_update reports nothing", async () => {
    invokeMock.mockResolvedValueOnce(null);

    expect(await checkJuneUpdate()).toBeNull();
    // No channel argument (fetch_update reads the persisted channel in Rust);
    // reconcile=false keeps a routine check forward-only.
    expect(invokeMock).toHaveBeenCalledWith("fetch_update", {
      reconcile: false,
    });
  });

  it("returns a synthetic update carrying version and notes", async () => {
    invokeMock.mockResolvedValueOnce({ version: "1.2.3-rc.4", body: "notes" });

    const update = await checkJuneUpdate();

    expect(update?.version).toBe("1.2.3-rc.4");
    expect(update?.body).toBe("notes");
  });

  it("installs through install_update, forwarding progress events", async () => {
    invokeMock.mockResolvedValueOnce({ version: "1.2.3" });
    const update = await checkJuneUpdate();

    const seen: DownloadEvent[] = [];
    invokeMock.mockImplementationOnce(async (_command, args) => {
      const { onEvent } = args as unknown as InstallUpdateArgs;
      onEvent.onmessage?.({ event: "Started", data: { contentLength: 10 } });
      onEvent.onmessage?.({ event: "Finished" });
    });

    await update?.downloadAndInstall((event) => seen.push(event));

    expect(invokeMock).toHaveBeenLastCalledWith(
      "install_update",
      expect.objectContaining({ onEvent: expect.anything() }),
    );
    expect(seen).toEqual([
      { event: "Started", data: { contentLength: 10 } },
      { event: "Finished" },
    ]);
  });
});

describe("reconcileToStable", () => {
  it("checks with reconcile=true so an older stable can install", async () => {
    invokeMock.mockResolvedValueOnce({ version: "1.2.2" });

    const update = await reconcileToStable();

    expect(update?.version).toBe("1.2.2");
    expect(invokeMock).toHaveBeenCalledWith("fetch_update", {
      reconcile: true,
    });
  });

  it("returns null when stable has nothing to reconcile onto", async () => {
    invokeMock.mockResolvedValueOnce(null);

    expect(await reconcileToStable()).toBeNull();
  });
});

describe("release channel setting", () => {
  it("reads the channel through get_release_channel", async () => {
    invokeMock.mockResolvedValueOnce("rc");

    expect(await getReleaseChannel()).toBe("rc");
    expect(invokeMock).toHaveBeenCalledWith("get_release_channel");
  });

  it("persists the channel through set_release_channel", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await setReleaseChannel("rc");

    expect(invokeMock).toHaveBeenCalledWith("set_release_channel", {
      channel: "rc",
    });
  });
});

describe("relaunchJune", () => {
  it("routes through the Rust command that tears down children first", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await relaunchJune();

    // Not the plugin `relaunch()`: the command runs the dictation-helper and
    // Hermes teardown before restarting so the relaunched instance is not
    // blocked by an orphaned helper (JUN-338).
    expect(invokeMock).toHaveBeenCalledWith("relaunch_for_update");
  });
});
