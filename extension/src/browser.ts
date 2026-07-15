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

type TaskTab = {
  tabId: number;
  epoch: number;
  refs: Set<string>;
  ownership: "created" | "shared";
};
type TaskSession = { tabs: Map<number, TaskTab>; activeTabId?: number; groupId?: number };
type SessionCleanup = { created: number[]; shared: number[] };

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

  private add(sessionId: string, tabId: number, ownership: TaskTab["ownership"]): TaskTab {
    if (this.find(tabId))
      throw toolError("tab_already_owned", "The tab already belongs to a Browser use session.");
    const session = this.session(sessionId);
    const tab = { tabId, epoch: 0, refs: new Set<string>(), ownership };
    session.tabs.set(tabId, tab);
    session.activeTabId = tabId;
    return tab;
  }

  addCreated(sessionId: string, tabId: number): TaskTab {
    return this.add(sessionId, tabId, "created");
  }

  addShared(sessionId: string, tabId: number): TaskTab {
    return this.add(sessionId, tabId, "shared");
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

  removeSession(sessionId: string): SessionCleanup {
    const cleanup: SessionCleanup = { created: [], shared: [] };
    for (const tab of this.session(sessionId).tabs.values()) {
      cleanup[tab.ownership].push(tab.tabId);
    }
    this.sessions.delete(sessionId);
    return cleanup;
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

  createdTabs(): number[] {
    return [...this.sessions.values()].flatMap((session) =>
      [...session.tabs.values()]
        .filter((tab) => tab.ownership === "created")
        .map((tab) => tab.tabId),
    );
  }

  clear(): void {
    this.sessions.clear();
  }
}

export class PendingShareRegistry {
  private offers = new Map<string, number>();

  offer(tabId: number, shareId: string = crypto.randomUUID()): string {
    this.revokeTab(tabId);
    this.offers.set(shareId, tabId);
    return shareId;
  }

  consume(shareId: string): number {
    const tabId = this.offers.get(shareId);
    if (tabId === undefined)
      throw toolError("share_not_found", "The tab share was not found or has expired.");
    this.offers.delete(shareId);
    return tabId;
  }

  hasTab(tabId: number): boolean {
    return [...this.offers.values()].includes(tabId);
  }

  shareIdForTab(tabId: number): string | undefined {
    for (const [shareId, offeredTabId] of this.offers) {
      if (offeredTabId === tabId) return shareId;
    }
    return undefined;
  }

  revokeTab(tabId: number): boolean {
    let revoked = false;
    for (const [shareId, offeredTabId] of this.offers) {
      if (offeredTabId !== tabId) continue;
      this.offers.delete(shareId);
      revoked = true;
    }
    return revoked;
  }

  clear(): void {
    this.offers.clear();
  }
}

type ToolFailure = Error & { code: string; browserSafeCode: true };

function toolError(code: string, message: string): ToolFailure {
  return Object.assign(new Error(message), { code, browserSafeCode: true as const });
}

export function browserFailureResponse(
  request: BrowserRequestMessage,
  error: unknown,
): BrowserResponseMessage {
  const failure = error as Partial<ToolFailure>;
  const errorCode =
    failure.browserSafeCode === true && typeof failure.code === "string"
      ? failure.code
      : "extension_request_failed";
  const sessionId =
    typeof request.arguments.session_id === "string" ? request.arguments.session_id : undefined;
  const tabId = Number.isInteger(request.arguments.tab_id) ? request.arguments.tab_id : undefined;
  const location =
    sessionId === undefined
      ? ""
      : tabId === undefined
        ? ` for session ${sessionId}`
        : ` for session ${sessionId} on tab ${String(tabId)}`;
  return {
    v: PROTOCOL_VERSION,
    type: "response",
    id: request.id,
    success: false,
    message: `Browser operation ${request.tool} failed${location}.`,
    errorCode,
  };
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0) {
    throw toolError("invalid_arguments", `${name} is required.`);
  }
  return value;
}

function textArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string") throw toolError("invalid_arguments", `${name} is required.`);
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

type InteractiveElementFacts = {
  tag: string;
  inputType: string;
  role: string;
  name: string;
  id: string;
  label: string;
  autocomplete: string;
  inForm: boolean;
  contentEditable: boolean;
};

type ReferenceInspection = { element: InteractiveElementFacts; url: string };

