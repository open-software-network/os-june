import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ComponentType, useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkspaceLoader,
  prefetchRemainingWorkspacesAfterPaint,
} from "../app/workspace-lazy";

const deferredImports = vi.hoisted(() => ({
  noteEditor: vi.fn(),
  settings: vi.fn(),
  folders: vi.fn(),
  routines: vi.fn(),
}));

vi.mock("../components/note-editor/NoteEditor", () => {
  deferredImports.noteEditor();
  return { NoteEditor: () => null };
});

vi.mock("../components/settings/AppSettings", () => {
  deferredImports.settings();
  return { AppSettings: () => null };
});

vi.mock("../components/folders/FoldersWorkspace", () => {
  deferredImports.folders();
  return { FoldersWorkspace: () => null };
});

vi.mock("../components/routines/RoutinesView", () => {
  deferredImports.routines();
  return { RoutinesView: () => null };
});

type ProbeProps = {
  label: string;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("lazy workspace routes", () => {
  it("keeps the resolved workspace mounted across parent renders", async () => {
    let resolveModule: ((module: { Probe: ComponentType<ProbeProps> }) => void) | undefined;
    const modulePromise = new Promise<{ Probe: ComponentType<ProbeProps> }>((resolve) => {
      resolveModule = resolve;
    });
    const mounted = vi.fn();
    const unmounted = vi.fn();

    function Probe({ label }: ProbeProps) {
      useEffect(() => {
        mounted();
        return unmounted;
      }, []);
      return <div data-testid="workspace-probe">{label}</div>;
    }

    const workspace = createWorkspaceLoader(
      () => modulePromise,
      (module) => module.Probe,
    );

    function Parent() {
      const [label, setLabel] = useState("First");
      return (
        <>
          <button type="button" onClick={() => setLabel("Second")}>
            Update parent
          </button>
          <workspace.Component label={label} />
        </>
      );
    }

    render(<Parent />);
    expect(screen.getByLabelText("Loading view")).toBeInTheDocument();

    await act(async () => resolveModule?.({ Probe }));
    const probe = await screen.findByTestId("workspace-probe");
    expect(mounted).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Update parent" }));

    expect(screen.getByTestId("workspace-probe")).toBe(probe);
    expect(screen.getByTestId("workspace-probe")).toHaveTextContent("Second");
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();
  });

  it("contains a rejected workspace import and retries it", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let attempts = 0;

    function Probe({ label }: ProbeProps) {
      return <div data-testid="workspace-probe">{label}</div>;
    }

    const workspace = createWorkspaceLoader(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("Chunk unavailable");
        return { Probe };
      },
      (module) => module.Probe,
    );

    render(<workspace.Component label="Recovered" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't open this view");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByTestId("workspace-probe")).toHaveTextContent("Recovered");
    expect(attempts).toBe(2);
    consoleError.mockRestore();
  });

  it("prefetches the remaining workspaces after paint during idle time", async () => {
    deferredImports.noteEditor.mockClear();
    deferredImports.settings.mockClear();
    deferredImports.folders.mockClear();
    deferredImports.routines.mockClear();

    let runIdle: (() => void) | undefined;
    const requestIdleCallback = vi.fn((callback: () => void) => {
      runIdle = callback;
      return 7;
    });
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 3;
    });

    prefetchRemainingWorkspacesAfterPaint();

    expect(requestIdleCallback).toHaveBeenCalledOnce();
    expect(deferredImports.noteEditor).not.toHaveBeenCalled();

    runIdle?.();

    await waitFor(() => {
      expect(deferredImports.noteEditor).toHaveBeenCalledOnce();
      expect(deferredImports.settings).toHaveBeenCalledOnce();
      expect(deferredImports.folders).toHaveBeenCalledOnce();
      expect(deferredImports.routines).toHaveBeenCalledOnce();
    });
  });
});
