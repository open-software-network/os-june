import { describe, expect, it } from "vitest";
import {
  actionToolLabel,
  AUTONOMY_RUN_THRESHOLD,
  BUNDLE_META,
  autonomyRuntimeNeedsRestart,
  CONNECTOR_ACTION_TOOLS,
  CONNECTOR_ACTION_TOOLSETS,
  CONNECTOR_READ_TOOLSETS,
  GOOGLE_SCOPE_BUNDLES,
  GRANTABLE_CONNECTOR_ACTION_TOOLS,
  LINEAR_SCOPE_BUNDLES,
  SANDBOXED_ROUTINE_BASE_TOOLSETS,
  TRIGGER_META,
  TRUST_MODE_META,
  accountStatusMeta,
  autonomyProgressLabel,
  autonomyUnlockHint,
  bundlesForProvider,
  bundlesFromScopes,
  canSelectAutonomous,
  eventTriggerScheduleDraft,
  grantedFeatureLabels,
  isConnectorNotConfiguredError,
  isCreditableRun,
  providerFromServer,
  routineToolsetsFor,
  routineTrustModeFromToolsets,
  scopesCoverBundles,
  triggerConfigFromDraft,
  triggerRequiredBundles,
  triggerScopeWarning,
} from "../lib/connectors";
import { UNRESTRICTED_ROUTINE_TOOLSETS } from "../lib/hermes-routines";

const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_COMPOSE = "https://www.googleapis.com/auth/gmail.compose";
const GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";
const CALENDAR_EVENTS = "https://www.googleapis.com/auth/calendar.events";