const ELEMENT_FACTS_FUNCTION = `function() {
  const labelText = (root) => {
    const parts = [];
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push(node.nodeValue || "");
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName.toLowerCase();
      const role = (node.getAttribute("role") || "").toLowerCase();
      if (["input", "textarea", "select"].includes(tag) || node.isContentEditable || ["textbox", "combobox", "searchbox"].includes(role)) return;
      for (const child of node.childNodes) walk(child);
    };
    walk(root);
    return parts.join(" ").trim().replace(/\\s+/g, " ");
  };
  const labelledBy = (this.getAttribute("aria-labelledby") || "")
    .split(/\\s+/).filter(Boolean)
    .map((id) => { const label = document.getElementById(id); return label ? labelText(label) : ""; })
    .join(" ");
  const labels = this.labels ? Array.from(this.labels).map((label) => labelText(label)).join(" ") : "";
  const accessibleLabel = (
    this.getAttribute("aria-label") || labelledBy || labels ||
    this.getAttribute("placeholder") || this.getAttribute("name") || ""
  ).trim().replace(/\\s+/g, " ").slice(0, 120);
  return {
    element: {
      tag: this.tagName.toLowerCase(),
      inputType: (this.getAttribute("type") || "").toLowerCase(),
      role: (this.getAttribute("role") || "").toLowerCase(),
      name: this.getAttribute("name") || "",
      id: this.id || "",
      label: accessibleLabel || (this.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 120),
      autocomplete: this.getAttribute("autocomplete") || "",
      inForm: Boolean(this.closest("form")),
      contentEditable: Boolean(this.isContentEditable),
    },
    url: location.href,
  };
}`;

const ACT_ON_REFERENCE_FUNCTION = `function(operation, value, expected) {
  const inspected = (${ELEMENT_FACTS_FUNCTION}).call(this);
  if (Object.keys(inspected.element).some((key) => inspected.element[key] !== expected[key])) {
    return {status: "changed"};
  }
  if (operation === "click") {
    this.click();
  } else if (operation === "fill") {
    if (!("value" in this) && !this.isContentEditable) return {status: "unsupported"};
    this.focus();
    if (this.isContentEditable) this.textContent = value;
    else this.value = value;
    this.dispatchEvent(new Event("input", {bubbles: true}));
    this.dispatchEvent(new Event("change", {bubbles: true}));
  } else if (operation === "press") {
    this.focus();
  } else {
    return {status: "unsupported"};
  }
  return {status: "ok"};
}`;

function referenceBackendNodeId(reference: string): number | undefined {
  const match = /^e\d+:n(\d+)$/.exec(reference);
  if (!match) return undefined;
  const backendNodeId = Number(match[1]);
  return Number.isSafeInteger(backendNodeId) ? backendNodeId : undefined;
}

