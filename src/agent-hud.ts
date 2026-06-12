import { emit, listen } from "@tauri-apps/api/event";
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
import { installNativeContextMenuGuard } from "./lib/native-context-menu";
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
// Emitted by the native panel (agent_hud.rs) when it swallows a right- or
// ctrl-click so the WKWebView never raises its own context menu. Keep this in
// sync with AGENT_HUD_CONTEXT_MENU_EVENT in agent_hud.rs.
const AGENT_HUD_CONTEXT_MENU_EVENT = "scribe:agent-hud:context-menu";
const MAX_VISIBLE_ROWS = 3;
const COMPLETED_STATUS_TTL_MS = 2200;
const FAILED_STATUS_TTL_MS = 8 * 1000;
// Covers the surface's fade-out transition (--t-slow) before the native
// window hides, plus a little slack for the compositor.
const WINDOW_FADE_MS = 300;
// How long the CSS collapse animation gets to play before the native
// window shrinks underneath it (--t-med plus slack).
const COLLAPSE_RESIZE_DELAY_MS = 200;

const hud = document.querySelector<HTMLElement>("#agent-hud");
const pill = document.querySelector<HTMLButtonElement>("#agent-hud-pill");
const mark = document.querySelector<HTMLElement>("#agent-hud-mark");
const pillLabel = document.querySelector<HTMLElement>("#agent-hud-pill-label");
const pillBadge = document.querySelector<HTMLElement>("#agent-hud-pill-badge");
const surface = document.querySelector<HTMLElement>(".agent-hud-surface");
const pillChevron = document.querySelector<HTMLElement>("#agent-hud-chevron");
const stack = document.querySelector<HTMLElement>("#agent-hud-stack");
const menu = document.querySelector<HTMLElement>("#agent-hud-menu");
const hideHud = document.querySelector<HTMLButtonElement>("#agent-hud-hide");

installNativeContextMenuGuard();

const state = {
  enabled: getAgentHudEnabled(),
  expanded: localStorage.getItem(EXPANDED_KEY) === "true",
  focused: false,
  hovered: false,
  menuOpen: false,
  sessions: [] as HermesSessionInfo[],
  workingSessionIds: new Set<string>(),
  waitingSessionIds: new Set<string>(),
  statusBySessionId: new Map<string, StatusRecord>(),
  pendingStatuses: [] as StatusRecord[],
  replyingEntryId: undefined as string | undefined,
  // Transient auto-expand triggered when an entry newly needs input. Unlike
  // `expanded` it is not persisted to EXPANDED_KEY: it grabs attention once,
  // then an explicit collapse (setExpanded(false)) must stick.
  attentionExpanded: false,
};

// Entry ids seen in `waitingForUser` on the previous render. A render that
// sees an id enter this set flips attentionExpanded on; the set is cleared
// when nothing is waiting so the next attention event pops the panel again.
let lastWaitingEntryIds = new Set<string>();

