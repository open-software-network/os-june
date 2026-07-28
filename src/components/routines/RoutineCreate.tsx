import { IconGoogle } from "central-icons/IconGoogle";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import {
  TRUST_MODE_META,
  isConnectorNotConfiguredError,
  routineAccountRoleDescription,
  scopesCoverBundles,
  triggerRequiredBundles,
  triggerScopeWarning,
  type TriggerDraft,
} from "../../lib/connectors";
import { useConnectorPolicy } from "../../lib/connector-policy";
import { messageFromError } from "../../lib/errors";
import {
  draftFromSchedule,
  scheduleFromDraft,
  type ScheduleDraft,
} from "../../lib/routine-schedule";
import {
  connectorsApplyRuntime,
  connectorsCancelConnect,
  connectorsConnect,
  connectorsList,
  CONNECTOR_AUTHORIZATION_URL_EVENT,
  createConnectorFlowId,
  openExternalUrl,
  type ConnectorAuthorizationUrlPayload,
  type ConnectorAccount,
  type RoutineTrustMode,
} from "../../lib/tauri";
import { BreadcrumbBar } from "../ui/BreadcrumbBar";
import { InlineNotice } from "../ui/InlineNotice";
import { Select } from "../ui/Select";
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
  /** Explicit Google account selected for an event trigger or autonomous grant. */
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
  const { policy } = useConnectorPolicy();
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
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const connectFlowRef = useRef<string | null>(null);
  const authorizationListenerReadyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen(
      CONNECTOR_AUTHORIZATION_URL_EVENT,
      (event: { payload: ConnectorAuthorizationUrlPayload }) => {
        if (
          !cancelled &&
          event.payload.provider === "google" &&
          event.payload.flowId === connectFlowRef.current
        ) {
          setAuthorizationUrl(event.payload.url);
        }
      },
    )
      .then((cleanup) => {
        if (cancelled) cleanup();
        else {
          authorizationListenerReadyRef.current = true;
          unlisten = cleanup;
        }
      })
      .catch((error) => {
        if (!cancelled) setConnectError(messageFromError(error));
      });
    return () => {
      cancelled = true;
      authorizationListenerReadyRef.current = false;
      if (connectFlowRef.current) void connectorsCancelConnect(connectFlowRef.current);
      unlisten?.();
    };
  }, []);

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
  const connectedAccounts = (accounts ?? []).filter(
    (account) => account.provider === "google" && account.status === "connected",
  );
  useEffect(() => {
    if (selectedAccountId || connectedAccounts.length !== 1) return;
    setSelectedAccountId(connectedAccounts[0].accountId);
  }, [connectedAccounts, selectedAccountId]);
  const selectedAccount = connectedAccounts.find(
    (account) => account.accountId === selectedAccountId,
  );
  // Every connector-aware unattended run is bound to one Google account.
  // This includes scheduled reads and approval-mode actions, not only event
  // triggers and autonomous grants.
  const accountPickerRequired =
    trigger.source !== "schedule" || trustMode !== "read_only" || Boolean(requiredScopes);
  const scopeAccount = accountPickerRequired
    ? selectedAccount
    : connectedAccounts.find(
        (account) =>
          !requiredScopes ||
          (policy != null && scopesCoverBundles(policy, account.scopes, requiredScopes)),
      );
  const scopeGateSatisfied =
    !requiredScopes ||
    (policy != null &&
      scopeAccount != null &&
      scopesCoverBundles(policy, scopeAccount.scopes, requiredScopes));
  // A connector trigger must run on an account that holds the scope its daemon
  // polls (Gmail read for new mail, calendar read for upcoming events). Checking
  // "any account connected" is not enough: a calendar-only account can't back an
  // email_received trigger, so the daemon's Gmail history call fails and the
  // routine silently never fires. A broader granted scope still counts (an
  // account with calendar write backs an upcoming-event trigger).
  const triggerBundles = policy ? triggerRequiredBundles(policy, trigger) : [];
  const triggerScopeSatisfied =
    trigger.source === "schedule" ||
    (policy != null &&
      triggerBundles.length > 0 &&
      selectedAccount != null &&
      scopesCoverBundles(policy, selectedAccount.scopes, triggerBundles));
  const connectorPolicyRequired =
    Boolean(requiredScopes) || trigger.source !== "schedule" || trustMode !== "read_only";
  const blocked =
    (connectorPolicyRequired && policy == null) ||
    (accountPickerRequired && !selectedAccount) ||
    !scopeGateSatisfied ||
    !triggerScopeSatisfied;

  async function connectForTemplate() {
    if (!requiredScopes || !policy || connectFlowRef.current) return;
    if (!authorizationListenerReadyRef.current) {
      setConnectError("The authorization window is still loading. Try again.");
      return;
    }
    const flowId = createConnectorFlowId();
    connectFlowRef.current = flowId;
    setConnectBusy(true);
    setConnectError(null);
    setAuthorizationUrl(null);
    try {
      const connected = await connectorsConnect({
        scopes: requiredScopes,
        loginHint: selectedAccount?.email,
        provider: "google",
        flowId,
      });
      await connectorsApplyRuntime();
      setAccounts(await connectorsList());
      setSelectedAccountId(connected.accountId);
    } catch (err) {
      setConnectError(
        isConnectorNotConfiguredError(err)
          ? "Google connector isn't configured in this build."
          : messageFromError(err),
      );
    } finally {
      if (connectFlowRef.current === flowId) connectFlowRef.current = null;
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
      triggerAccountId: selectedAccount?.accountId,
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

        {accountPickerRequired && accounts !== null && connectedAccounts.length === 0 ? (
          <InlineNotice
            tone="info"
            aria-label="Google account needed"
            body={
              connectError ??
              "This routine needs one connected Google account. Connect it in Plugins, then return here to choose it."
            }
            actions={
              requiredScopes ? (
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
              ) : undefined
            }
          />
        ) : null}

        {requiredScopes &&
        connectedAccounts.length > 0 &&
        !scopeGateSatisfied &&
        !(accountPickerRequired && connectedAccounts.length > 1 && !selectedAccount) ? (
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

        {connectBusy && authorizationUrl ? (
          <details className="connector-authorization-fallback">
            <summary>Trouble opening your browser?</summary>
            <div className="connector-authorization-fallback-body">
              <label htmlFor="routine-authorization-url">Authorization link</label>
              <input
                id="routine-authorization-url"
                className="text-input"
                value={authorizationUrl}
                readOnly
              />
              <button
                type="button"
                className="btn btn-secondary connector-authorization-open"
                onClick={() => {
                  void openExternalUrl(authorizationUrl).catch((error) =>
                    setConnectError(messageFromError(error)),
                  );
                }}
              >
                Open again
              </button>
              <p>This link works only in a browser on this Mac.</p>
            </div>
          </details>
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
                hasAccount={connectedAccounts.length > 0}
                scopeWarning={
                  policy
                    ? triggerScopeWarning(policy, trigger, selectedAccount?.scopes ?? null)
                    : null
                }
                onTriggerChange={setTrigger}
                onScheduleChange={setDraft}
              />
              {accountPickerRequired ? (
                <div className="settings-row">
                  <div className="settings-row-info">
                    <div className="settings-row-title">Google account</div>
                    <div className="settings-row-description">
                      {routineAccountRoleDescription(trigger, trustMode)}
                    </div>
                  </div>
                  <div className="settings-row-control">
                    <Select
                      value={selectedAccountId}
                      options={connectedAccounts.map((account) => ({
                        value: account.accountId,
                        label: account.email,
                      }))}
                      placeholder="Choose account"
                      ariaLabel="Google account"
                      onChange={setSelectedAccountId}
                      popoverWidth="trigger"
                    />
                  </div>
                </div>
              ) : null}
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
                policy={policy}
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