async function callOnReference<T>(
  tabId: number,
  reference: string,
  functionDeclaration: string,
  args: unknown[] = [],
): Promise<T> {
  const backendNodeId = referenceBackendNodeId(reference);
  if (backendNodeId === undefined)
    throw toolError("browser_reference_invalid", "The browser reference is invalid.");
  const resolved = (await cdp(tabId, "DOM.resolveNode", { backendNodeId })) as {
    object?: { objectId?: unknown };
  };
  const objectId = resolved.object?.objectId;
  if (typeof objectId !== "string")
    throw toolError("browser_stale_reference", "The browser reference is stale.");
  const response = (await cdp(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration,
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
  })) as { result?: { value?: unknown } };
  if (response.result?.value === undefined)
    throw toolError("browser_stale_reference", "The browser reference is stale.");
  return response.result.value as T;
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
  readonly shares = new PendingShareRegistry();

  constructor(private readonly onSharedTabReleased?: (tabId: number) => void) {
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
    debuggerApi().onDetach.addListener((source) => {
      if (source.tabId === undefined) return;
      const owner = this.registry.find(source.tabId);
      if (owner) {
        this.registry.removeTab(owner.sessionId, source.tabId);
        if (owner.tab.ownership === "shared") this.onSharedTabReleased?.(source.tabId);
      }
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
      this.shares.revokeTab(tabId);
      const owner = this.registry.find(tabId);
      if (owner) {
        this.registry.removeTab(owner.sessionId, tabId);
        if (owner.tab.ownership === "shared") this.onSharedTabReleased?.(tabId);
      }
    });
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (changeInfo.groupId === undefined) return;
      const owner = this.registry.find(tabId);
      if (!owner || owner.tab.ownership === "shared") return;
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
    const createdTabIds = this.registry.createdTabs();
    this.registry.clear();
    this.shares.clear();
    await detachTabs(tabIds);
    await clearTaskGroups(createdTabIds);
  }

  offerTab(tabId: number): string {
    if (this.registry.find(tabId))
      throw toolError("tab_already_owned", "This tab already belongs to June.");
    return this.shares.offer(tabId);
  }

  shareState(tabId: number): "available" | "pending" | "shared" | "unavailable" {
    const owner = this.registry.find(tabId);
    if (owner?.tab.ownership === "shared") return "shared";
    if (owner) return "unavailable";
    if (this.shares.hasTab(tabId)) return "pending";
    return "available";
  }

  pendingShareId(tabId: number): string | undefined {
    return this.shares.shareIdForTab(tabId);
  }

  async revokeSharedTab(tabId: number): Promise<boolean> {
    const pending = this.shares.revokeTab(tabId);
    const owner = this.registry.find(tabId);
    if (owner?.tab.ownership !== "shared") return pending;
    this.registry.removeTab(owner.sessionId, tabId);
    this.onSharedTabReleased?.(tabId);
    await detach(tabId);
    return true;
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
      return { response: browserFailureResponse(request, error) };
    }
  }

  private async requireOwnedTaskTab(sessionId: string, tabId: number): Promise<TaskTab> {
    const taskTab = this.registry.tab(sessionId, tabId);
    if (taskTab.ownership === "shared") {
      try {
        await chrome.tabs.get(tabId);
        return taskTab;
      } catch {
        this.registry.removeTab(sessionId, tabId);
        await detach(tabId);
        throw toolError("tab_not_owned", "The shared tab is no longer available.");
      }
    }
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

  private async inspectReference(
    sessionId: string,
    tabId: number,
    reference: string,
  ): Promise<ReferenceInspection> {
    if (!this.registry.acceptsRef(sessionId, tabId, reference)) {
      throw toolError("browser_stale_reference", "The browser reference is stale.");
    }
    return callOnReference<ReferenceInspection>(tabId, reference, ELEMENT_FACTS_FUNCTION);
  }

  private async snapshot(sessionId: string, tabId: number, taskTab: TaskTab) {
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

  private async actOnReference(
    sessionId: string,
    tabId: number,
    operation: "click" | "fill" | "press",
    args: Record<string, unknown>,
  ) {
    const reference = stringArg(args, "ref");
    if (!this.registry.acceptsRef(sessionId, tabId, reference)) {
      throw toolError("browser_stale_reference", "The browser reference is stale.");
    }
    const expected = args.expected;
    if (typeof expected !== "object" || expected === null) {
      throw toolError("invalid_arguments", "expected is required.");
    }
    const value =
      operation === "fill"
        ? textArg(args, "text")
        : operation === "press"
          ? stringArg(args, "key")
          : "";
    const result = await callOnReference<{ status?: unknown }>(
      tabId,
      reference,
      ACT_ON_REFERENCE_FUNCTION,
      [operation, value, expected],
    );
    if (result.status === "changed") {
      throw toolError("browser_stale_reference", "The browser element changed.");
    }
    if (result.status !== "ok") {
      throw toolError("browser_action_unsupported", "The browser action is unsupported.");
    }
    if (operation === "press") {
      const text = [...value].length === 1 ? value : "";
      for (const type of ["keyDown", "keyUp"]) {
        await cdp(tabId, "Input.dispatchKeyEvent", { type, key: value, text });
      }
    }
    this.registry.invalidate(sessionId, tabId);
    await waitUntilReady(tabId);
    return this.snapshot(sessionId, tabId, this.registry.tab(sessionId, tabId));
  }

  private async executeTool(
    tool: BrowserRequestMessage["tool"],
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const sessionId = stringArg(args, "session_id");
    if (tool === "start_session") {
      this.registry.start(sessionId);
      return { sessionId };
    }
    if (tool === "close_session") {
      const cleanup = this.registry.removeSession(sessionId);
      await Promise.all([closeTabs(cleanup.created), detachTabs(cleanup.shared)]);
      return { closed: true };
    }
    if (tool === "accept_shared_tab") {
      this.registry.session(sessionId);
      const shareId = stringArg(args, "share_id");
      const tabId = this.shares.consume(shareId);
      this.registry.addShared(sessionId, tabId);
      try {
        await chrome.tabs.get(tabId);
        await attach(tabId);
        const owner = this.registry.find(tabId);
        if (owner?.sessionId !== sessionId || owner.tab.ownership !== "shared") {
          throw toolError("share_revoked", "The tab share was revoked before it was accepted.");
        }
        return { tabId, shared: true };
      } catch (error) {
        const owner = this.registry.find(tabId);
        if (owner?.sessionId === sessionId) this.registry.removeTab(sessionId, tabId);
        await detach(tabId);
        throw error;
      }
    }
    if (tool === "open_tab") {
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
        this.registry.addCreated(sessionId, tabId);
        return { tabId, url: "about:blank" };
      } catch (error) {
        await closeTabs([tabId]);
        throw error;
      }
    }
    if (tool === "list_tabs") {
      const tabs = [];
      for (const ownedId of [...this.registry.session(sessionId).tabs.keys()]) {
        try {
          await this.requireOwnedTaskTab(sessionId, ownedId);
          const tab = await chrome.tabs.get(ownedId);
          tabs.push({ tabId: ownedId, title: tab.title ?? "", url: tab.url ?? "" });
        } catch {
          // A tab that left the June group is removed from ownership above.
        }
      }
      return { tabs, activeTabId: this.registry.session(sessionId).activeTabId };
    }
    const tabId = tabArg(args);
    const taskTab = await this.requireOwnedTaskTab(sessionId, tabId);
    if (tool === "close_tab") {
      this.registry.removeTab(sessionId, tabId);
      if (taskTab.ownership === "created") await closeTabs([tabId]);
      else await detach(tabId);
      return { closed: true };
    }
    if (tool === "switch_tab") {
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
    if (tool === "snapshot") return this.snapshot(sessionId, tabId, taskTab);
    if (tool === "inspect_reference") {
      return this.inspectReference(sessionId, tabId, stringArg(args, "ref"));
    }
    if (tool === "click" || tool === "fill" || tool === "press") {
      return this.actOnReference(sessionId, tabId, tool, args);
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
    throw toolError("not_implemented", "The browser tool is not implemented.");
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
