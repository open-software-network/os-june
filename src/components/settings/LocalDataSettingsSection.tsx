import { useEffect, useState } from "react";
import {
  localDataRetentionPolicies,
  type LocalDataRetentionPolicyDto,
} from "../../lib/tauri";

export function LocalDataSettingsSection() {
  const [policies, setPolicies] = useState<LocalDataRetentionPolicyDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;

    async function loadPolicies() {
      setLoading(true);
      setError(undefined);
      try {
        const response = await localDataRetentionPolicies();
        if (cancelled) return;
        setPolicies(response.policies);
      } catch (err) {
        if (!cancelled) setError(messageFromError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadPolicies();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="settings-group" aria-labelledby="local-data-heading">
      <h2 id="local-data-heading" className="settings-group-heading">
        Local data
      </h2>
      <p className="settings-group-description">
        Current retention behavior for data stored on this Mac.
      </p>
      <div className="settings-card">
        <div className="settings-rows">
          {loading && policies.length === 0 ? (
            <div className="settings-row">
              <div className="settings-row-info">
                <h3 className="settings-row-title">
                  Loading retention policies
                </h3>
                <p className="settings-row-description">
                  Checking the current local data policy.
                </p>
              </div>
            </div>
          ) : null}

          {policies.map((policy) => (
            <div className="settings-row" key={policy.id}>
              <div className="settings-row-info">
                <h3 className="settings-row-title">{policy.label}</h3>
                <p className="settings-row-description">{policy.details}</p>
              </div>
              <div className="settings-row-control">
                <span className="settings-meta-value settings-retention-value">
                  {policy.retention}
                </span>
              </div>
            </div>
          ))}

          {error ? (
            <div className="settings-row">
              <div className="settings-row-info">
                <h3 className="settings-row-title">
                  Retention policies unavailable
                </h3>
                <p className="settings-row-error">{error}</p>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function messageFromError(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
