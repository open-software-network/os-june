import { emit, listen } from "@tauri-apps/api/event";
import mascotUrl from "./assets/june-pangolin.svg";
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
  getMascotEnabled,
  MASCOT_ENABLED_KEY,
  MASCOT_VISIBILITY_CHANGED_EVENT,
  type MascotVisibilityChangedDetail,
} from "./lib/mascot-settings";
import {
  mascotHide,
  mascotOpenAgent,
  mascotSetLayout,
  mascotShow,
} from "./lib/tauri";
import type { HermesSessionInfo } from "./lib/tauri";
import "./styles/mascot.css";

type MascotSessionStatus = AgentSessionStatusKind | "idle";

type StatusRecord = AgentSessionStatusDetail & {
  receivedAt: number;
};

type MascotEntry = {
  id: string;
  title: string;
  summary: string;
  status: MascotSessionStatus;
  updatedAt: string;
  session?: HermesSessionInfo;
};

const EXPANDED_KEY = "scribe:mascot:expanded";
const MAX_VISIBLE_CARDS = 3;
const COMPLETED_STATUS_TTL_MS = 12 * 1000;
const FAILED_STATUS_TTL_MS = 8 * 1000;

const mascot = document.querySelector<HTMLElement>("#mascot");
const stack = document.querySelector<HTMLElement>("#mascot-stack");
const toggle = document.querySelector<HTMLButtonElement>("#mascot-toggle");
const avatar = document.querySelector<HTMLButtonElement>("#mascot-avatar");
const image = document.querySelector<HTMLImageElement>("#mascot-image");

if (image) image.src = mascotUrl;

const state = {
  enabled: getMascotEnabled(),
  expanded: localStorage.getItem(EXPANDED_KEY) === "true",
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
let pruneTimer: number | undefined;

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
        ].slice(0, MAX_VISIBLE_CARDS);
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
        ].slice(0, MAX_VISIBLE_CARDS);
      }
      render();
      return;
    }
    const key = statusSubject(record);
    state.pendingStatuses = [
      record,
      ...state.pendingStatuses.filter((item) => statusSubject(item) !== key),
    ].slice(0, MAX_VISIBLE_CARDS);
  }
  if (
    isActiveStatus(detail.status) &&
    localStorage.getItem(EXPANDED_KEY) === null
  ) {
    state.expanded = true;
  }
  pruneOldStatuses();
  render();
}

function applyVisibility(enabled: boolean) {
  state.enabled = enabled;
  render();
  if (enabled) {
    void mascotShow().catch(() => {});
  } else {
    void mascotHide().catch(() => {});
  }
}

function render() {
  if (!mascot || !stack || !toggle) return;

  pruneOldStatuses();
  const realEntries = buildEntries(false);
  const entries = state.expanded ? buildEntries(true) : realEntries;
  const hasEntries = realEntries.length > 0;
  const expanded = state.enabled && state.expanded && realEntries.length > 0;
  const active = realEntries.some((entry) => isActiveStatus(entry.status));

  mascot.dataset.expanded = expanded ? "true" : "false";
  mascot.dataset.active = active ? "true" : "false";
  mascot.dataset.hasEntries = hasEntries ? "true" : "false";
  // Only rebuild the cards when their visible content changes. Status events
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
          ].join("\u0001"),
        )
        .join("\u0002")
    : "collapsed";
  if (stackKey !== lastStackKey) {
    lastStackKey = stackKey;
    stack.replaceChildren();
    if (expanded) {
      for (const entry of entries) stack.appendChild(renderCard(entry));
    }
  }
  stack.setAttribute("aria-hidden", expanded ? "false" : "true");
  toggle.hidden = !hasEntries;
  toggle.setAttribute("aria-hidden", hasEntries ? "false" : "true");
  toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  toggle.setAttribute(
    "aria-label",
    expanded ? "Collapse June mascot" : "Expand June mascot",
  );

  void syncWindowLayout(expanded, expanded ? entries.length : 0);
  scheduleStatusPrune();
}

function renderCard(entry: MascotEntry) {
  const card = document.createElement("article");
  card.className = "mascot-card";
  card.dataset.status = entry.status;

  const body = document.createElement("button");
  body.type = "button";
  body.className = "mascot-card-body";
  body.addEventListener("click", () => {
    void openAgent(entry.session);
  });

  const title = document.createElement("h2");
  title.textContent = entry.title;
  body.appendChild(title);

  const summary = document.createElement("p");
  summary.textContent = entry.summary;
  body.appendChild(summary);

  const status = document.createElement("span");
  status.className = "mascot-status";
  status.dataset.status = entry.status;
  status.setAttribute("aria-hidden", "true");
  body.appendChild(status);
  card.appendChild(body);

  const actions = document.createElement("div");
  actions.className = "mascot-card-actions";

  const reply = document.createElement("button");
  reply.type = "button";
  reply.className = "mascot-reply";
  reply.textContent = "Reply";
  reply.addEventListener("click", (event) => {
    event.stopPropagation();
    state.replyingEntryId = entry.id;
    render();
    window.setTimeout(() => {
      document.querySelector<HTMLInputElement>(".mascot-reply-input")?.focus();
    }, 0);
  });
  actions.appendChild(reply);
  if (actions.childElementCount > 0) card.appendChild(actions);

  if (state.replyingEntryId === entry.id) {
    card.appendChild(renderReplyForm(entry));
  }

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "mascot-dismiss";
  dismiss.setAttribute("aria-label", "Collapse June mascot");
  dismiss.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setExpanded(false);
  });
  card.appendChild(dismiss);

  return card;
}