describe("scope bundles", () => {
  it("maps every bundle to its Google scope URLs", () => {
    expect(BUNDLE_META.gmail_read.scopeUrls).toEqual([GMAIL_READONLY]);
    expect(BUNDLE_META.gmail_draft.scopeUrls).toEqual([GMAIL_COMPOSE]);
    expect(BUNDLE_META.gmail_send.scopeUrls).toEqual([GMAIL_SEND]);
    expect(BUNDLE_META.calendar_events.scopeUrls).toEqual([CALENDAR_EVENTS]);
  });

  it("maps every Linear bundle to its short scope name", () => {
    expect(BUNDLE_META.linear_read.scopeUrls).toEqual(["read"]);
    expect(BUNDLE_META.linear_write.scopeUrls).toEqual(["write"]);
    expect(BUNDLE_META.linear_read.label).toBe("Read workspace");
    expect(BUNDLE_META.linear_write.label).toBe("Create and update issues");
  });

  it("lists bundles per provider with no cross-provider bundles", () => {
    expect(bundlesForProvider("google")).toEqual(GOOGLE_SCOPE_BUNDLES);
    expect(bundlesForProvider("linear")).toEqual(LINEAR_SCOPE_BUNDLES);
    expect(GOOGLE_SCOPE_BUNDLES).not.toEqual(
      expect.arrayContaining(["linear_read", "linear_write"]),
    );
    expect(LINEAR_SCOPE_BUNDLES).not.toEqual(
      expect.arrayContaining([
        "gmail_read",
        "gmail_draft",
        "gmail_modify",
        "gmail_send",
        "calendar_read",
        "calendar_events",
      ]),
    );
  });

  it("recovers bundles from granted scope URLs, ignoring identity scopes", () => {
    expect(
      bundlesFromScopes(["openid", "email", GMAIL_READONLY, CALENDAR_EVENTS], "google"),
    ).toEqual(["gmail_read", "calendar_events"]);
    expect(bundlesFromScopes([], "google")).toEqual([]);
  });

  it("scopes bundlesFromScopes to the given provider, never cross-matching", () => {
    // Linear's "read" scope name never collides with a Google bundle, even
    // though both providers are checked against the same account.scopes
    // shape.
    expect(bundlesFromScopes(["read"], "linear")).toEqual(["linear_read"]);
    expect(bundlesFromScopes(["read"], "google")).toEqual([]);
  });

  it("renders granted scopes as human feature labels", () => {
    expect(grantedFeatureLabels([GMAIL_READONLY, GMAIL_COMPOSE], "google")).toEqual([
      "Read mail",
      "Draft replies",
    ]);
    expect(grantedFeatureLabels(["read", "write"], "linear")).toEqual([
      "Read workspace",
      "Create and update issues",
    ]);
  });

  it("checks scope coverage per bundle", () => {
    expect(scopesCoverBundles([GMAIL_READONLY, CALENDAR_EVENTS], ["gmail_read"])).toBe(true);
    expect(scopesCoverBundles([GMAIL_READONLY], ["gmail_read", "calendar_events"])).toBe(false);
  });

  it("credits only finished, non-failed runs toward autonomy", () => {
    expect(isCreditableRun({ status: "completed", ended_at: "2026-07-09T10:00:00Z" })).toBe(true);
    expect(isCreditableRun({ status: "completed", endedAt: "2026-07-09T10:00:00Z" })).toBe(true);
    // Still running: no end timestamp, or flagged active.
    expect(isCreditableRun({ status: "running" })).toBe(false);
    expect(isCreditableRun({ active: true, ended_at: "2026-07-09T10:00:00Z" })).toBe(false);
    // Finished but not "correctly".
    expect(isCreditableRun({ status: "failed", ended_at: "2026-07-09T10:00:00Z" })).toBe(false);
    expect(isCreditableRun({ status: "cancelled", ended_at: "2026-07-09T10:00:00Z" })).toBe(false);
  });

  it("treats a broader granted scope as covering a narrower read need", () => {
    // calendar.events (write) satisfies a read-only briefing, so the user is
    // not re-prompted for calendar.readonly they effectively already hold.
    expect(scopesCoverBundles([CALENDAR_EVENTS], ["calendar_read"])).toBe(true);
    expect(
      scopesCoverBundles(["https://www.googleapis.com/auth/gmail.modify"], ["gmail_read"]),
    ).toBe(true);
    // But a narrower grant never covers a broader need.
    expect(scopesCoverBundles([GMAIL_READONLY], ["gmail_modify"])).toBe(false);
  });

  it("keeps bundle copy sentence case with no typographic dashes", () => {
    for (const bundle of [...GOOGLE_SCOPE_BUNDLES, ...LINEAR_SCOPE_BUNDLES]) {
      const meta = BUNDLE_META[bundle];
      for (const text of [meta.label, meta.description, meta.feature]) {
        expect(text).not.toMatch(/[–—]/);
      }
      // Sentence case: no shouting labels.
      expect(meta.label).not.toMatch(/^[A-Z\s]+$/);
    }
  });
});

describe("autonomyRuntimeNeedsRestart", () => {
  const base = {
    previousServers: ["june_gmail_auto_abc"],
    nextServers: ["june_gmail_auto_abc"],
    trustMode: "autonomous" as const,
    previousTools: ["create_draft"],
    nextTools: ["create_draft"],
  };

  it("restarts when the auto server set changes", () => {
    expect(autonomyRuntimeNeedsRestart({ ...base, nextServers: ["june_gcal_auto_abc"] })).toBe(
      true,
    );
  });

  it("restarts when an autonomous routine's tools change within a provider", () => {
    // Same server name, but the grant token and tools.include were re-minted.
    expect(
      autonomyRuntimeNeedsRestart({ ...base, nextTools: ["create_draft", "send_email"] }),
    ).toBe(true);
  });

  it("does not restart when nothing relevant changed", () => {
    expect(autonomyRuntimeNeedsRestart(base)).toBe(false);
  });

  it("ignores tool changes when the routine is not autonomous", () => {
    // Leaving autonomous already changes the server set; a non-autonomous mode
    // never re-mints a same-named grant, so tool diffs alone do not restart.
    expect(
      autonomyRuntimeNeedsRestart({
        ...base,
        trustMode: "approval",
        nextTools: ["create_draft", "send_email"],
      }),
    ).toBe(false);
  });
});

