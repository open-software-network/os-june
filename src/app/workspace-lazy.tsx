import { type ComponentProps, type ComponentType, createElement, lazy, Suspense } from "react";

type WorkspaceLoader<Props extends object> = {
  Component: ComponentType<Props>;
  preload: () => Promise<void>;
};

function createWorkspaceLoader<Module, Props extends object>(
  loadModule: () => Promise<Module>,
  selectComponent: (module: Module) => ComponentType<Props>,
): WorkspaceLoader<Props> {
  let loadedComponent: ComponentType<Props> | undefined;
  let modulePromise: Promise<Module> | undefined;

  function load() {
    modulePromise ??= loadModule().then((module) => {
      loadedComponent = selectComponent(module);
      return module;
    });
    return modulePromise;
  }

  const LazyComponent = lazy(async () => ({
    default: selectComponent(await load()),
  }));

  function CachedWorkspace(props: Props) {
    const Component = loadedComponent ?? (LazyComponent as unknown as ComponentType<Props>);
    return <Suspense fallback={<WorkspaceFallback />}>{createElement(Component, props)}</Suspense>;
  }

  return {
    Component: CachedWorkspace,
    preload: async () => {
      await load();
    },
  };
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