function renderReplyForm(entry: MascotEntry) {
  const form = document.createElement("form");
  form.className = "mascot-reply-form";

  const input = document.createElement("input");
  input.className = "mascot-reply-input";
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
  submit.className = "mascot-reply-send";
  submit.textContent = "Send";

  form.append(input, submit);
  form.addEventListener("click", (event) => event.stopPropagation());
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    state.replyingEntryId = undefined;
    render();
    void sendReply(entry, text);
  });

  return form;
}

function buildEntries(includeIdle: boolean) {
  const now = Date.now();
  const entries: MascotEntry[] = [];
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

  const sorted = entries.sort(compareEntries).slice(0, MAX_VISIBLE_CARDS);

  if (!sorted.length && includeIdle) {
    sorted.push({
      id: "idle",
      title: "No active sessions",
      summary: "June is ready.",
      status: "idle",
      updatedAt: new Date(0).toISOString(),
    });
  }

  return sorted;
}

function entryFromSession(
  session: HermesSessionInfo,
  record?: StatusRecord,
): MascotEntry {
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

function entryFromPending(record: StatusRecord): MascotEntry {
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
): MascotSessionStatus {
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
  status: MascotSessionStatus,
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

function statusLabel(status: MascotSessionStatus) {
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

function compareEntries(a: MascotEntry, b: MascotEntry) {
  const rank = statusRank(a.status) - statusRank(b.status);
  if (rank !== 0) return rank;
  return b.updatedAt.localeCompare(a.updatedAt);
}

function statusRank(status: MascotSessionStatus) {
  if (status === "waitingForUser") return 0;
  if (status === "received" || status === "starting" || status === "running")
    return 1;
  if (status === "failed") return 2;
  if (status === "completed" || status === "cancelled") return 3;
  return 4;
}

function isActiveStatus(status: MascotSessionStatus) {
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
    ].slice(0, MAX_VISIBLE_CARDS);
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
  const expiration = terminalExpiration(record);
  return expiration !== undefined && now > expiration;
}

function terminalStatusTtl(status: MascotSessionStatus) {
  if (status === "completed" || status === "cancelled") {
    return COMPLETED_STATUS_TTL_MS;
  }
  if (status === "failed") return FAILED_STATUS_TTL_MS;
  return undefined;
}

function shouldRenderEntry(entry: MascotEntry) {
  return isActiveStatus(entry.status) || isTerminalStatus(entry.status);
}

function isTerminalStatus(status: MascotSessionStatus) {
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

async function syncWindowLayout(expanded: boolean, cardCount: number) {
  const replying = Boolean(state.replyingEntryId);
  const key = `${state.enabled}:${expanded}:${cardCount}:${replying}`;
  if (key === lastLayoutKey) return;
  lastLayoutKey = key;
  if (!state.enabled) {
    await mascotHide().catch(() => {});
    return;
  }
  await mascotSetLayout({ expanded, cardCount, replying }).catch(() => {});
  await mascotShow().catch(() => {});
}

function setExpanded(expanded: boolean) {
  if (!expanded) {
    state.replyingEntryId = undefined;
  }
  state.expanded = expanded;
  localStorage.setItem(EXPANDED_KEY, expanded ? "true" : "false");
  render();
}

async function openAgent(session?: HermesSessionInfo) {
  await mascotOpenAgent(session).catch(() => {
    window.dispatchEvent(
      new CustomEvent(AGENT_OPEN_EVENT, {
        detail: { session },
      }),
    );
  });
}

async function sendReply(entry: MascotEntry, text: string) {
  await openAgent(entry.session);
  const detail: AgentReplyDetail = {
    requestId: `mascot:${Date.now()}:${Math.random().toString(36).slice(2)}`,
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
  const renderedExpanded = mascot?.dataset.expanded === "true";
  setExpanded(!renderedExpanded);
}

toggle?.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  event.stopPropagation();
  toggleExpanded();
});

toggle?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  toggleExpanded();
});

avatar?.addEventListener("click", () => {
  const [entry] = buildEntries(false);
  void openAgent(entry?.session);
});

window.addEventListener(MASCOT_VISIBILITY_CHANGED_EVENT, (event) => {
  const detail = (event as CustomEvent<MascotVisibilityChangedDetail>).detail;
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
  if (event.key === MASCOT_ENABLED_KEY) {
    applyVisibility(event.newValue !== "false");
  }
});

void listen<AgentSessionsChangedDetail>(AGENT_SESSIONS_CHANGED_EVENT, (event) =>
  applySessionsChanged(event.payload),
).catch(() => {});

void listen<AgentSessionStatusDetail>(AGENT_SESSION_STATUS_EVENT, (event) =>
  applyStatus(event.payload),
).catch(() => {});

void listen<MascotVisibilityChangedDetail>(
  MASCOT_VISIBILITY_CHANGED_EVENT,
  (event) => applyVisibility(event.payload.enabled),
).catch(() => {});

render();
applyVisibility(state.enabled);