describe("account status", () => {
  it("labels connected and reconnect_required accounts", () => {
    expect(accountStatusMeta("connected", "google")).toMatchObject({
      label: "Connected",
      tone: "ok",
    });
    expect(accountStatusMeta("reconnect_required", "google")).toMatchObject({
      label: "Reconnect needed",
      tone: "attention",
    });
  });

  it("names the provider in the reconnect blurb, sharing the connected blurb", () => {
    expect(accountStatusMeta("reconnect_required", "google").blurb).toBe(
      "Google needs you to sign in again before June can use this account.",
    );
    expect(accountStatusMeta("reconnect_required", "linear").blurb).toBe(
      "Linear needs you to sign in again before June can use this workspace.",
    );
    expect(accountStatusMeta("connected", "google").blurb).toBe(
      accountStatusMeta("connected", "linear").blurb,
    );
  });

  it("recognizes the connector_not_configured error code", () => {
    expect(
      isConnectorNotConfiguredError({ code: "connector_not_configured", message: "no client id" }),
    ).toBe(true);
    expect(isConnectorNotConfiguredError(new Error("boom"))).toBe(false);
  });
});

describe("earned autonomy", () => {
  it("unlocks autonomous at the run threshold", () => {
    expect(AUTONOMY_RUN_THRESHOLD).toBe(3);
    expect(canSelectAutonomous(0)).toBe(false);
    expect(canSelectAutonomous(2)).toBe(false);
    expect(canSelectAutonomous(3)).toBe(true);
    expect(canSelectAutonomous(7)).toBe(true);
  });

  it("phrases the unlock hint by remaining runs", () => {
    expect(autonomyUnlockHint(0)).toBe("Runs 3 more times under approval to unlock autonomous.");
    expect(autonomyUnlockHint(2)).toBe("Runs 1 more time under approval to unlock autonomous.");
    expect(autonomyUnlockHint(3)).toBe("Autonomous is unlocked for this routine.");
  });

  it("shows approval progress toward autonomy", () => {
    expect(autonomyProgressLabel(1)).toBe("Run 2 of 3 under approval before autonomy unlocks.");
    expect(autonomyProgressLabel(3)).toBe("Autonomy unlocked.");
  });
});

describe("routineToolsetsFor", () => {
  it("read_only sandboxed: sandboxed base plus read servers, no actions", () => {
    const toolsets = routineToolsetsFor("read_only", { unrestricted: false });
    expect(toolsets).toEqual([...SANDBOXED_ROUTINE_BASE_TOOLSETS, ...CONNECTOR_READ_TOOLSETS]);
    for (const server of CONNECTOR_ACTION_TOOLSETS) {
      expect(toolsets).not.toContain(server);
    }
  });

  it("read_only unrestricted: the unrestricted list plus read servers", () => {
    const toolsets = routineToolsetsFor("read_only", { unrestricted: true });
    for (const toolset of UNRESTRICTED_ROUTINE_TOOLSETS) {
      expect(toolsets).toContain(toolset);
    }
    expect(toolsets).toContain("june_gmail");
    expect(toolsets).toContain("june_gcal");
    expect(toolsets).toContain("june_linear");
    expect(toolsets).toContain("june_notion");
    expect(toolsets).not.toContain("june_gmail_actions");
    expect(toolsets).not.toContain("june_notion_actions");
  });

  it("approval: adds the actions servers on top of the read servers", () => {
    const toolsets = routineToolsetsFor("approval", { unrestricted: false });
    expect(toolsets).toContain("june_gmail_actions");
    expect(toolsets).toContain("june_gcal_actions");
    expect(toolsets).toContain("june_linear_actions");
    expect(toolsets).toContain("june_notion_actions");
    expect(toolsets).toContain("june_gmail");
    expect(toolsets).toContain("june_notion");
  });

  it("autonomous: swaps actions servers for the per-job auto servers", () => {
    const toolsets = routineToolsetsFor("autonomous", {
      unrestricted: false,
      autonomousServers: ["june_gmail_auto_ab12cd34"],
    });
    expect(toolsets).toContain("june_gmail_auto_ab12cd34");
    expect(toolsets).not.toContain("june_gmail_actions");
    expect(toolsets).not.toContain("june_gcal_actions");
    expect(toolsets).not.toContain("june_notion_actions");
    expect(toolsets).toContain("june_gmail");
    expect(toolsets).toContain("june_notion");
  });

  it("dedupes and stays stable with no auto servers granted", () => {
    const toolsets = routineToolsetsFor("autonomous", { unrestricted: false });
    expect(new Set(toolsets).size).toBe(toolsets.length);
    expect(toolsets.some((t) => t.includes("auto"))).toBe(false);
  });
});

