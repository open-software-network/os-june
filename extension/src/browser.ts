import {
  PROTOCOL_VERSION,
  type BrowserRequestMessage,
  type BrowserResponseMessage,
  type ChunkMessage,
} from "./protocol";

const GROUP_TITLE = "June";
const MUTATION_BINDING = "__juneDomMutation";
const CHUNK_BYTES = 256 * 1024;
const INLINE_SNAPSHOT_BYTES = 384 * 1024;

function debuggerApi(): ChromeDebuggerApi {
  return (chrome as unknown as { debugger: ChromeDebuggerApi }).debugger;
}

type TaskTab = { tabId: number; epoch: number; refs: Set<string> };
type TaskSession = { tabs: Map<number, TaskTab>; activeTabId?: number; groupId?: number };

export class TaskTabRegistry {
  private sessions = new Map<string, TaskSession>();

  start(sessionId: string): void {
    if (this.sessions.has(sessionId))
      throw toolError("session_exists", "Browser session already exists.");
    this.sessions.set(sessionId, { tabs: new Map() });
  }

  session(sessionId: string): TaskSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw toolError("session_not_found", "Browser session was not found.");
    return session;
  }

  add(sessionId: string, tabId: number): TaskTab {
    const session = this.session(sessionId);
    const tab = { tabId, epoch: 0, refs: new Set<string>() };
    session.tabs.set(tabId, tab);
    session.activeTabId = tabId;
    return tab;
  }

  tab(sessionId: string, tabId: number): TaskTab {
    const tab = this.session(sessionId).tabs.get(tabId);
    if (!tab) throw toolError("tab_not_owned", "The tab is not owned by this Browser use session.");
    return tab;
  }

  invalidate(sessionId: string, tabId: number): number {
    const tab = this.tab(sessionId, tabId);
    tab.epoch += 1;
    tab.refs.clear();
    return tab.epoch;
  }

  setRefs(sessionId: string, tabId: number, epoch: number, refs: Iterable<string>): boolean {
    const tab = this.tab(sessionId, tabId);
    if (tab.epoch !== epoch) return false;
    tab.refs = new Set(refs);
    return true;
  }

  acceptsRef(sessionId: string, tabId: number, ref: string): boolean {
    return this.tab(sessionId, tabId).refs.has(ref);
  }

  removeTab(sessionId: string, tabId: number): void {
    const session = this.session(sessionId);
    session.tabs.delete(tabId);
    if (session.tabs.size === 0) session.groupId = undefined;
    if (session.activeTabId === tabId) session.activeTabId = session.tabs.keys().next().value;
  }

  removeSession(sessionId: string): number[] {
    const ids = [...this.session(sessionId).tabs.keys()];
    this.sessions.delete(sessionId);
    return ids;
  }

  find(tabId: number): { sessionId: string; tab: TaskTab } | null {
    for (const [sessionId, session] of this.sessions) {
      const tab = session.tabs.get(tabId);
      if (tab) return { sessionId, tab };
    }
    return null;
  }

  cleanupPlan(): number[] {
    return [...this.sessions.values()].flatMap((session) => [...session.tabs.keys()]);
  }

  clear(): void {
    this.sessions.clear();
  }
}

type ToolFailure = Error & { code: string };

function toolError(code: string, message: string): ToolFailure {
  return Object.assign(new Error(message), { code });
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0) {
    throw toolError("invalid_arguments", `${name} is required.`);
  }
  return value;
}

function tabArg(args: Record<string, unknown>): number {
  const value = args.tab_id;
  if (!Number.isInteger(value)) throw toolError("invalid_arguments", "tab_id is required.");
  return value as number;
}

function debuggerTarget(tabId: number): { tabId: number } {
  return { tabId };
}

async function cdp(tabId: number, method: string, commandParams?: Record<string, unknown>) {
  return debuggerApi().sendCommand(debuggerTarget(tabId), method, commandParams);
}

async function attach(tabId: number): Promise<void> {
  await debuggerApi().attach(debuggerTarget(tabId), "1.3");
  await cdp(tabId, "Page.enable");
  await cdp(tabId, "Runtime.enable");
  await cdp(tabId, "Runtime.addBinding", { name: MUTATION_BINDING });
  const installMutationObserver = `(() => {
      if (globalThis.__juneMutationObserver) return;
      globalThis.__juneMutationObserver = new MutationObserver(() => globalThis.${MUTATION_BINDING}());
      globalThis.__juneMutationObserver.observe(document, {subtree:true, childList:true, attributes:true, characterData:true});
    })()`;
  await cdp(tabId, "Page.addScriptToEvaluateOnNewDocument", { source: installMutationObserver });
  await cdp(tabId, "Runtime.evaluate", { expression: installMutationObserver });
}

async function detach(tabId: number): Promise<void> {
  try {
    await debuggerApi().detach(debuggerTarget(tabId));
  } catch {
    // The user may already have closed the tab or detached the debugger.
  }
}

async function closeTabs(tabIds: number[]): Promise<void> {
  await detachTabs(tabIds);
  if (tabIds.length > 0) {
    try {
      await chrome.tabs.remove(tabIds);
    } catch {
      // A tab can disappear between cleanup planning and removal.
    }
  }
}

