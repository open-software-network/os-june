import { IconCircleInfo } from "central-icons/IconCircleInfo";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { IconShield } from "central-icons/IconShield";
import { IconShieldCheck } from "central-icons/IconShieldCheck";
import {
  exposurePolicyOptions,
  securityLabel,
  useMcpSecurity,
  type HermesAdminMode,
  type McpExposurePolicy,
  type McpSecurityLabelCode,
  type McpSecurityState,
} from "../../lib/hermes-admin";
import { AdminNotifications } from "./AdminNotifications";

type McpSecuritySectionProps = {
  /** The write-access mode whose runtime this page targets. Defaults to the safe
   * sandboxed runtime; the host can point it at Full mode explicitly. */
  mode?: HermesAdminMode;
};

/** The security labels June explains on this page, in display order, so a user
 * sees what each badge on the MCP pages means. */
const EXPLAINED_LABELS: readonly McpSecurityLabelCode[] = [
  "local-subprocess",
  "remote-server",
  "oauth",
  "secret-backed",
  "sandbox-constrained",
  "unrestricted-capable",
];

/**
 * June's MCP security page (spec 19). It owns the GLOBAL default MCP exposure
 * policy (install disabled / enable with a safe allowlist / enable all), which
 * is the only mutating part of the feature, plus a reference legend that
 * explains the per-server security labels (local subprocess / remote server /
 * OAuth / secret-backed / sandbox constrained / unrestricted capable) the MCP
 * servers and catalog pages surface inline.
 *
 * The per-server risk warnings and confirmation gates live on those pages,
 * close to the enable/install action they guard; this page sets the policy and
 * documents the model. The policy write goes through the typed `hermes-admin`
 * client, the shared cache, and the gateway lifecycle, so the apply-timing copy
 * is honest: a config change applies next session.
 */
export function McpSecuritySection({
  mode = "sandboxed",
}: McpSecuritySectionProps) {
  const state = useMcpSecurity(mode);
  return <McpSecurityView state={state} mode={mode} />;
}

/**
 * The render-only view, split out so component tests can drive it with a stubbed
 * {@link McpSecurityState} (no Tauri, no network) and assert the policy radio +
 * the conservative default.
 */