describe("routineTrustModeFromToolsets", () => {
  it("derives the mode a stored override implies", () => {
    expect(routineTrustModeFromToolsets(undefined)).toBeNull();
    expect(routineTrustModeFromToolsets(["web", "memory"])).toBeNull();
    expect(routineTrustModeFromToolsets(["web", "june_gmail"])).toBe("read_only");
    expect(routineTrustModeFromToolsets(["web", "june_linear"])).toBe("read_only");
    expect(routineTrustModeFromToolsets(["june_gmail", "june_gmail_actions"])).toBe("approval");
    expect(routineTrustModeFromToolsets(["june_notion", "june_notion_actions"])).toBe("approval");
    expect(routineTrustModeFromToolsets(["june_gmail", "june_gcal_auto_ab12cd34"])).toBe(
      "autonomous",
    );
  });
});

describe("trust mode metadata", () => {
  it("carries sentence-case labels and icons for all three modes", () => {
    expect(TRUST_MODE_META.read_only.label).toBe("Read only");
    expect(TRUST_MODE_META.approval.label).toBe("Approval");
    expect(TRUST_MODE_META.autonomous.label).toBe("Autonomous");
    for (const meta of Object.values(TRUST_MODE_META)) {
      expect(meta.icon).toBeTruthy();
      expect(meta.description).not.toMatch(/[–—]/);
    }
  });
});

describe("event triggers", () => {
  it("creates event routines paused on a far-future one-time schedule", () => {
    const draft = eventTriggerScheduleDraft();
    expect(draft.paused).toBe(true);
    // Far enough that the scheduler itself never fires the job; the trigger
    // daemon owns it.
    expect(new Date(draft.schedule).getFullYear()).toBeGreaterThanOrEqual(2099);
    // Never a cron expression: events do not encode into the cron string.
    expect(draft.schedule.split(/\s+/)).toHaveLength(1);
  });

  it("builds the trigger config payload per kind", () => {
    expect(triggerConfigFromDraft({ source: "email_received" })).toEqual({});
    expect(
      triggerConfigFromDraft({ source: "event_upcoming", leadMinutes: 30, externalOnly: true }),
    ).toEqual({ leadMinutes: 30, externalOnly: true });
  });

  it("has metadata for both kinds", () => {
    expect(TRIGGER_META.email_received.label).toBe("When new email arrives");
    expect(TRIGGER_META.event_upcoming.label).toBe("Before an upcoming meeting");
    expect(TRIGGER_META.event_upcoming.configFields).toEqual(["leadMinutes", "externalOnly"]);
  });

  it("maps each connector trigger to the scope its daemon polls", () => {
    expect(triggerRequiredBundles({ source: "schedule" })).toEqual([]);
    expect(triggerRequiredBundles({ source: "email_received" })).toEqual(["gmail_read"]);
    expect(
      triggerRequiredBundles({ source: "event_upcoming", leadMinutes: 30, externalOnly: true }),
    ).toEqual(["calendar_read"]);
  });

  it("warns only when a connected account lacks the trigger's scope", () => {
    // A calendar-only account can't back an email_received trigger.
    expect(triggerScopeWarning({ source: "email_received" }, [CALENDAR_EVENTS])).toBe(
      "This trigger needs read mail access on your connected Google account. Add it in Settings under Connectors.",
    );
    // Gmail read covers the new-mail trigger, so no warning.
    expect(triggerScopeWarning({ source: "email_received" }, [GMAIL_READONLY])).toBeNull();
    // A broader granted scope (calendar write) covers the upcoming-event trigger.
    expect(
      triggerScopeWarning({ source: "event_upcoming", leadMinutes: 30, externalOnly: true }, [
        CALENDAR_EVENTS,
      ]),
    ).toBeNull();
    // Schedules need no scope.
    expect(triggerScopeWarning({ source: "schedule" }, [])).toBeNull();
    // No account connected: the picker owns the "connect an account" notice.
    expect(triggerScopeWarning({ source: "email_received" }, null)).toBeNull();
  });
});

