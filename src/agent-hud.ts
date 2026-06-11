import { emit, listen } from "@tauri-apps/api/event";
import { IconAgent } from "central-icons/IconAgent";
import { IconArrowUp } from "central-icons/IconArrowUp";
import { IconBubbleWide } from "central-icons/IconBubbleWide";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconCircleQuestionmark } from "central-icons/IconCircleQuestionmark";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconStopCircle } from "central-icons/IconStopCircle";
import { createElement, type ComponentType, type SVGProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AGENT_OPEN_EVENT,
  AGENT_REPLY_EVENT,
  AGENT_SESSIONS_CHANGED_EVENT,
  AGENT_SESSION_STATUS_EVENT,
  type AgentReplyDetail,
  type AgentSessionStatusDetail,
  type AgentSessionStatusKind,
  type AgentSessionsChangedDetail,
} from "./lib/agent-events";
import {
  AGENT_HUD_ENABLED_KEY,
  AGENT_HUD_VISIBILITY_CHANGED_EVENT,
  getAgentHudEnabled,
  setAgentHudEnabled,
  type AgentHudVisibilityChangedDetail,
} from "./lib/agent-hud-settings";
import {
  agentHudFocusReply,
  agentHudHide,
  agentHudOpenAgent,
  agentHudSetLayout,
  agentHudShow,
} from "./lib/tauri";
import type { HermesSessionInfo } from "./lib/tauri";
import "./styles/agent-hud.css";

type HudSessionStatus = AgentSessionStatusKind | "idle";

type StatusRecord = AgentSessionStatusDetail & {
  receivedAt: number;
};

type HudEntry = {
  id: string;
  title: string;
  summary: string;
  status: HudSessionStatus;
  updatedAt: string;
  session?: HermesSessionInfo;
};

const EXPANDED_KEY = "scribe:agent-hud:expanded";
const MAX_VISIBLE_ROWS = 3;
const COMPLETED_STATUS_TTL_MS = 2200;
const FAILED_STATUS_TTL_MS = 8 * 1000;
const WINDOW_FADE_MS = 180;

const hud = document.querySelector<HTMLElement>("#agent-hud");
const pill = document.querySelector<HTMLButtonElement>("#agent-hud-pill");
const pillStatus = document.querySelector<HTMLElement>(
  "#agent-hud-pill-status",
);
const pillLabel = document.querySelector<HTMLElement>("#agent-hud-pill-label");
const pillChevron = document.querySelector<HTMLElement>("#agent-hud-chevron");
const stack = document.querySelector<HTMLElement>("#agent-hud-stack");
const menu = document.querySelector<HTMLElement>("#agent-hud-menu");
const hideHud = document.querySelector<HTMLButtonElement>("#agent-hud-hide");

const state = {
  enabled: getAgentHudEnabled(),
  expanded: localStorage.getItem(EXPANDED_KEY) === "true",
  focused: false,
  hovered: false,
  menuOpen: false,
  sessions: [] as HermesSessionInfo[],
  selectedSessionId: undefined as string | undefined,
  workingSessionIds: new Set<string>(),
  waitingSessionIds: new Set<string>(),
  statusBySessionId: new Map<string, StatusRecord>(),
  pendingStatuses: [] as StatusRecord[],
  replyingEntryId: undefined as string | undefined,
};

let lastLayoutKey = "";
let lastStackKey = "";
let lastRenderedExpanded = false;
let pruneTimer: number | undefined;
let hideTimer: number | undefined;
let windowShown = false;
let lastPillStatus: HudSessionStatus | undefined;
// The reply form lives outside the rebuild cycle: status events arrive in
// bursts while sessions work, and recreating the input on each one would
// wipe whatever the user is typing.
let replyForm:
  | {
      entryId: string;
      entry: HudEntry;
      form: HTMLFormElement;
      input: HTMLInputElement;
    }
  | undefined;

