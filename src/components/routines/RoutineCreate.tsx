import { IconGoogle } from "central-icons/IconGoogle";
import { useEffect, useState } from "react";
import {
  TRUST_MODE_META,
  isConnectorNotConfiguredError,
  scopesCoverBundles,
  triggerRequiredBundles,
  triggerScopeWarning,
  type TriggerDraft,
} from "../../lib/connectors";
import { messageFromError } from "../../lib/errors";
import {
  draftFromSchedule,
  scheduleFromDraft,
  type ScheduleDraft,
} from "../../lib/routine-schedule";
import {
  connectorsApplyRuntime,
  connectorsConnect,
  connectorsList,
  type ConnectorAccount,
  type RoutineTrustMode,
} from "../../lib/tauri";
import { BreadcrumbBar } from "../ui/BreadcrumbBar";
import { InlineNotice } from "../ui/InlineNotice";
import { GrowingTextarea } from "./GrowingTextarea";
import { RoutineModePicker } from "./RoutineModePicker";
import { TriggerPicker } from "./TriggerPicker";
import { TrustModePicker } from "./TrustModePicker";
import type { RoutineTemplate } from "./routine-templates";

export type RoutineCreateInput = {
  prompt: string;
  schedule: string;
  name?: string;
  unrestricted: boolean;
  /** Connector trust for the new routine (read only unless chosen). */
  trustMode: RoutineTrustMode;
  autonomousTools: string[];
  /** The "When" choice: a schedule, or a connector event trigger. */
  trigger: TriggerDraft;
  /** Account the event trigger subscribes on (first connected account). */
  triggerAccountId?: string;
  /** Set when installing a connector template, so the create flow knows to
   * persist trust and queue the immediate first run. */
  connectorScopes?: RoutineTemplate["connectorScopes"];
};

type RoutineCreateProps = {
  /** Prefills the editor; the user still reviews and saves explicitly. */
  template?: RoutineTemplate;
  creating: boolean;
  error: string | null;
  onBack: () => void;
  onCreate: (input: RoutineCreateInput) => void;
};

