"use client";

import {
  IconArrowRotateClockwise,
  IconArrowUpRight,
  IconCheckCircle2,
  IconCircleX,
  IconClock,
  IconDoor,
} from "central-icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Brand } from "@/components/brand";
import type { AccountUser } from "@/lib/auth/session";
import type { HealthCheck, HealthSnapshot, OverallState } from "@/lib/health";

const REFRESH_INTERVAL_MS = 30_000;
const MAX_HISTORY = 24;

export function MonitorDashboard({
  initialSnapshot,
  user,
}: {
  initialSnapshot: HealthSnapshot;
  user: AccountUser;
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [history, setHistory] = useState<HealthSnapshot[]>([initialSnapshot]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      if (response.status === 401) {
        window.location.assign("/auth/start");
        return;
      }
      if (response.status === 403) {
        window.location.reload();
        return;
      }
      if (!response.ok) throw new Error("The monitor could not refresh");
      const next = (await response.json()) as HealthSnapshot;
      setSnapshot(next);
      setHistory((current) => [...current, next].slice(-MAX_HISTORY));
      setError(null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "The monitor could not refresh");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const averageLatency = Math.round(
    snapshot.checks.reduce((total, check) => total + check.latencyMs, 0) / snapshot.checks.length,
  );
  const healthyCount = snapshot.checks.filter((check) => check.state === "healthy").length;

  return (
    <main className="monitor-shell">
      <header className="monitor-header">
        <Brand />
        <div className="header-actions">
          <span className="refresh-copy">Auto-refreshes every 30 seconds</span>
          <button className="icon-button" type="button" onClick={() => void refresh()} disabled={refreshing} aria-label="Refresh health checks">
            <IconArrowRotateClockwise className={refreshing ? "spinning" : undefined} size={18} ariaHidden />
          </button>
          <div className="user-menu">
            <span className="avatar" aria-hidden="true">{initials(user)}</span>
            <span className="user-handle">{user.handle}</span>
            <form action="/auth/logout" method="post">
              <button className="signout-button" type="submit" aria-label="Sign out">
                <IconDoor size={17} ariaHidden />
              </button>
            </form>
          </div>
        </div>
      </header>

      <div className="monitor-content">
        <section className="status-hero">
          <div>
            <p className="eyebrow">Service overview</p>
            <div className="hero-title-row">
              <StatusPulse status={snapshot.status} />
              <h1>{statusTitle(snapshot.status)}</h1>
            </div>
            <p className="hero-copy">
              {statusDescription(snapshot.status)} Last checked {formatUtc(snapshot.checkedAt)}.
            </p>
          </div>
          <div className="target-block">
            <span>Monitoring</span>
            <a href={snapshot.target} target="_blank" rel="noreferrer">
              {new URL(snapshot.target).host}
              <IconArrowUpRight size={15} ariaHidden />
            </a>
          </div>
        </section>

        {error ? <div className="inline-error">{error}. Showing the last successful check.</div> : null}

        <section className="metric-strip" aria-label="Current service metrics">
          <Metric label="Healthy checks" value={`${healthyCount}/${snapshot.checks.length}`} detail="Across production services and portals" />
          <Metric label="Average response" value={`${averageLatency} ms`} detail="Latest probe cycle" />
          <Metric label="Environment" value="Production" detail="Open Software" mono />
          <Metric label="Last check" value={formatUtc(snapshot.checkedAt, false)} detail="UTC" mono />
        </section>

        <div className="dashboard-grid">
          <section className="panel checks-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Live checks</p>
                <h2>Service components</h2>
              </div>
              <span className={`status-pill status-${snapshot.status}`}>{statusLabel(snapshot.status)}</span>
            </div>
            <div className="check-list">
              {snapshot.checks.map((check) => <CheckRow check={check} key={check.id} />)}
            </div>
          </section>

          <section className="panel latency-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Response time</p>
                <h2>Probe latency</h2>
              </div>
              <span className="latency-now">{averageLatency} ms</span>
            </div>
            <LatencyChart history={history} />
            <div className="chart-footer">
              <span><span className="legend-dot" />Average latency</span>
              <span>{history.length} of {MAX_HISTORY} checks</span>
            </div>
          </section>
        </div>

        <section className="activity-section">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Recent activity</p>
              <h2>Monitor timeline</h2>
            </div>
          </div>
          <div className="activity-list">
            {[...history].reverse().slice(0, 6).map((item, index) => (
              <div className="activity-row" key={`${item.checkedAt}-${index}`}>
                <StatusPulse status={item.status} small />
                <span className="activity-status">{statusLabel(item.status)}</span>
                <span className="activity-detail">{item.checks.filter((check) => check.state === "healthy").length} of {item.checks.length} checks healthy</span>
                <span className="activity-time"><IconClock size={15} ariaHidden />{formatUtc(item.checkedAt)}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

function Metric({ label, value, detail, mono = false }: { label: string; value: string; detail: string; mono?: boolean }) {
  return <div className="metric"><span>{label}</span><strong className={mono ? "mono" : undefined}>{value}</strong><small>{detail}</small></div>;
}

function CheckRow({ check }: { check: HealthCheck }) {
  const healthy = check.state === "healthy";
  return (
    <div className="check-row">
      <span className={`check-icon ${healthy ? "check-icon-healthy" : "check-icon-unhealthy"}`}>
        {healthy ? <IconCheckCircle2 size={19} ariaHidden /> : <IconCircleX size={19} ariaHidden />}
      </span>
      <div className="check-main"><strong>{check.label}</strong><span>{check.description}</span></div>
      <div className="check-detail"><strong>{check.detail}</strong><span>{check.latencyMs} ms{check.statusCode ? ` · HTTP ${check.statusCode}` : ""}</span></div>
    </div>
  );
}

function LatencyChart({ history }: { history: HealthSnapshot[] }) {
  const points = useMemo(() => {
    const values = history.map((item) => item.checks.reduce((sum, check) => sum + check.latencyMs, 0) / item.checks.length);
    const padded = values.length === 1 ? [values[0], values[0]] : values;
    const max = Math.max(...padded, 100);
    return padded.map((value, index) => `${(index / (padded.length - 1)) * 100},${88 - (value / max) * 68}`).join(" ");
  }, [history]);
  return (
    <div className="chart-wrap">
      <div className="chart-grid" aria-hidden="true"><span /><span /><span /></div>
      <svg className="latency-chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Average response time history">
        <defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="currentColor" stopOpacity="0.2" /><stop offset="100%" stopColor="currentColor" stopOpacity="0" /></linearGradient></defs>
        <polygon points={`0,100 ${points} 100,100`} fill="url(#chart-fill)" />
        <polyline points={points} fill="none" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

function StatusPulse({ status, small = false }: { status: OverallState; small?: boolean }) {
  return <span className={`status-pulse pulse-${status} ${small ? "status-pulse-small" : ""}`} aria-hidden="true"><span /></span>;
}

function statusTitle(status: OverallState): string {
  if (status === "operational") return "All systems operational";
  if (status === "degraded") return "Some systems degraded";
  return "Service interruption detected";
}

function statusDescription(status: OverallState): string {
  if (status === "operational") return "Open Software services are responding normally.";
  if (status === "degraded") return "Core services are available, but a supporting check needs attention.";
  return "A critical production check is failing. Investigation is required.";
}

function statusLabel(status: OverallState): string {
  if (status === "operational") return "Operational";
  if (status === "degraded") return "Degraded";
  return "Outage";
}

function formatUtc(value: string, includeZone = true): string {
  const formatted = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC" }).format(new Date(value));
  return includeZone ? `${formatted} UTC` : formatted;
}

function initials(user: AccountUser): string {
  const source = user.display_name?.trim() || user.handle;
  return source.slice(0, 2).toUpperCase();
}