function applySessionsChanged(detail?: AgentSessionsChangedDetail) {
  if (!detail) return;
  state.sessions = detail.sessions ?? [];
  state.selectedSessionId = detail.selectedSessionId;
  state.workingSessionIds = new Set(detail.workingSessionIds ?? []);
  state.waitingSessionIds = new Set(detail.waitingSessionIds ?? []);
  const activeSessionIds = new Set([
    ...state.workingSessionIds,
    ...state.waitingSessionIds,
  ]);
  const knownSessionIds = new Set(state.sessions.map((session) => session.id));
  for (const [sessionId, record] of state.statusBySessionId) {
    if (
      knownSessionIds.has(sessionId) &&
      isActiveStatus(record.status) &&
      !activeSessionIds.has(sessionId)
    ) {
      state.statusBySessionId.delete(sessionId);
    }
  }
  if (!activeSessionIds.size) {
    state.pendingStatuses = state.pendingStatuses.filter(
      (pending) => !isActiveStatus(pending.status),
    );
  }
  state.pendingStatuses = state.pendingStatuses.filter(
    (pending) =>
      !state.sessions.some((session) => sameSubject(session, pending)),
  );
  render();
}

function applyStatus(detail?: AgentSessionStatusDetail) {
  if (!detail) return;
  const record: StatusRecord = { ...detail, receivedAt: Date.now() };
  if (detail.sessionId) {
    if (detail.status === "completed" || detail.status === "cancelled") {
      state.workingSessionIds.delete(detail.sessionId);
      state.waitingSessionIds.delete(detail.sessionId);
      state.statusBySessionId.set(detail.sessionId, terminalRecord(record));
      const replacedPending = replacePendingWithTerminalStatus(record);
      const hasKnownSession = state.sessions.some(
        (session) => session.id === detail.sessionId,
      );
      if (!hasKnownSession && !replacedPending) {
        state.pendingStatuses = [
          terminalRecord(record),
          ...state.pendingStatuses,
        ].slice(0, MAX_VISIBLE_ROWS);
      }
      if (state.replyingEntryId === detail.sessionId) {
        state.replyingEntryId = undefined;
      }
      render();
      return;
    }
    state.statusBySessionId.set(detail.sessionId, record);
    state.pendingStatuses = state.pendingStatuses.filter(
      (pending) => !sameStatusSubject(pending, record),
    );
  } else {
    if (detail.status === "completed" || detail.status === "cancelled") {
      if (!replacePendingWithTerminalStatus(record)) {
        state.pendingStatuses = [
          terminalRecord(record),
          ...state.pendingStatuses,
        ].slice(0, MAX_VISIBLE_ROWS);
      }
      render();
      return;
    }
    const key = statusSubject(record);
    state.pendingStatuses = [
      record,
      ...state.pendingStatuses.filter((item) => statusSubject(item) !== key),
    ].slice(0, MAX_VISIBLE_ROWS);
  }
  pruneOldStatuses();
  render();
}

function applyVisibility(enabled: boolean) {
  state.enabled = enabled;
  if (!enabled) {
    state.focused = false;
    state.menuOpen = false;
    state.replyingEntryId = undefined;
  }
  render();
}

function render() {
  if (!hud || !stack || !pill) return;

  pruneOldStatuses();
  const entries = buildEntries();
  const hasEntries = entries.length > 0;
  const hasAction = entries.some((entry) => entry.status === "waitingForUser");
  if (
    state.replyingEntryId &&
    !entries.some((entry) => entry.id === state.replyingEntryId)
  ) {
    state.replyingEntryId = undefined;
  }
  if (!state.replyingEntryId) replyForm = undefined;
  const expanded =
    state.enabled &&
    hasEntries &&
    (hasAction ||
      state.expanded ||
      state.focused ||
      Boolean(state.replyingEntryId) ||
      // Hovering holds the panel open: it must not collapse or fade out
      // under the pointer, even when the reason it expanded goes away.
      (state.hovered && lastRenderedExpanded));
  lastRenderedExpanded = expanded;

  hud.dataset.expanded = expanded ? "true" : "false";
  hud.dataset.hasEntries = hasEntries ? "true" : "false";
  hud.dataset.visible = state.enabled && hasEntries ? "true" : "false";
  hud.dataset.hasAction = hasAction ? "true" : "false";
  hud.dataset.menuOpen = state.menuOpen ? "true" : "false";

  renderPill(entries, expanded);

  // Only rebuild the rows when their visible content changes. Status events
  // arrive in bursts while a session works; recreating identical nodes on
  // each one restarts CSS animations (the status spinner) and reads as
  // flicker.
  const stackKey = expanded
    ? entries
        .map((entry) =>
          [
            entry.id,
            entry.title,
            entry.summary,
            entry.status,
            state.replyingEntryId === entry.id ? "replying" : "",
          ].join(""),
        )
        .join("")
    : "collapsed";
  if (stackKey !== lastStackKey) {
    lastStackKey = stackKey;
    const inputHadFocus =
      replyForm !== undefined && document.activeElement === replyForm.input;
    stack.replaceChildren();
    if (expanded) {
      for (const entry of entries) stack.appendChild(renderRow(entry));
    }
    // replaceChildren re-homes the cached form node, which drops focus.
    if (inputHadFocus && replyForm?.input.isConnected) replyForm.input.focus();
  }
  stack.setAttribute("aria-hidden", expanded ? "false" : "true");
  if (menu) {
    menu.hidden = !state.menuOpen;
    menu.setAttribute("aria-hidden", state.menuOpen ? "false" : "true");
  }

  void syncWindowLayout(expanded, expanded ? entries.length : 0, hasEntries);
  scheduleStatusPrune();
}