async function detachTabs(tabIds: number[]): Promise<void> {
  await Promise.all(tabIds.map(detach));
}

async function clearTaskGroups(tabIds: number[]): Promise<void> {
  if (tabIds.length === 0) return;
  try {
    await chrome.tabs.ungroup(tabIds);
  } catch {
    // Tabs or their groups can disappear while the native host disconnects.
  }
}

async function waitUntilReady(tabId: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const result = (await cdp(tabId, "Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      })) as { result?: { value?: unknown } };
      if (result.result?.value === "complete" || result.result?.value === "interactive") return;
    } catch {
      // Navigation can replace the execution context between polling calls.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw toolError("navigation_timeout", "The page did not become ready in time.");
}

function interactiveRole(role?: string): boolean {
  return [
    "button",
    "checkbox",
    "combobox",
    "link",
    "menuitem",
    "radio",
    "searchbox",
    "slider",
    "spinbutton",
    "switch",
    "tab",
    "textbox",
  ].includes(role ?? "");
}

function axValue(value: unknown): string {
  if (typeof value === "object" && value !== null && "value" in value) {
    const inner = (value as { value?: unknown }).value;
    return typeof inner === "string" ? inner : String(inner ?? "");
  }
  return "";
}

function snapshotFromAx(raw: unknown, epoch: number) {
  const nodes = ((raw as { nodes?: unknown[] })?.nodes ?? []) as Array<Record<string, unknown>>;
  const refs: string[] = [];
  const lines: string[] = [];
  for (const node of nodes) {
    if (node.ignored === true) continue;
    const role = axValue(node.role);
    const name = axValue(node.name).trim();
    const value = axValue(node.value).trim();
    if (!name && !value) continue;
    let ref: string | undefined;
    if (interactiveRole(role)) {
      const stableId = node.backendDOMNodeId ?? node.nodeId;
      if (stableId !== undefined) {
        ref = `e${epoch}:n${String(stableId)}`;
        refs.push(ref);
      }
    }
    lines.push(
      `${ref ? `[${ref}] ` : ""}${role || "text"}: ${name}${value && value !== name ? ` = ${value}` : ""}`,
    );
  }
  return { epoch, text: lines.join("\n"), refs };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function chunkBytes(bytes: Uint8Array, chunkSize = CHUNK_BYTES): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytesToBase64(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length))));
  }
  return chunks;
}

function artifactMessages(
  id: number,
  bytes: Uint8Array,
  kind: "screenshot" | "snapshot",
  mimeType: string,
) {
  const chunks = chunkBytes(bytes).map<ChunkMessage>((data, index) => ({
    v: PROTOCOL_VERSION,
    type: "chunk",
    id,
    index,
    data,
  }));
  return {
    chunks,
    response: {
      v: PROTOCOL_VERSION,
      type: "response",
      id,
      success: true,
      data: { artifact: { kind, mimeType, byteLength: bytes.length, chunkCount: chunks.length } },
    } satisfies BrowserResponseMessage,
  };
}

export class BrowserController {
  readonly registry = new TaskTabRegistry();

