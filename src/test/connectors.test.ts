import { describe, expect, it } from "vitest";
import {
  TRUST_MODE_META,
  TRIGGER_META,
  accountStatusMeta,
  actionToolLabel,
  autonomyProgressLabel,
  autonomyRuntimeNeedsRestart,
  autonomyUnlockHint,
  bundleMeta,
  bundlesForProvider,
  bundlesFromScopes,
  canSelectAutonomous,
  connectorActionTools,
  defaultBundlesForProvider,
  eventTriggerScheduleDraft,
  grantableConnectorActionTools,
  grantedFeatureLabels,
  isConnectorNotConfiguredError,
  isCreditableRun,
  missingConnectorPresentationIds,
  providerFromServer,
  routineToolsetsFor,
  routineTrustModeFromToolsets,
  scopesCoverBundles,
  triggerConfigFromDraft,
  triggerRequiredBundles,
  triggerScopeWarning,
} from "../lib/connectors";
import { UNRESTRICTED_ROUTINE_TOOLSETS } from "../lib/hermes-routines";
import { representativeConnectorPolicy } from "./fixtures/connector-policy";

const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_COMPOSE = "https://www.googleapis.com/auth/gmail.compose";
const CALENDAR_EVENTS = "https://www.googleapis.com/auth/calendar.events";

describe("native connector policy projection", () => {
  const policy = representativeConnectorPolicy();

  it("preserves provider order, availability, bundle order, and defaults", () => {
    expect(policy.providers.map((provider) => provider.id)).toEqual([
      "google",
      "linear",
      "github",
      "notion",
    ]);
    expect(policy.providers.every((provider) => provider.enabled)).toBe(true);
    expect(bundlesForProvider(policy, "google")).toEqual([
      "gmail_read",
      "gmail_draft",
      "gmail_modify",
      "gmail_send",
      "calendar_read",
      "calendar_events",
    ]);
    expect(bundlesForProvider(policy, "linear")).toEqual(["linear_read", "linear_write"]);
    expect(bundlesForProvider(policy, "github")).toEqual(["github_read", "github_write"]);
    expect(defaultBundlesForProvider(policy, "google")).toEqual(["gmail_read", "calendar_read"]);
    expect(defaultBundlesForProvider(policy, "linear")).toEqual(["linear_read"]);
    expect(defaultBundlesForProvider(policy, "github")).toEqual(["github_read"]);
  });

  it("projects native bundle scopes without a renderer scope registry", () => {
    expect(
      bundlesFromScopes(policy, ["openid", "email", GMAIL_READONLY, CALENDAR_EVENTS], "google"),
    ).toEqual(["gmail_read", "calendar_events"]);
    expect(bundlesFromScopes(policy, ["read"], "linear")).toEqual(["linear_read"]);
    expect(bundlesFromScopes(policy, ["read"], "github")).toEqual(["github_read"]);
    expect(bundlesFromScopes(policy, ["read"], "google")).toEqual([]);
    expect(grantedFeatureLabels(policy, [GMAIL_READONLY, GMAIL_COMPOSE], "google")).toEqual([
      "Read mail",
      "Draft replies",
    ]);
  });

  it("uses native scope implications for eligibility", () => {
    expect(scopesCoverBundles(policy, [CALENDAR_EVENTS], ["calendar_read"])).toBe(true);
    expect(
      scopesCoverBundles(
        policy,
        ["https://www.googleapis.com/auth/gmail.modify"],
        ["gmail_read", "gmail_draft"],
      ),
    ).toBe(true);
    expect(scopesCoverBundles(policy, [GMAIL_READONLY], ["gmail_modify"])).toBe(false);
  });

  it("applies a native policy change in the renderer with no second policy edit", () => {
    const changed = representativeConnectorPolicy();
    changed.earnedAutonomyMinApprovalRuns = 5;
    changed.scopeImplications.push({
      held: GMAIL_COMPOSE,
      grants: [GMAIL_READONLY],
    });
    const createIssue = changed.actionTools.find((tool) => tool.id === "create_issue");
    expect(createIssue).toBeDefined();
    if (createIssue) createIssue.grantable = true;

    expect(canSelectAutonomous(changed, 3)).toBe(false);
    expect(canSelectAutonomous(changed, 5)).toBe(true);
    expect(scopesCoverBundles(changed, [GMAIL_COMPOSE], ["gmail_read"])).toBe(true);
    expect(grantableConnectorActionTools(changed).map((tool) => tool.id)).toContain("create_issue");
  });

  it("has presentation copy for every native bundle and action identity", () => {
    expect(missingConnectorPresentationIds(policy)).toEqual([]);
    for (const bundle of policy.scopeBundles) {
      const meta = bundleMeta(bundle.id);
      for (const text of [meta.label, meta.description, meta.feature]) {
        expect(text).not.toMatch(/[–—]/);
      }
      expect(meta.label).not.toMatch(/^[A-Z\s]+$/);
    }
  });
});