function renderPill(entries: HudEntry[], expanded: boolean) {
  if (!pill || !pillStatus || !pillLabel) return;
  const { label, status } = pillSummary(entries);
  pillStatus.dataset.status = status;
  if (status !== lastPillStatus) {
    lastPillStatus = status;
    pillStatus.replaceChildren();
    appendStatusIcon(pillStatus, status);
  }
  pillLabel.textContent = label;
  pill.setAttribute("aria-expanded", expanded ? "true" : "false");
  pill.setAttribute(
    "aria-label",
    expanded ? "Collapse agent activity" : "Expand agent activity",
  );
}

function pillSummary(entries: HudEntry[]): {
  label: string;
  status: HudSessionStatus;
} {
  const waiting = entries.filter(
    (entry) => entry.status === "waitingForUser",
  ).length;
  if (waiting > 0) {
    return {
      label: waiting === 1 ? "1 needs input" : `${waiting} need input`,
      status: "waitingForUser",
    };
  }
  const running = entries.filter(
    (entry) =>
      entry.status === "received" ||
      entry.status === "starting" ||
      entry.status === "running",
  ).length;
  if (running > 0) {
    return {
      label: `${running} running`,
      status: "running",
    };
  }
  const [latest] = entries;
  if (latest) {
    return { label: statusLabel(latest.status), status: latest.status };
  }
  return { label: "Idle", status: "idle" };
}

function renderRow(entry: HudEntry) {
  const row = document.createElement("li");
  row.className = "agent-hud-row";
  row.dataset.status = entry.status;

  const body = document.createElement("button");
  body.type = "button";
  body.className = "agent-hud-row-body";
  body.addEventListener("click", () => {
    void openAgent(entry.session);
  });

  const status = document.createElement("span");
  status.className = "agent-hud-status";
  status.dataset.status = entry.status;
  status.setAttribute("aria-hidden", "true");
  appendStatusIcon(status, entry.status);
  body.appendChild(status);

  const text = document.createElement("span");
  text.className = "agent-hud-row-text";

  const title = document.createElement("span");
  title.className = "agent-hud-row-title";
  title.textContent = entry.title;
  text.appendChild(title);

  const summaryText = rowSummary(entry);
  if (summaryText) {
    const summary = document.createElement("span");
    summary.className = "agent-hud-row-summary";
    summary.textContent = summaryText;
    text.appendChild(summary);
  }

  body.appendChild(text);
  row.appendChild(body);

  const reply = document.createElement("button");
  reply.type = "button";
  reply.className = "agent-hud-reply";
  reply.setAttribute("aria-label", `Reply to ${entry.title}`);
  reply.title = "Reply";
  appendIcon(reply, IconBubbleWide, 14);
  reply.addEventListener("click", (event) => {
    event.stopPropagation();
    state.replyingEntryId = entry.id;
    render();
    // The HUD is a non-activating panel; ask the native side to make it the
    // key window so the input actually receives keystrokes.
    void agentHudFocusReply().catch(() => {});
    window.setTimeout(() => replyForm?.input.focus(), 0);
  });
  row.appendChild(reply);

  if (state.replyingEntryId === entry.id) {
    row.appendChild(ensureReplyForm(entry));
  }

  return row;
}