let lastLayoutKey = "";
let lastStackKey = "";
let lastRenderedExpanded = false;
let lastWindowHeight = 0;
let pruneTimer: number | undefined;
let hideTimer: number | undefined;
let resizeTimer: number | undefined;
let widthFlipTimer: number | undefined;
let windowShown = false;
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

  // Auto-expand only on the transition INTO waitingForUser: an id appearing
  // in the waiting set that wasn't there last render. A standing
  // waitingForUser must not keep forcing the panel open, or an explicit
  // collapse could never stick.
  const waitingEntryIds = new Set(
    entries
      .filter((entry) => entry.status === "waitingForUser")
      .map((entry) => entry.id),
  );
  const newlyWaiting = [...waitingEntryIds].some(
    (id) => !lastWaitingEntryIds.has(id),
  );
  if (newlyWaiting) state.attentionExpanded = true;
  // Drop a stale flag once nothing is waiting, so it can't pop the panel
  // open again later.
  if (waitingEntryIds.size === 0) state.attentionExpanded = false;
  lastWaitingEntryIds = waitingEntryIds;

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
    (state.attentionExpanded ||
      state.expanded ||
      state.focused ||
      Boolean(state.replyingEntryId) ||
      // Hovering holds the panel open: it must not collapse or fade out
      // under the pointer, even when the reason it expanded goes away.
      (state.hovered && lastRenderedExpanded));
  lastRenderedExpanded = expanded;

  const visible = state.enabled && hasEntries;
  hud.dataset.hasEntries = hasEntries ? "true" : "false";
  hud.dataset.visible = visible ? "true" : "false";

  // Going invisible: leave the last-rendered content in place under the
  // CSS fade so the panel fades out showing "Done" instead of blanking
  // and vanishing. The native window hides once the fade has played.
  if (!visible && windowShown) {
    lastRenderedExpanded = false;
    void syncWindowLayout(false, 0, hasEntries);
    scheduleStatusPrune();
    return;
  }

  // The surface width comes from CSS (280px expanded, content-sized pill
  // collapsed) and `auto` cannot transition, so expand/collapse animates
  // it FLIP-style: measure before the state flips, re-measure after, run
  // the px-to-px transition.
  const willFlipWidth =
    surface !== null &&
    windowShown &&
    (hud.dataset.expanded === "true") !== expanded;
  const widthBefore = willFlipWidth ? surface.getBoundingClientRect().width : 0;

  hud.dataset.expanded = expanded ? "true" : "false";
  hud.dataset.hasAction = hasAction ? "true" : "false";
  hud.dataset.menuOpen = state.menuOpen ? "true" : "false";

  renderPill(entries, expanded);

  // Only rebuild the rows when their visible content changes. Status events
  // arrive in bursts while a session works; recreating identical nodes on
  // each one restarts CSS animations (the status spinner) and reads as
  // flicker. Rows stay in the DOM while collapsed so the expand and
  // collapse reveal always has content to animate.
  const stackKey = entries
    .map((entry) =>
      [
        entry.id,
        entry.title,
        entry.summary,
        entry.status,
        state.replyingEntryId === entry.id ? "replying" : "",
      ].join("\u0001"),
    )
    .join("\u0002");
  if (stackKey !== lastStackKey) {
    lastStackKey = stackKey;
    const inputHadFocus =
      replyForm !== undefined && document.activeElement === replyForm.input;
    stack.replaceChildren();
    entries.forEach((entry, index) => {
      stack.appendChild(renderRow(entry, index));
    });
    // replaceChildren re-homes the cached form node, which drops focus.
    if (inputHadFocus && replyForm?.input.isConnected) replyForm.input.focus();
  }
  stack.setAttribute("aria-hidden", expanded ? "false" : "true");
  if (menu) {
    menu.hidden = !state.menuOpen;
    menu.setAttribute("aria-hidden", state.menuOpen ? "false" : "true");
  }

  if (willFlipWidth && surface) flipSurfaceWidth(surface, widthBefore);

  void syncWindowLayout(expanded, expanded ? entries.length : 0, hasEntries);
  scheduleStatusPrune();
}

function flipSurfaceWidth(target: HTMLElement, fromWidth: number) {
  if (widthFlipTimer !== undefined) {
    window.clearTimeout(widthFlipTimer);
    widthFlipTimer = undefined;
  }
  target.style.width = "";
  const toWidth = target.getBoundingClientRect().width;
  if (!fromWidth || !toWidth || Math.abs(toWidth - fromWidth) < 1) return;
  target.style.width = `${fromWidth}px`;
  // Force a layout so the starting width commits; the next assignment
  // then transitions instead of jumping.
  target.getBoundingClientRect();
  target.style.width = `${toWidth}px`;
  widthFlipTimer = window.setTimeout(() => {
    widthFlipTimer = undefined;
    // Hand the width back to the stylesheet (same computed value).
    target.style.width = "";
  }, 220);
}

function renderPill(entries: HudEntry[], expanded: boolean) {
  if (!pill || !mark || !pillLabel) return;
  const { label, status, runningCount, waitingCount } = pillSummary(entries);
  const activeCount = runningCount + waitingCount;
  const countOnly =
    status === "running" && runningCount > 1 && waitingCount === 0;
  mark.dataset.status = status;
  pill.dataset.countOnly = countOnly ? "true" : "false";
  pillLabel.textContent = label;
  if (pillBadge) {
    // Mixed state: the label leads with what needs the user; the badge
    // keeps the total active agent count visible at a glance.
    const showBadge = waitingCount > 0 && runningCount > 0;
    pillBadge.hidden = !showBadge;
    if (showBadge) {
      pillBadge.textContent = String(activeCount);
      pillBadge.setAttribute("aria-label", `${activeCount} active agents`);
      pillBadge.title = `${activeCount} active agents`;
    }
  }
  pill.setAttribute("aria-expanded", expanded ? "true" : "false");
  pill.setAttribute(
    "aria-label",
    expanded ? "Collapse agent activity" : "Expand agent activity",
  );
}