describe("account and run status", () => {
  it("labels connector account states", () => {
    expect(accountStatusMeta("connected", "google")).toMatchObject({
      label: "Connected",
      tone: "ok",
    });
    expect(accountStatusMeta("reconnect_required", "linear").blurb).toBe(
      "Linear needs you to sign in again before June can use this workspace.",
    );
    expect(accountStatusMeta("unavailable", "notion").label).toBe("Status unavailable");
  });

  it("recognizes connector configuration errors", () => {
    expect(
      isConnectorNotConfiguredError({ code: "connector_not_configured", message: "no client id" }),
    ).toBe(true);
    expect(isConnectorNotConfiguredError(new Error("boom"))).toBe(false);
  });

  it("credits only finished, non-failed runs", () => {
    expect(isCreditableRun({ status: "completed", ended_at: "2026-07-09T10:00:00Z" })).toBe(true);
    expect(isCreditableRun({ status: "completed", endedAt: "2026-07-09T10:00:00Z" })).toBe(true);
    expect(isCreditableRun({ status: "running" })).toBe(false);
    expect(isCreditableRun({ active: true, ended_at: "2026-07-09T10:00:00Z" })).toBe(false);
    expect(isCreditableRun({ status: "failed", ended_at: "2026-07-09T10:00:00Z" })).toBe(false);
  });
});

describe("earned autonomy", () => {
  const policy = representativeConnectorPolicy();

  it("reads the threshold and copy from native policy", () => {
    expect(canSelectAutonomous(policy, 2)).toBe(false);
    expect(canSelectAutonomous(policy, 3)).toBe(true);
    expect(autonomyUnlockHint(policy, 2)).toBe(
      "Runs 1 more time under approval to unlock autonomous.",
    );
    expect(autonomyProgressLabel(policy, 1)).toBe(
      "Run 2 of 3 under approval before autonomy unlocks.",
    );
  });

  it("detects connector runtime changes", () => {
    const base = {
      previousServers: ["june_gmail_auto_abc"],
      nextServers: ["june_gmail_auto_abc"],
      trustMode: "autonomous" as const,
      previousTools: ["create_draft"],
      nextTools: ["create_draft"],
    };
    expect(autonomyRuntimeNeedsRestart(base)).toBe(false);
    expect(
      autonomyRuntimeNeedsRestart({
        ...base,
        nextTools: ["create_draft", "send_email"],
      }),
    ).toBe(true);
    expect(
      autonomyRuntimeNeedsRestart({
        ...base,
        trustMode: "approval",
        nextTools: ["create_draft", "send_email"],
      }),
    ).toBe(false);
  });
});

describe("routine connector toolsets", () => {
  const policy = representativeConnectorPolicy();

  it("composes each trust mode from the native routine policy", () => {
    expect(routineToolsetsFor(policy, "read_only", { unrestricted: false })).toEqual([
      ...policy.routine.sandboxedBaseToolsets,
      ...policy.routine.readToolsets,
    ]);
    const unrestricted = routineToolsetsFor(policy, "read_only", { unrestricted: true });
    expect(unrestricted).toEqual([
      ...UNRESTRICTED_ROUTINE_TOOLSETS,
      ...policy.routine.readToolsets,
    ]);
    const approval = routineToolsetsFor(policy, "approval", { unrestricted: false });
    expect(approval).toEqual([
      ...policy.routine.sandboxedBaseToolsets,
      ...policy.routine.readToolsets,
      ...policy.routine.actionToolsets,
    ]);
    const autonomous = routineToolsetsFor(policy, "autonomous", {
      unrestricted: false,
      autonomousServers: ["june_gmail_auto_ab12cd34"],
    });
    expect(autonomous).toContain("june_gmail_auto_ab12cd34");
    expect(autonomous).not.toContain("june_gmail_actions");
  });

  it("derives trust from native action and autonomous identities", () => {
    expect(routineTrustModeFromToolsets(policy, undefined)).toBeNull();
    expect(routineTrustModeFromToolsets(policy, ["web", "june_gmail"])).toBe("read_only");
    expect(routineTrustModeFromToolsets(policy, ["june_gmail_actions"])).toBe("approval");
    expect(routineTrustModeFromToolsets(policy, ["june_gcal_auto_ab12cd34"])).toBe("autonomous");
  });
});