function ensureReplyForm(entry: HudEntry) {
  if (replyForm && replyForm.entryId === entry.id) {
    replyForm.entry = entry;
    return replyForm.form;
  }

  const form = document.createElement("form");
  form.className = "agent-hud-reply-form";

  const input = document.createElement("input");
  input.className = "agent-hud-reply-input";
  input.type = "text";
  input.placeholder = "Reply to June";
  input.autocomplete = "off";
  input.spellcheck = true;
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      state.replyingEntryId = undefined;
      render();
    }
  });

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "agent-hud-reply-send";
  submit.setAttribute("aria-label", "Send reply");
  submit.title = "Send reply";
  appendIcon(submit, IconArrowUp, 14);

  form.append(input, submit);
  form.addEventListener("click", (event) => event.stopPropagation());
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const target = replyForm?.entry ?? entry;
    state.replyingEntryId = undefined;
    render();
    void sendReply(target, text);
  });

  replyForm = { entryId: entry.id, entry, form, input };
  return form;
}

function buildEntries() {
  const now = Date.now();
  const entries: HudEntry[] = [];
  const seen = new Set<string>();

  for (const session of state.sessions) {
    const id = session.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const record = state.statusBySessionId.get(id);
    if (record && isExpiredTerminalRecord(record, now)) {
      state.statusBySessionId.delete(id);
    }
    const entry = entryFromSession(session, state.statusBySessionId.get(id));
    if (shouldRenderEntry(entry)) entries.push(entry);
  }

  for (const record of state.pendingStatuses) {
    const entry = entryFromPending(record);
    if (shouldRenderEntry(entry)) entries.push(entry);
  }

  return entries.sort(compareEntries).slice(0, MAX_VISIBLE_ROWS);
}

function entryFromSession(
  session: HermesSessionInfo,
  record?: StatusRecord,
): HudEntry {
  const status = sessionStatus(session, record);
  return {
    id: session.id,
    title: sessionTitle(session, record),
    summary: sessionSummary(session, status, record),
    status,
    updatedAt: sessionTimestamp(session, record),
    session,
  };
}

function entryFromPending(record: StatusRecord): HudEntry {
  return {
    id: `pending:${statusSubject(record)}`,
    title: statusTitle(record),
    summary: statusSummary(record),
    status: record.status,
    updatedAt: new Date(record.receivedAt).toISOString(),
  };
}

function sessionStatus(
  session: HermesSessionInfo,
  record?: StatusRecord,
): HudSessionStatus {
  if (
    record &&
    isTerminalStatus(record.status) &&
    !isExpiredTerminalRecord(record)
  ) {
    return record.status;
  }
  if (state.waitingSessionIds.has(session.id)) return "waitingForUser";
  if (state.workingSessionIds.has(session.id)) return "running";
  if (record && isActiveStatus(record.status)) {
    return record.status;
  }
  return "idle";
}

function sessionTitle(session: HermesSessionInfo, record?: StatusRecord) {
  return (
    record?.title?.trim() ||
    session.title?.trim() ||
    session.preview?.trim() ||
    "Agent session"
  );
}

function sessionSummary(
  session: HermesSessionInfo,
  status: HudSessionStatus,
  record?: StatusRecord,
) {
  const summary = record?.summary?.trim();
  if (summary) return summary;
  if (status !== "idle") return statusLabel(status);
  return session.preview?.trim() || "Idle";
}

function sessionTimestamp(session: HermesSessionInfo, record?: StatusRecord) {
  if (record) return new Date(record.receivedAt).toISOString();
  return (
    session.last_active ??
    session.lastActive ??
    session.started_at ??
    session.startedAt ??
    new Date(0).toISOString()
  );
}

function statusTitle(record: StatusRecord) {
  return record.title?.trim() || record.prompt?.trim() || "Agent session";
}

function statusSummary(record: StatusRecord) {
  return record.summary?.trim() || statusLabel(record.status);
}

function rowSummary(entry: HudEntry) {
  const summary = entry.summary.trim();
  if (!summary) return undefined;

  const normalizedSummary = normalizeText(summary);
  if (
    normalizedSummary === normalizeText(entry.title) ||
    normalizedSummary === normalizeText(statusLabel(entry.status)) ||
    normalizedSummary === "june is working" ||
    normalizedSummary === "starting june" ||
    normalizedSummary === "june finished"
  ) {
    return undefined;
  }

  return summary;
}

function normalizeText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "");
}

function statusLabel(status: HudSessionStatus) {
  switch (status) {
    case "received":
    case "starting":
    case "running":
      return "Thinking";
    case "waitingForUser":
      return "Needs input";
    case "completed":
      return "Done";
    case "failed":
      return "Hit a problem";
    case "cancelled":
      return "Stopped";
    case "idle":
      return "Idle";
  }
}

