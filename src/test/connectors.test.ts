import { describe, expect, it } from "vitest";
import {
  ALL_SCOPE_BUNDLES,
  AUTONOMY_RUN_THRESHOLD,
  BUNDLE_META,
  CONNECTOR_ACTION_TOOLSETS,
  CONNECTOR_READ_TOOLSETS,
  SANDBOXED_ROUTINE_BASE_TOOLSETS,
  TRIGGER_META,
  TRUST_MODE_META,
  accountStatusMeta,
  autonomyProgressLabel,
  autonomyUnlockHint,
  biographyPrompt,
  bundlesFromScopes,
  canSelectAutonomous,
  eventTriggerScheduleDraft,
  extractBiographyMarkdown,
  grantedFeatureLabels,
  isConnectorNotConfiguredError,
  routineToolsetsFor,
  routineTrustModeFromToolsets,
  scopesCoverBundles,
  triggerConfigFromDraft,
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

  it("recovers bundles from granted scope URLs, ignoring identity scopes", () => {
    expect(bundlesFromScopes(["openid", "email", GMAIL_READONLY, CALENDAR_EVENTS])).toEqual([
      "gmail_read",
      "calendar_events",
    ]);
    expect(bundlesFromScopes([])).toEqual([]);
  });

  it("renders granted scopes as human feature labels", () => {
    expect(grantedFeatureLabels([GMAIL_READONLY, GMAIL_COMPOSE])).toEqual([
      "Read mail",
      "Draft replies",
    ]);
  });

  it("checks scope coverage per bundle", () => {
    expect(scopesCoverBundles([GMAIL_READONLY, CALENDAR_EVENTS], ["gmail_read"])).toBe(true);
    expect(scopesCoverBundles([GMAIL_READONLY], ["gmail_read", "calendar_events"])).toBe(false);
  });

  it("keeps bundle copy sentence case with no typographic dashes", () => {
    for (const bundle of ALL_SCOPE_BUNDLES) {
      const meta = BUNDLE_META[bundle];
      for (const text of [meta.label, meta.description, meta.feature]) {
        expect(text).not.toMatch(/[–—]/);
      }
      // Sentence case: no shouting labels.
      expect(meta.label).not.toMatch(/^[A-Z\s]+$/);
    }
  });
});

describe("account status", () => {
  it("labels connected and reconnect_required accounts", () => {
    expect(accountStatusMeta("connected")).toMatchObject({ label: "Connected", tone: "ok" });
    expect(accountStatusMeta("reconnect_required")).toMatchObject({
      label: "Reconnect needed",
      tone: "attention",
    });
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
    expect(autonomyUnlockHint(0)).toBe("Runs 3 more times with approvals to unlock autonomous.");
    expect(autonomyUnlockHint(2)).toBe("Runs 1 more time with approvals to unlock autonomous.");
    expect(autonomyUnlockHint(3)).toBe("Autonomous is unlocked for this routine.");
  });

  it("shows approval progress toward autonomy", () => {
    expect(autonomyProgressLabel(1)).toBe("Run 2 of 3 approvals before autonomy unlocks.");
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
    expect(toolsets).not.toContain("june_gmail_actions");
  });

  it("approval: adds the actions servers on top of the read servers", () => {
    const toolsets = routineToolsetsFor("approval", { unrestricted: false });
    expect(toolsets).toContain("june_gmail_actions");
    expect(toolsets).toContain("june_gcal_actions");
    expect(toolsets).toContain("june_gmail");
  });

  it("autonomous: swaps actions servers for the per-job auto servers", () => {
    const toolsets = routineToolsetsFor("autonomous", {
      unrestricted: false,
      autonomousServers: ["june_gmail_auto_ab12cd34"],
    });
    expect(toolsets).toContain("june_gmail_auto_ab12cd34");
    expect(toolsets).not.toContain("june_gmail_actions");
    expect(toolsets).not.toContain("june_gcal_actions");
    expect(toolsets).toContain("june_gmail");
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
    expect(routineTrustModeFromToolsets(["june_gmail", "june_gmail_actions"])).toBe("approval");
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
});

describe("biography", () => {
  it("frames the prompt as local-only and read-only", () => {
    const prompt = biographyPrompt();
    expect(prompt).toContain("stays on this Mac");
    expect(prompt).toContain("june_context");
    expect(prompt).toContain("gmail and gcal read tools");
    expect(prompt).toContain("read tools only");
    expect(prompt).toContain("```markdown");
    expect(prompt).not.toMatch(/[–—]/);
  });

  it("extracts the fenced markdown block from a final message", () => {
    const message = [
      "Here is your profile.",
      "```markdown",
      "# About you",
      "You lead the June desktop work.",
      "```",
      "Saved nothing yet.",
    ].join("\n");
    expect(extractBiographyMarkdown(message)).toBe("# About you\nYou lead the June desktop work.");
  });

  it("falls back to a bare fenced block and to null", () => {
    expect(extractBiographyMarkdown("```\nplain block\n```")).toBe("plain block");
    expect(extractBiographyMarkdown("no fences here")).toBeNull();
    expect(extractBiographyMarkdown("```markdown\n\n```")).toBeNull();
  });
});