function pillSummary(entries: HudEntry[]): {
  label: string;
  status: HudSessionStatus;
  runningCount: number;
  waitingCount: number;
} {
  const waitingCount = entries.filter(
    (entry) => entry.status === "waitingForUser",
  ).length;
  const runningCount = entries.filter(
    (entry) =>
      entry.status === "received" ||
      entry.status === "starting" ||
      entry.status === "running",
  ).length;
  if (waitingCount > 0) {
    return {
      label:
        waitingCount === 1 ? "1 needs input" : `${waitingCount} need input`,
      status: "waitingForUser",
      runningCount,
      waitingCount,
    };
  }
  if (runningCount > 0) {
    return {
      label: runningCount === 1 ? "1 running" : String(runningCount),
      status: "running",
      runningCount,
      waitingCount,
    };
  }
  const [latest] = entries;
  if (latest) {
    return {
      label: statusLabel(latest.status),
      status: latest.status,
      runningCount,
      waitingCount,
    };
  }
  return { label: "Idle", status: "idle", runningCount, waitingCount };
}

function renderRow(entry: HudEntry, index: number) {
  const row = document.createElement("li");
  row.className = "agent-hud-row";
  row.dataset.status = entry.status;
  // Staggers the rows' fade-in when the panel expands (CSS transition
  // delay). Rows created while already expanded paint directly in their
  // final state, so they never re-run the entrance.
  row.style.setProperty("--row-index", String(index));

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
  // The entrance keyframes must run only on the first mount; the cached
  // form node gets re-appended on every stack rebuild while a draft is
  // open, and each re-append would restart them.
  form.addEventListener(
    "animationend",
    () => form.setAttribute("data-settled", ""),
    { once: true },
  );

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
    default:
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
    // No subject matched, but the status stream says no active work remains.
    // Mark all anonymous pending rows terminal as a best-effort cleanup; each
    // row keeps its own title, while the terminal summary comes from this
    // final record and may describe only the last session that reported.
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
    cancelPendingResize();
    scheduleWindowHide(!state.enabled);
    return;
  }
  cancelWindowHide();
  cancelPendingResize();
  const height = nativeWindowHeight(expanded, rowCount, replying, menuOpen);
  const apply = async () => {
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
  };
  // Growing: the window must be at full size before the CSS reveal plays.
  // Shrinking: the reveal collapses first, then the window snaps down under
  // the (already pill-sized) surface; resizing immediately would clip the
  // animation mid-flight.
  if (windowShown && height < lastWindowHeight) {
    resizeTimer = window.setTimeout(() => {
      resizeTimer = undefined;
      void apply();
    }, COLLAPSE_RESIZE_DELAY_MS);
  } else {
    await apply();
  }
  lastWindowHeight = height;
}

/* Mirrors agent_hud_window_size in agent_hud.rs, only to tell growth from
 * shrinkage; the Rust side stays the source of truth for the real size. */
function nativeWindowHeight(
  expanded: boolean,
  rowCount: number,
  replying: boolean,
  menuOpen: boolean,
) {
  const height =
    !expanded || rowCount === 0
      ? 58
      : 8 + 36 + Math.min(rowCount, 3) * 46 + 6 + (replying ? 32 : 0) + 14;
  return menuOpen ? Math.max(height, 104) : height;
}

function cancelPendingResize() {
  if (resizeTimer === undefined) return;
  window.clearTimeout(resizeTimer);
  resizeTimer = undefined;
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
    // An explicit collapse clears the attention auto-expand; otherwise the
    // next render would immediately re-expand while a session still waits.
    state.attentionExpanded = false;
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
      appendIcon(parent, IconCircleQuestionmark, 14);
      return;
    case "completed":
      appendIcon(parent, IconCheckmark1Small, 14);
      return;
    case "failed":
    case "cancelled":
      appendIcon(
        parent,
        status === "failed" ? IconCrossSmall : IconStopCircle,
        14,
      );
      return;
    case "received":
    case "starting":
    case "running":
      appendDotSpinner(parent);
      return;
    case "idle":
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

// The HUD is an overlay with no text-selection use case, so suppress the
// native WKWebView context menu everywhere in this window and surface our
// own menu instead. In the real app the native panel swallows right- and
// ctrl-clicks before WKWebView sees them (see the Tauri listener below);
// this DOM listener is the fallback for the standalone browser/demo page,
// where there is no native panel to intercept.
window.addEventListener("contextmenu", (event) => {
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

// The native panel intercepts the right-/ctrl-click and asks us to open the
// menu. The click never reaches the DOM, so there is no competing
// pointerdown to close it again (the window pointerdown handler only fires
// for clicks the webview actually receives).
void listen(AGENT_HUD_CONTEXT_MENU_EVENT, () => openMenu()).catch(() => {});

setIcon(pillChevron, IconChevronDownSmall, 14);
render();

// Console driver for this page when served standalone in a browser:
// __agentHud("waiting") etc. See lib/agent-hud-demo.ts.
if (import.meta.env.DEV) {
  void import("./lib/agent-hud-demo").then(({ registerAgentHudDemo }) =>
    registerAgentHudDemo({ local: true }),
  );
}