function compareEntries(a: HudEntry, b: HudEntry) {
  const rank = statusRank(a.status) - statusRank(b.status);
  if (rank !== 0) return rank;
  return b.updatedAt.localeCompare(a.updatedAt);
}

function statusRank(status: HudSessionStatus) {
  if (status === "waitingForUser") return 0;
  if (status === "received" || status === "starting" || status === "running")
    return 1;
  if (status === "failed") return 2;
  if (status === "completed" || status === "cancelled") return 3;
  return 4;
}

function isActiveStatus(status: HudSessionStatus) {
  return (
    status === "received" ||
    status === "starting" ||
    status === "running" ||
    status === "waitingForUser"
  );
}

function pruneOldStatuses() {
  const now = Date.now();
  state.pendingStatuses = state.pendingStatuses.filter(
    (record) =>
      isActiveStatus(record.status) ||
      (isTerminalStatus(record.status) &&
        !isExpiredTerminalRecord(record, now)),
  );
  for (const [id, record] of state.statusBySessionId) {
    if (isExpiredTerminalRecord(record, now)) {
      state.statusBySessionId.delete(id);
    }
  }
}

function replacePendingWithTerminalStatus(record: StatusRecord) {
  let replaced = false;
  state.pendingStatuses = state.pendingStatuses.map((item) => {
    if (!sameStatusSubject(item, record)) return item;
    replaced = true;
    return terminalRecord(record, item);
  });
  if (replaced) return true;
  if (record.activeCount === 0) {
    const activePending = state.pendingStatuses.filter((item) =>
      isActiveStatus(item.status),
    );
    state.pendingStatuses = [
      ...activePending.map((item) => terminalRecord(record, item)),
      ...state.pendingStatuses.filter((item) => !isActiveStatus(item.status)),
    ].slice(0, MAX_VISIBLE_ROWS);
    return activePending.length > 0;
  }
  const activePending = state.pendingStatuses.filter((item) =>
    isActiveStatus(item.status),
  );
  if (activePending.length === 1) {
    state.pendingStatuses = state.pendingStatuses.map((item) =>
      item === activePending[0] ? terminalRecord(record, item) : item,
    );
    return true;
  }
  return false;
}

function terminalRecord(record: StatusRecord, previous?: StatusRecord) {
  return {
    ...record,
    prompt: previous?.prompt ?? record.prompt,
    title: previous?.title ?? record.title,
    summary: record.summary?.trim() || statusLabel(record.status),
    receivedAt: record.receivedAt,
  };
}

function scheduleStatusPrune() {
  if (pruneTimer !== undefined) {
    window.clearTimeout(pruneTimer);
    pruneTimer = undefined;
  }
  // Expiry is paused while hovered; the pointerleave render reschedules.
  if (state.hovered) return;
  const now = Date.now();
  const expirations = [
    ...state.pendingStatuses,
    ...Array.from(state.statusBySessionId.values()),
  ]
    .map((record) => terminalExpiration(record))
    .filter((expiration): expiration is number => expiration !== undefined);
  if (!expirations.length) return;
  const delay = Math.max(0, Math.min(...expirations) - now) + 25;
  pruneTimer = window.setTimeout(() => {
    pruneTimer = undefined;
    pruneOldStatuses();
    render();
  }, delay);
}

function terminalExpiration(record: StatusRecord) {
  const ttl = terminalStatusTtl(record.status);
  return ttl === undefined ? undefined : record.receivedAt + ttl;
}

function isExpiredTerminalRecord(record: StatusRecord, now = Date.now()) {
  // Terminal rows never expire under the pointer; the user is reading them.
  if (state.hovered) return false;
  const expiration = terminalExpiration(record);
  return expiration !== undefined && now > expiration;
}

function terminalStatusTtl(status: HudSessionStatus) {
  if (status === "completed" || status === "cancelled") {
    return COMPLETED_STATUS_TTL_MS;
  }
  if (status === "failed") return FAILED_STATUS_TTL_MS;
  return undefined;
}

function shouldRenderEntry(entry: HudEntry) {
  return isActiveStatus(entry.status) || isTerminalStatus(entry.status);
}

function isTerminalStatus(status: HudSessionStatus) {
  return (
    status === "completed" || status === "cancelled" || status === "failed"
  );
}

