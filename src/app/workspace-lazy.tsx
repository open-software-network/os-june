import {
  Component,
  type ComponentProps,
  type ComponentType,
  createElement,
  lazy,
  type ReactNode,
  Suspense,
  useMemo,
  useState,
} from "react";

type WorkspaceLoader<Props extends object> = {
  Component: ComponentType<Props>;
  preload: () => Promise<void>;
};

export function createWorkspaceLoader<Module, Props extends object>(
  loadModule: () => Promise<Module>,
  selectComponent: (module: Module) => ComponentType<Props>,
): WorkspaceLoader<Props> {
  let modulePromise: Promise<Module> | undefined;

  function load() {
    modulePromise ??= Promise.resolve()
      .then(loadModule)
      .catch((error: unknown) => {
        modulePromise = undefined;
        throw error;
      });
    return modulePromise;
  }

  function createLazyComponent() {
    return lazy(async () => ({
      default: selectComponent(await load()),
    }));
  }

  const InitialLazyComponent = createLazyComponent();

  function WorkspaceRoute(props: Props) {
    const [attempt, setAttempt] = useState(0);
    const LazyComponent = useMemo(
      () => (attempt === 0 ? InitialLazyComponent : createLazyComponent()),
      [attempt],
    );
    const ComponentToRender = LazyComponent as unknown as ComponentType<Props>;

    return (
      <WorkspaceLoadErrorBoundary key={attempt} onRetry={() => setAttempt((value) => value + 1)}>
        <Suspense fallback={<WorkspaceFallback />}>
          {createElement(ComponentToRender, props)}
        </Suspense>
      </WorkspaceLoadErrorBoundary>
    );
  }

  return {
    Component: WorkspaceRoute,
    preload: async () => {
      await load();
    },
  };
}

type WorkspaceLoadErrorBoundaryProps = {
  children: ReactNode;
  onRetry: () => void;
};

class WorkspaceLoadErrorBoundary extends Component<
  WorkspaceLoadErrorBoundaryProps,
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return <WorkspaceLoadFailure onRetry={this.props.onRetry} />;
    }
    return this.props.children;
  }
}

function WorkspaceLoadFailure({ onRetry }: { onRetry: () => void }) {
  return (
    <section className="workspace-fallback workspace-load-error" role="alert">
      <h2>Couldn't open this view</h2>
      <p>June couldn't load this part of the app. Try again.</p>
      <button type="button" className="primary-action primary-solid" onClick={onRetry}>
        Try again
      </button>
    </section>
  );
}

type AgentWorkspaceModule = typeof import("../components/agent/AgentWorkspace");
type AgentWorkspaceProps = NonNullable<ComponentProps<AgentWorkspaceModule["AgentWorkspace"]>>;
type FoldersWorkspaceModule = typeof import("../components/folders/FoldersWorkspace");
type FoldersWorkspaceProps = ComponentProps<FoldersWorkspaceModule["FoldersWorkspace"]>;
type NoteEditorModule = typeof import("../components/note-editor/NoteEditor");
type NoteEditorProps = ComponentProps<NoteEditorModule["NoteEditor"]>;
type RoutinesViewModule = typeof import("../components/routines/RoutinesView");
type RoutinesViewProps = ComponentProps<RoutinesViewModule["RoutinesView"]>;
type AppSettingsModule = typeof import("../components/settings/AppSettings");
type AppSettingsProps = ComponentProps<AppSettingsModule["AppSettings"]>;

const agentWorkspace = createWorkspaceLoader<AgentWorkspaceModule, AgentWorkspaceProps>(
  () => import("../components/agent/AgentWorkspace"),
  (module) => module.AgentWorkspace,
);
const foldersWorkspace = createWorkspaceLoader<FoldersWorkspaceModule, FoldersWorkspaceProps>(
  () => import("../components/folders/FoldersWorkspace"),
  (module) => module.FoldersWorkspace,
);
const noteEditor = createWorkspaceLoader<NoteEditorModule, NoteEditorProps>(
  () => import("../components/note-editor/NoteEditor"),
  (module) => module.NoteEditor,
);
const routinesView = createWorkspaceLoader<RoutinesViewModule, RoutinesViewProps>(
  () => import("../components/routines/RoutinesView"),
  (module) => module.RoutinesView,
);
const appSettings = createWorkspaceLoader<AppSettingsModule, AppSettingsProps>(
  () => import("../components/settings/AppSettings"),
  (module) => module.AppSettings,
);

export const AgentWorkspaceRoute = agentWorkspace.Component;
export const FoldersWorkspaceRoute = foldersWorkspace.Component;
export const NoteEditorRoute = noteEditor.Component;
export const RoutinesViewRoute = routinesView.Component;
export const AppSettingsRoute = appSettings.Component;

const deferredWorkspacePreloads = [
  // Meeting-start navigation lands here, so queue the note editor first.
  noteEditor.preload,
  appSettings.preload,
  foldersWorkspace.preload,
  routinesView.preload,
];

type IdleCallbackWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

export function prefetchRemainingWorkspacesAfterPaint() {
  const idleWindow = window as IdleCallbackWindow;
  let cancelled = false;
  let idleHandle: number | undefined;
  let timeoutHandle: number | undefined;

  const runPrefetch = () => {
    if (cancelled) return;
    // Failed idle imports reset in load() and remain retryable on navigation.
    void Promise.allSettled(deferredWorkspacePreloads.map((preload) => preload()));
  };

  const frameHandle = window.requestAnimationFrame(() => {
    if (cancelled) return;
    if (idleWindow.requestIdleCallback) {
      idleHandle = idleWindow.requestIdleCallback(runPrefetch, { timeout: 1_500 });
      return;
    }
    timeoutHandle = window.setTimeout(runPrefetch, 0);
  });

  return () => {
    cancelled = true;
    window.cancelAnimationFrame(frameHandle);
    if (idleHandle !== undefined) idleWindow.cancelIdleCallback?.(idleHandle);
    if (timeoutHandle !== undefined) window.clearTimeout(timeoutHandle);
  };
}

function WorkspaceFallback() {
  return (
    <section className="workspace-fallback" aria-label="Loading view" aria-busy="true">
      <span className="workspace-fallback-title" />
      <div className="workspace-fallback-lines" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </section>
  );
}

export const preloadInitialWorkspace = agentWorkspace.preload;