  constructor() {
    debuggerApi().onEvent.addListener((source, method, params) => {
      if (
        (method === "Page.frameNavigated" || method === "Page.navigatedWithinDocument") &&
        source.tabId !== undefined
      ) {
        const owner = this.registry.find(source.tabId);
        if (owner) this.registry.invalidate(owner.sessionId, source.tabId);
        return;
      }
      if (
        method !== "Runtime.bindingCalled" ||
        params?.name !== MUTATION_BINDING ||
        source.tabId === undefined
      )
        return;
      const owner = this.registry.find(source.tabId);
      if (owner) this.registry.invalidate(owner.sessionId, source.tabId);
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
      const owner = this.registry.find(tabId);
      if (owner) this.registry.removeTab(owner.sessionId, tabId);
    });
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (changeInfo.groupId === undefined) return;
      const owner = this.registry.find(tabId);
      if (!owner) return;
      const expectedGroup = this.registry.session(owner.sessionId).groupId;
      if (changeInfo.groupId !== expectedGroup) {
        this.registry.removeTab(owner.sessionId, tabId);
        void detach(tabId);
      }
    });
    chrome.tabGroups.onUpdated.addListener((group) => {
      if (group.title === GROUP_TITLE) return;
      for (const tabId of this.registry.cleanupPlan()) {
        const owner = this.registry.find(tabId);
        if (!owner || this.registry.session(owner.sessionId).groupId !== group.id) continue;
        this.registry.removeTab(owner.sessionId, tabId);
        void detach(tabId);
      }
    });
  }

  async disconnect(): Promise<void> {
    const tabIds = this.registry.cleanupPlan();
    this.registry.clear();
    await detachTabs(tabIds);
    await clearTaskGroups(tabIds);
  }

  async execute(
    request: BrowserRequestMessage,
  ): Promise<{ chunks?: ChunkMessage[]; response: BrowserResponseMessage }> {
    const args = request.arguments;
    try {
      const data = await this.executeTool(request.tool, args);
      if ("artifact" in data) {
        return data.artifact as { chunks?: ChunkMessage[]; response: BrowserResponseMessage };
      }
      return {
        response: { v: PROTOCOL_VERSION, type: "response", id: request.id, success: true, data },
      };
    } catch (error) {
      const failure = error as Partial<ToolFailure>;
      return {
        response: {
          v: PROTOCOL_VERSION,
          type: "response",
          id: request.id,
          success: false,
          message: failure.message ?? "Browser request failed.",
          errorCode: failure.code ?? "extension_request_failed",
        },
      };
    }
  }

  private async requireMarkedTaskTab(sessionId: string, tabId: number): Promise<TaskTab> {
    const taskTab = this.registry.tab(sessionId, tabId);
    const expectedGroup = this.registry.session(sessionId).groupId;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (expectedGroup === undefined || tab.groupId !== expectedGroup) throw new Error("group");
      const group = await chrome.tabGroups.get(expectedGroup);
      if (group.title !== GROUP_TITLE) throw new Error("label");
      return taskTab;
    } catch {
      this.registry.removeTab(sessionId, tabId);
      await detach(tabId);
      throw toolError(
        "tab_not_owned",
        "The tab is no longer in this Browser use session's June group.",
      );
    }
  }

  private async executeTool(
    tool: BrowserRequestMessage["tool"],
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const sessionId = stringArg(args, "session_id");
    if (tool === "session_start") {
      this.registry.start(sessionId);
      return { sessionId };
    }
    if (tool === "session_close") {
      await closeTabs(this.registry.removeSession(sessionId));
      return { closed: true };
    }
    if (tool === "tab_open") {
      this.registry.session(sessionId);
      const created = await chrome.tabs.create({ url: "about:blank", active: true });
      if (created.id === undefined)
        throw toolError("tab_open_failed", "Chrome did not return a tab id.");
      const tabId = created.id;
      try {
        const session = this.registry.session(sessionId);
        const groupId = await chrome.tabs.group({ tabIds: [tabId], groupId: session.groupId });
        await chrome.tabGroups.update(groupId, { title: GROUP_TITLE });
        session.groupId = groupId;
        await attach(tabId);
        this.registry.add(sessionId, tabId);
        return { tabId, url: "about:blank" };
      } catch (error) {
        await closeTabs([tabId]);
        throw error;
      }
    }
    if (tool === "tabs_list") {
      const tabs = [];
      for (const ownedId of [...this.registry.session(sessionId).tabs.keys()]) {
        try {
          await this.requireMarkedTaskTab(sessionId, ownedId);
          const tab = await chrome.tabs.get(ownedId);
          tabs.push({ tabId: ownedId, title: tab.title ?? "", url: tab.url ?? "" });
        } catch {
          // A tab that left the June group is removed from ownership above.
        }
      }
      return { tabs, activeTabId: this.registry.session(sessionId).activeTabId };
    }
    const tabId = tabArg(args);
    const taskTab = await this.requireMarkedTaskTab(sessionId, tabId);
    if (tool === "tab_close") {
      this.registry.removeTab(sessionId, tabId);
      await closeTabs([tabId]);
      return { closed: true };
    }
    if (tool === "tab_switch") {
      await chrome.tabs.update(tabId, { active: true });
      this.registry.session(sessionId).activeTabId = tabId;
      return { tabId };
    }
    if (tool === "navigate") {
      const url = stringArg(args, "url");
      this.registry.invalidate(sessionId, tabId);
      await cdp(tabId, "Page.navigate", { url });
      await waitUntilReady(tabId);
      return { tabId, url };
    }
    if (tool === "snapshot") {
      const raw = await cdp(tabId, "Accessibility.getFullAXTree");
      const snapshot = snapshotFromAx(raw, taskTab.epoch);
      if (!this.registry.setRefs(sessionId, tabId, snapshot.epoch, snapshot.refs)) {
        throw toolError(
          "snapshot_invalidated",
          "The page changed while June was taking the snapshot. Take another snapshot.",
        );
      }
      const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
      if (bytes.length > INLINE_SNAPSHOT_BYTES) {
        return { artifact: artifactMessages(0, bytes, "snapshot", "application/json") };
      }
      return snapshot;
    }
    if (tool === "screenshot") {
      const result = (await cdp(tabId, "Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
      })) as { data?: string };
      if (typeof result.data !== "string")
        throw toolError("screenshot_failed", "Chrome returned no screenshot data.");
      const binary = atob(result.data);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      return { artifact: artifactMessages(0, bytes, "screenshot", "image/png") };
    }
    throw toolError("not_implemented", `${tool} is not implemented.`);
  }
}

export function withRequestId(
  id: number,
  result: { chunks?: ChunkMessage[]; response: BrowserResponseMessage },
): { chunks?: ChunkMessage[]; response: BrowserResponseMessage } {
  return {
    chunks: result.chunks?.map((chunk) => ({ ...chunk, id })),
    response: { ...result.response, id },
  };
}