function sameSubject(session: HermesSessionInfo, record: StatusRecord) {
  const title = statusSubject(record);
  return (
    session.id === record.sessionId ||
    session.title?.trim().toLowerCase() === title
  );
}

function sameStatusSubject(a: StatusRecord, b: StatusRecord) {
  return statusSubject(a) === statusSubject(b);
}

function statusSubject(record: StatusRecord) {
  return statusTitle(record).trim().toLowerCase();
}

async function syncWindowLayout(
  expanded: boolean,
  rowCount: number,
  hasEntries: boolean,
) {
  const replying = Boolean(state.replyingEntryId);
  const menuOpen = state.menuOpen;
  const visible = state.enabled && hasEntries;
  const key = `${visible}:${expanded}:${rowCount}:${replying}:${menuOpen}`;
  if (key === lastLayoutKey) return;
  lastLayoutKey = key;
  if (!visible) {
    scheduleWindowHide(!state.enabled);
    return;
  }
  cancelWindowHide();
  await agentHudSetLayout({
    expanded,
    cardCount: rowCount,
    replying,
    ...(menuOpen ? { contextMenuOpen: menuOpen } : {}),
  }).catch(() => {});
  if (!windowShown) {
    await agentHudShow().catch(() => {});
    windowShown = true;
  }
}

function scheduleWindowHide(immediate = false) {
  cancelWindowHide();
  if (!windowShown || immediate) {
    void hideWindow();
    return;
  }
  hideTimer = window.setTimeout(() => {
    hideTimer = undefined;
    void hideWindow();
  }, WINDOW_FADE_MS);
}

function cancelWindowHide() {
  if (hideTimer === undefined) return;
  window.clearTimeout(hideTimer);
  hideTimer = undefined;
}

async function hideWindow() {
  await agentHudHide().catch(() => {});
  windowShown = false;
}

function setExpanded(expanded: boolean) {
  if (!expanded) {
    state.focused = false;
    state.menuOpen = false;
    state.replyingEntryId = undefined;
    // An explicit collapse beats the hover-hold; the pointer is necessarily
    // over the pill when it is clicked.
    lastRenderedExpanded = false;
  }
  state.expanded = expanded;
  localStorage.setItem(EXPANDED_KEY, expanded ? "true" : "false");
  render();
}

type CentralIcon = ComponentType<
  SVGProps<SVGSVGElement> & { size?: string | number; ariaHidden?: boolean }
>;

function appendIcon(parent: HTMLElement, Icon: CentralIcon, size: number) {
  const wrapper = document.createElement("span");
  wrapper.className = "agent-hud-icon";
  wrapper.setAttribute("aria-hidden", "true");
  wrapper.innerHTML = renderToStaticMarkup(
    createElement(Icon, {
      size,
      ariaHidden: true,
      focusable: false,
    }),
  );
  parent.appendChild(wrapper);
}

function setIcon(parent: HTMLElement | null, Icon: CentralIcon, size: number) {
  if (!parent) return;
  parent.replaceChildren();
  appendIcon(parent, Icon, size);
}

function appendStatusIcon(parent: HTMLElement, status: HudSessionStatus) {
  switch (status) {
    case "waitingForUser":
      appendIcon(parent, IconCircleQuestionmark, 12);
      return;
    case "completed":
      appendIcon(parent, IconCheckmark1Small, 12);
      return;
    case "failed":
    case "cancelled":
      appendIcon(
        parent,
        status === "failed" ? IconCrossSmall : IconStopCircle,
        12,
      );
      return;
    case "idle":
      appendIcon(parent, IconAgent, 12);
      return;
    case "received":
    case "starting":
    case "running":
      appendDotSpinner(parent);
      return;
  }
}

// The app-wide rolling dot spinner (see components/DotSpinner.tsx); this
// page has no React tree, so the same markup is built by hand against the
// shared dot-spinner.css.
function appendDotSpinner(parent: HTMLElement) {
  const spinner = document.createElement("span");
  spinner.className = "dot-spinner";
  spinner.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 4; i += 1) {
    spinner.appendChild(document.createElement("span"));
  }
  parent.appendChild(spinner);
}

async function openAgent(session?: HermesSessionInfo) {
  await agentHudOpenAgent(session).catch(() => {
    window.dispatchEvent(
      new CustomEvent(AGENT_OPEN_EVENT, {
        detail: { session },
      }),
    );
  });
}