export function RoutineCreate({ template, creating, error, onBack, onCreate }: RoutineCreateProps) {
  const [name, setName] = useState(template?.name ?? "");
  const [draft, setDraft] = useState<ScheduleDraft>(() =>
    template ? draftFromSchedule(template.schedule) : { kind: "daily", time: "09:00" },
  );
  const [prompt, setPrompt] = useState(template?.prompt ?? "");
  const [unrestricted, setUnrestricted] = useState(template?.unrestricted ?? false);
  const [trustMode, setTrustMode] = useState<RoutineTrustMode>(template?.trustMode ?? "read_only");
  const [autonomousTools, setAutonomousTools] = useState<string[]>([]);
  const [trigger, setTrigger] = useState<TriggerDraft>(() => {
    const templateTrigger = template?.trigger;
    if (!templateTrigger) return { source: "schedule" };
    if (templateTrigger.kind === "email_received") return { source: "email_received" };
    return {
      source: "event_upcoming",
      leadMinutes: templateTrigger.leadMinutes ?? 30,
      externalOnly: templateTrigger.externalOnly ?? true,
    };
  });
  // null while loading; connector features degrade quietly (plain routines
  // never need an account, and the Rust side may not be present in dev).
  const [accounts, setAccounts] = useState<ConnectorAccount[] | null>(null);
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    connectorsList()
      .then((list) => {
        if (!cancelled) setAccounts(list);
      })
      .catch(() => {
        if (!cancelled) setAccounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const requiredScopes = template?.connectorScopes;
  // The routine runs against the first connected account (triggerAccountId
  // below, and the bridge registers the same account for its MCP servers), so
  // the scope gate must check that exact account. Checking "any account" would
  // enable Create while the routine still polls/calls Google with an account
  // that lacks the scope, silently missing triggers or failing on scope errors.
  const connectedAccount = (accounts ?? []).find(
    (account) => account.provider === "google" && account.status === "connected",
  );
  const scopeGateSatisfied =
    !requiredScopes ||
    (connectedAccount != null && scopesCoverBundles(connectedAccount.scopes, requiredScopes));
  // A connector trigger must run on an account that holds the scope its daemon
  // polls (Gmail read for new mail, calendar read for upcoming events). Checking
  // "any account connected" is not enough: a calendar-only account can't back an
  // email_received trigger, so the daemon's Gmail history call fails and the
  // routine silently never fires. A broader granted scope still counts (an
  // account with calendar write backs an upcoming-event trigger).
  const triggerBundles = triggerRequiredBundles(trigger);
  const triggerScopeSatisfied =
    triggerBundles.length === 0 ||
    (connectedAccount != null && scopesCoverBundles(connectedAccount.scopes, triggerBundles));
  const blocked = !scopeGateSatisfied || !triggerScopeSatisfied;

  async function connectForTemplate() {
    if (!requiredScopes || connectBusy) return;
    setConnectBusy(true);
    setConnectError(null);
    try {
      await connectorsConnect({ scopes: requiredScopes });
      await connectorsApplyRuntime();
      setAccounts(await connectorsList());
    } catch (err) {
      setConnectError(
        isConnectorNotConfiguredError(err)
          ? "Google connector isn't configured in this build."
          : messageFromError(err),
      );
    } finally {
      setConnectBusy(false);
    }
  }

  function submit() {
    if (!prompt.trim() || blocked) return;
    onCreate({
      prompt: prompt.trim(),
      schedule: scheduleFromDraft(draft),
      name: name.trim() || undefined,
      unrestricted,
      trustMode,
      autonomousTools,
      trigger,
      triggerAccountId: connectedAccount?.accountId,
      connectorScopes: requiredScopes,
    });
  }

  return (
    <section className="routine-detail" aria-label="New routine">
      <BreadcrumbBar
        backLabel="Back to routines"
        onBack={onBack}
        items={[{ label: "Routines", onClick: onBack }, { label: name.trim() || "New routine" }]}
        actions={
          <div className="routine-detail-actions">
            <button type="button" className="btn btn-ghost" onClick={onBack}>
              Cancel
            </button>
            <button
              type="button"
              className="primary-action primary-solid"
              disabled={!prompt.trim() || creating || blocked}
              onClick={submit}
            >
              {creating ? "Creating…" : "Create"}
            </button>
          </div>
        }
      />

      <div className="routine-detail-content">
        <input
          className="routine-detail-name"
          value={name}
          placeholder="Routine name"
          aria-label="Routine name"
          onChange={(event) => setName(event.currentTarget.value)}
        />

        {error ? <p className="error-banner">{error}</p> : null}

        {template?.toolSummary ? (
          <p className="routines-tool-summary">
            {template.toolSummary}. Trust: {TRUST_MODE_META[trustMode].label.toLowerCase()}.
          </p>
        ) : null}

        {requiredScopes && !scopeGateSatisfied ? (
          <InlineNotice
            tone="info"
            aria-label="Google account required"
            body={
              connectError ??
              "This routine needs a connected Google account with the listed access before it can be created."
            }
            actions={
              <button
                type="button"
                className="btn btn-secondary"
                disabled={connectBusy}
                aria-busy={connectBusy || undefined}
                onClick={() => void connectForTemplate()}
              >
                <IconGoogle size={13} aria-hidden />
                {connectBusy ? "Waiting for browser…" : "Connect Google account"}
              </button>
            }
          />
        ) : null}

        <div className="routine-detail-body">
          <section className="settings-group" aria-labelledby="routine-schedule">
            <h2 id="routine-schedule" className="settings-group-heading">
              When
            </h2>
            <div className="settings-card">
              <TriggerPicker
                trigger={trigger}
                scheduleDraft={draft}
                hasAccount={Boolean(connectedAccount)}
                scopeWarning={triggerScopeWarning(trigger, connectedAccount?.scopes ?? null)}
                onTriggerChange={setTrigger}
                onScheduleChange={setDraft}
              />
            </div>
          </section>

          <section className="settings-group" aria-labelledby="routine-instructions">
            <h2 id="routine-instructions" className="settings-group-heading">
              Instructions
            </h2>
            <GrowingTextarea
              className="routine-detail-instructions"
              value={prompt}
              aria-label="Instructions"
              placeholder="Summarize my unread notes and list anything that needs a reply…"
              onChange={(event) => setPrompt(event.currentTarget.value)}
            />
          </section>

          <section className="settings-group" aria-labelledby="routine-access">
            <h2 id="routine-access" className="settings-group-heading">
              Access
            </h2>
            <div className="settings-card">
              <RoutineModePicker unrestricted={unrestricted} onChange={setUnrestricted} />
            </div>
          </section>

          <section className="settings-group" aria-labelledby="routine-trust">
            <h2 id="routine-trust" className="settings-group-heading">
              Actions
            </h2>
            <div className="settings-card">
              <TrustModePicker
                value={trustMode}
                runCount={0}
                autonomousTools={autonomousTools}
                onChange={setTrustMode}
                onAutonomousToolsChange={setAutonomousTools}
              />
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}