describe("event triggers", () => {
  const policy = representativeConnectorPolicy();

  it("keeps presentation metadata and payload encoding in the renderer", () => {
    expect(TRIGGER_META.email_received.label).toBe("When new email arrives");
    expect(TRIGGER_META.event_upcoming.configFields).toEqual(["leadMinutes", "externalOnly"]);
    expect(triggerConfigFromDraft({ source: "email_received" })).toEqual({});
    expect(
      triggerConfigFromDraft({
        source: "event_upcoming",
        leadMinutes: 30,
        externalOnly: true,
      }),
    ).toEqual({ leadMinutes: 30, externalOnly: true });
    const draft = eventTriggerScheduleDraft();
    expect(draft.paused).toBe(true);
    expect(new Date(draft.schedule).getFullYear()).toBeGreaterThanOrEqual(2099);
  });

  it("reads trigger scope requirements from native policy", () => {
    expect(triggerRequiredBundles(policy, { source: "schedule" })).toEqual([]);
    expect(triggerRequiredBundles(policy, { source: "email_received" })).toEqual(["gmail_read"]);
    expect(
      triggerRequiredBundles(policy, {
        source: "event_upcoming",
        leadMinutes: 30,
        externalOnly: true,
      }),
    ).toEqual(["calendar_read"]);
    expect(triggerScopeWarning(policy, { source: "email_received" }, [CALENDAR_EVENTS])).toBe(
      "This trigger needs read mail access on your connected Google account. Add it in Settings under Plugins.",
    );
    expect(triggerScopeWarning(policy, { source: "email_received" }, [GMAIL_READONLY])).toBeNull();
  });
});

describe("connector server and action presentation", () => {
  const policy = representativeConnectorPolicy();

  it("maps server names using native ownership prefixes", () => {
    expect(providerFromServer(policy, "june_gmail_actions")).toBe("google");
    expect(providerFromServer(policy, "june_gcal_auto_abc123")).toBe("google");
    expect(providerFromServer(policy, "june_linear_auto_xyz")).toBe("linear");
    expect(providerFromServer(policy, "june_notion_actions")).toBe("notion");
    expect(providerFromServer(policy, "june_github_actions")).toBe("github");
    expect(providerFromServer(policy, "web")).toBeNull();
  });

  it("labels native action identities and preserves colliding tool ids", () => {
    expect(actionToolLabel(policy, "add_comment", "june_linear_actions")).toBe("Comment on issues");
    expect(actionToolLabel(policy, "add_comment", "june_github_actions")).toBe("Add comment");
    expect(actionToolLabel(policy, "create_issue")).toBe("Create issues");
    expect(actionToolLabel(policy, "do_thing", "june_github_actions")).toBe("do thing");
    expect(
      connectorActionTools(policy)
        .filter((tool) => tool.provider === "github")
        .map((tool) => tool.label),
    ).toEqual(["Create issue", "Update issue", "Add comment"]);
  });

  it("offers autonomous grants only for native-grantable tools", () => {
    const tools = connectorActionTools(policy);
    expect(tools.filter((tool) => tool.provider === "google").every((tool) => tool.grantable)).toBe(
      true,
    );
    expect(
      tools.filter((tool) => tool.provider !== "google").every((tool) => !tool.grantable),
    ).toBe(true);
    expect(grantableConnectorActionTools(policy).map((tool) => tool.id)).toEqual([
      "create_draft",
      "send_email",
      "modify_labels",
      "archive",
      "create_event",
      "respond_to_invite",
    ]);
  });
});

describe("trust mode metadata", () => {
  it("carries sentence-case labels and icons", () => {
    expect(TRUST_MODE_META.read_only.label).toBe("Read only");
    expect(TRUST_MODE_META.approval.label).toBe("Approval");
    expect(TRUST_MODE_META.autonomous.label).toBe("Autonomous");
    for (const meta of Object.values(TRUST_MODE_META)) {
      expect(meta.icon).toBeTruthy();
      expect(meta.description).not.toMatch(/[–—]/);
    }
  });
});