async function sendReply(entry: HudEntry, text: string) {
  await openAgent(entry.session);
  const detail: AgentReplyDetail = {
    requestId: `agent-hud:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    session: entry.session,
    text,
  };
  await emit(AGENT_REPLY_EVENT, detail).catch(() => {
    window.dispatchEvent(
      new CustomEvent<AgentReplyDetail>(AGENT_REPLY_EVENT, { detail }),
    );
  });
}

function toggleExpanded() {
  const renderedExpanded = hud?.dataset.expanded === "true";
  setExpanded(!renderedExpanded);
}

function setFocusExpanded(focused: boolean) {
  const changed = state.focused !== focused;
  state.focused = focused;
  let menuClosed = false;
  if (!focused && state.menuOpen) {
    state.menuOpen = false;
    menuClosed = true;
  }
  if (changed || menuClosed) render();
}

function openMenu() {
  state.menuOpen = true;
  render();
  window.setTimeout(() => hideHud?.focus(), 0);
}

function closeMenu() {
  if (!state.menuOpen) return;
  state.menuOpen = false;
  render();
}

function hideFromMenu() {
  closeMenu();
  setAgentHudEnabled(false);
}

function setHovered(hovered: boolean) {
  if (state.hovered === hovered) return;
  if (!hovered) {
    // Records that expired while held under the pointer restart their TTL,
    // so rows linger briefly instead of vanishing the instant it leaves.
    const now = Date.now();
    const records = [
      ...state.pendingStatuses,
      ...state.statusBySessionId.values(),
    ];
    for (const record of records) {
      const expiration = terminalExpiration(record);
      if (expiration !== undefined && now > expiration) {
        record.receivedAt = now;
      }
    }
  }
  state.hovered = hovered;
  render();
}

hud?.addEventListener("pointerenter", () => {
  setHovered(true);
});

hud?.addEventListener("pointerleave", () => {
  if (state.menuOpen) closeMenu();
  setHovered(false);
});

hud?.addEventListener("focusin", () => {
  setFocusExpanded(true);
});

hud?.addEventListener("focusout", (event) => {
  const next = event.relatedTarget;
  if (next instanceof Node && hud.contains(next)) return;
  setFocusExpanded(false);
});

pill?.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  toggleExpanded();
});

pill?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  toggleExpanded();
});

pill?.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  event.stopPropagation();
  openMenu();
});

menu?.addEventListener("pointerdown", (event) => {
  event.stopPropagation();
});

hideHud?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  hideFromMenu();
});

window.addEventListener("pointerdown", (event) => {
  if (!state.menuOpen) return;
  const target = event.target;
  if (target instanceof Node && menu?.contains(target)) return;
  closeMenu();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenu();
});

window.addEventListener(AGENT_HUD_VISIBILITY_CHANGED_EVENT, (event) => {
  const detail = (event as CustomEvent<AgentHudVisibilityChangedDetail>).detail;
  if (detail) applyVisibility(detail.enabled);
});

window.addEventListener(AGENT_SESSIONS_CHANGED_EVENT, (event) => {
  applySessionsChanged(
    (event as CustomEvent<AgentSessionsChangedDetail>).detail,
  );
});

window.addEventListener(AGENT_SESSION_STATUS_EVENT, (event) => {
  applyStatus((event as CustomEvent<AgentSessionStatusDetail>).detail);
});

window.addEventListener("storage", (event) => {
  if (event.key === AGENT_HUD_ENABLED_KEY) {
    applyVisibility(event.newValue !== "false");
  }
});

void listen<AgentSessionsChangedDetail>(AGENT_SESSIONS_CHANGED_EVENT, (event) =>
  applySessionsChanged(event.payload),
).catch(() => {});

void listen<AgentSessionStatusDetail>(AGENT_SESSION_STATUS_EVENT, (event) =>
  applyStatus(event.payload),
).catch(() => {});

void listen<AgentHudVisibilityChangedDetail>(
  AGENT_HUD_VISIBILITY_CHANGED_EVENT,
  (event) => applyVisibility(event.payload.enabled),
).catch(() => {});

setIcon(pillChevron, IconChevronDownSmall, 14);
render();

// Console driver for this page when served standalone in a browser:
// __agentHud("waiting") etc. See lib/agent-hud-demo.ts.
if (import.meta.env.DEV) {
  void import("./lib/agent-hud-demo").then(({ registerAgentHudDemo }) =>
    registerAgentHudDemo({ local: true }),
  );
}