export function McpSecurityView({
  state,
  mode = "sandboxed",
}: {
  state: McpSecurityState;
  mode?: HermesAdminMode;
}) {
  const isUnavailable = state.status === "unavailable";
  const isErrored = state.status === "error";
  const isLoadingFirst = state.status === "loading";
  const disabled = isUnavailable || isLoadingFirst || state.busy;

  return (
    <section
      className="settings-group mcp-security"
      aria-labelledby="mcp-security-heading"
    >
      <h2 id="mcp-security-heading" className="settings-group-heading">
        MCP security
      </h2>
      <p className="settings-group-description">
        Control how much new MCP servers can do by default, and learn what each
        security label on the MCP pages means. Changes apply next session.{" "}
        <ModeNote
          mode={state.mode ?? mode}
          profile={state.profile}
          show={!isUnavailable}
        />
      </p>

      <LifecycleBanner state={state} />
      <AdminNotifications
        notifications={state.notifications}
        onDismiss={state.dismissNotification}
      />

      <div className="settings-card mcp-security-card">
        <div className="mcp-security-policy-head">
          <h3 className="settings-row-title">Default exposure policy</h3>
          <p className="settings-row-description">
            How a newly installed MCP server is exposed to your sessions. The
            most conservative option is recommended.
          </p>
        </div>

        {isUnavailable ? (
          <p className="mcp-security-note" role="status">
            <IconCircleInfo size={14} ariaHidden />
            Start Hermes to set the default MCP exposure policy.
          </p>
        ) : isErrored ? (
          <div className="mcp-security-error" role="alert">
            <p className="mcp-servers-empty-description">
              {state.error ?? "Could not load the MCP exposure policy."}
            </p>
            {state.retryable ? (
              <button
                type="button"
                className="mcp-servers-retry"
                onClick={state.refresh}
              >
                Try again
              </button>
            ) : null}
          </div>
        ) : (
          <fieldset
            className="mcp-security-policy"
            role="radiogroup"
            aria-label="Default MCP exposure policy"
          >
            {exposurePolicyOptions().map((option) => (
              <PolicyOption
                key={option.policy}
                policy={option.policy}
                label={option.label}
                description={option.description}
                recommended={option.recommended}
                selected={state.policy === option.policy}
                disabled={disabled}
                onSelect={() => state.setPolicy(option.policy)}
              />
            ))}
          </fieldset>
        )}

        {state.error && !isErrored ? (
          <p className="mcp-security-write-error" role="alert">
            <IconExclamationCircle size={13} ariaHidden />
            {state.error}
          </p>
        ) : null}
      </div>

      <div className="settings-card mcp-security-card">
        <div className="mcp-security-policy-head">
          <h3 className="settings-row-title">What the labels mean</h3>
          <p className="settings-row-description">
            Every MCP server shows these labels so where code runs, what secrets
            it sees, and what the sandbox protects are explicit.
          </p>
        </div>
        <ul className="mcp-security-legend">
          {EXPLAINED_LABELS.map((code) => {
            const meta = securityLabel(code);
            return (
              <li key={code} className="mcp-security-legend-item">
                <span
                  className="mcp-server-risk mcp-security-legend-badge"
                  data-tone={meta.tone}
                >
                  <IconShield size={12} ariaHidden />
                  {meta.label}
                </span>
                <span className="mcp-security-legend-blurb">{meta.blurb}</span>
              </li>
            );
          })}
        </ul>
        <p className="mcp-security-note">
          <IconShieldCheck size={14} ariaHidden />
          High-risk servers (file, shell, browser, database, or cloud admin
          tools) ask for confirmation before they turn on. None of these checks
          block a server. They make the risk explicit so you decide.
        </p>
      </div>
    </section>
  );
}

/** One exposure-policy radio option. */
function PolicyOption({
  policy,
  label,
  description,
  recommended,
  selected,
  disabled,
  onSelect,
}: {
  policy: McpExposurePolicy;
  label: string;
  description: string;
  recommended: boolean;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className="mcp-security-policy-option"
      data-selected={selected}
      data-policy={policy}
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="mcp-security-policy-option-head">
        <span className="mcp-security-policy-option-label">{label}</span>
        {recommended ? (
          <span className="mcp-security-policy-recommended">Recommended</span>
        ) : null}
      </span>
      <span className="mcp-security-policy-option-description">
        {description}
      </span>
    </button>
  );
}

/** The sandbox/full-mode + profile context line. */
function ModeNote({
  mode,
  profile,
  show,
}: {
  mode: HermesAdminMode;
  profile?: string;
  show: boolean;
}) {
  if (!show) return null;
  const modeLabel = mode === "unrestricted" ? "Full mode" : "Sandboxed";
  return (
    <span className="mcp-servers-mode-note">
      Targeting the {modeLabel} runtime
      {profile ? ` (profile ${profile})` : ""}.
    </span>
  );
}

/** The shared gateway-lifecycle banner. A config write is next-session, so this
 * surfaces the pending state once the policy changes. */
function LifecycleBanner({ state }: { state: McpSecurityState }) {
  const snapshot = state.lifecycle;
  if (state.status === "unavailable") return null;
  if (snapshot.state === "clean") return null;
  const tone =
    snapshot.state === "restart-failed"
      ? "destructive"
      : snapshot.state === "gateway-restart-required" ||
          snapshot.state === "active-session-should-restart"
        ? "warning"
        : "info";
  return (
    <div className="mcp-servers-lifecycle" data-tone={tone} role="status">
      <span className="mcp-servers-lifecycle-eyebrow">
        <IconCircleInfo size={15} ariaHidden />
        {snapshot.label}
      </span>
      <span className="mcp-servers-lifecycle-body">{snapshot.detail}</span>
    </div>
  );
}