describe("providerFromServer", () => {
  it("maps connector MCP server names to their provider", () => {
    expect(providerFromServer("june_gmail_actions")).toBe("google");
    expect(providerFromServer("june_gcal")).toBe("google");
    expect(providerFromServer("june_gcal_auto_abc123")).toBe("google");
    expect(providerFromServer("june_notion_actions")).toBe("notion");
    expect(providerFromServer("june_linear")).toBe("linear");
    expect(providerFromServer("june_linear_auto_xyz")).toBe("linear");
    expect(providerFromServer("june_linear_actions")).toBe("linear");
    expect(providerFromServer("web")).toBeNull();
  });
});

describe("connector action tools", () => {
  it("registers june_linear_actions as an action toolset", () => {
    expect(CONNECTOR_ACTION_TOOLSETS).toContain("june_linear_actions");
    expect(CONNECTOR_ACTION_TOOLSETS).toContain("june_gmail_actions");
    expect(CONNECTOR_ACTION_TOOLSETS).toContain("june_gcal_actions");
    expect(CONNECTOR_ACTION_TOOLSETS).toContain("june_notion_actions");
  });

  it("labels the four Linear action tools for the approvals surface", () => {
    expect(actionToolLabel("create_issue")).toBe("Create issues");
    expect(actionToolLabel("update_issue")).toBe("Update issues");
    expect(actionToolLabel("add_comment")).toBe("Comment on issues");
    expect(actionToolLabel("create_project_update")).toBe("Post project updates");
    expect(actionToolLabel("notion-create-pages")).toBe("Create Notion pages");
    expect(actionToolLabel("notion-update-page")).toBe("Update Notion pages");
  });

  it("marks only Google action tools grantable", () => {
    const google = CONNECTOR_ACTION_TOOLS.filter((tool) => tool.server.startsWith("june_g"));
    const linear = CONNECTOR_ACTION_TOOLS.filter((tool) => tool.server === "june_linear_actions");
    const notion = CONNECTOR_ACTION_TOOLS.filter((tool) => tool.server === "june_notion_actions");
    expect(google.length).toBeGreaterThan(0);
    expect(linear).toHaveLength(4);
    expect(notion).toHaveLength(2);
    for (const tool of google) {
      expect(tool.grantable).toBe(true);
    }
    for (const tool of [...linear, ...notion]) {
      expect(tool.grantable).toBe(false);
    }
  });

  it("excludes Linear and Notion tools from earned autonomy while keeping Google tools", () => {
    // The grant-checklist consumer must read GRANTABLE_CONNECTOR_ACTION_TOOLS
    // (not CONNECTOR_ACTION_TOOLS directly) so Linear and Notion actions never
    // appear as grantable.
    const ids = GRANTABLE_CONNECTOR_ACTION_TOOLS.map((tool) => tool.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "create_draft",
        "send_email",
        "modify_labels",
        "archive",
        "create_event",
        "respond_to_invite",
      ]),
    );
    expect(ids).not.toEqual(
      expect.arrayContaining([
        "create_issue",
        "update_issue",
        "add_comment",
        "create_project_update",
      ]),
    );
    expect(GRANTABLE_CONNECTOR_ACTION_TOOLS.every((tool) => tool.grantable)).toBe(true);
  });
});
