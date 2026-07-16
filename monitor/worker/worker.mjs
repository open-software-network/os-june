import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const definitions = JSON.parse(await readFile(new URL("../checks.json", import.meta.url), "utf8"));

export function failureIds(snapshot) {
  return snapshot.checks
    .filter((check) => check.state === "unhealthy")
    .map((check) => check.id)
    .sort();
}

export function sameFailures(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function zonedDateAndHour(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { date: `${value.year}-${value.month}-${value.day}`, hour: Number(value.hour) };
}

export function shouldSendDigest(now, timeZone, dailyHour, lastDigestDate) {
  const current = zonedDateAndHour(now, timeZone);
  return current.hour >= dailyHour && current.date !== lastDigestDate;
}

export function buildStateChangeMessage(previousFailures, currentFailures, snapshot, dashboardUrl) {
  const recovered = currentFailures.length === 0;
  const started = previousFailures.length === 0;
  const title = recovered
    ? ":large_green_circle: *OS health recovered*"
    : started
      ? ":red_circle: *OS health incident detected*"
      : ":large_orange_circle: *OS health incident updated*";
  const summary = recovered
    ? `All ${snapshot.checks.length} production checks are healthy.`
    : `${currentFailures.length} of ${snapshot.checks.length} production checks failed after a retry.`;
  const details = recovered
    ? ""
    : `\n\n*Failing checks*\n${snapshot.checks
        .filter((check) => check.state === "unhealthy")
        .map((check) => `• *${check.label}* - ${check.detail}${check.statusCode ? ` (HTTP ${check.statusCode})` : ""}`)
        .join("\n")}`;
  const marker = currentFailures.length === 0 ? "healthy" : currentFailures.join(",");
  return `${title}\n${summary}${details}\n\n<${dashboardUrl}|Open health dashboard>\n\n[os-health-state] ${marker}`;
}

export function buildDigestMessage(snapshot, dashboardUrl) {
  const failures = failureIds(snapshot);
  const healthy = snapshot.checks.length - failures.length;
  const icon = failures.length === 0 ? ":large_green_circle:" : ":large_orange_circle:";
  const details = failures.length === 0
    ? "All monitored production surfaces are healthy."
    : snapshot.checks
        .filter((check) => check.state === "unhealthy")
        .map((check) => `• *${check.label}* - ${check.detail}${check.statusCode ? ` (HTTP ${check.statusCode})` : ""}`)
        .join("\n");
  return `${icon} *Daily OS health summary*\n${healthy}/${snapshot.checks.length} checks healthy.\n\n${details}\n\n<${dashboardUrl}|Open health dashboard>\n\n[os-health-digest]`;
}

export async function collectSnapshot({ env = process.env, fetchImpl = fetch } = {}) {
  const timeoutMs = clampInteger(env.HEALTH_PROBE_TIMEOUT_MS, 5_000, 500, 15_000);
  const checks = await Promise.all(
    definitions.map((definition) => probe(definition, env, fetchImpl, timeoutMs)),
  );
  return {
    checkedAt: new Date().toISOString(),
    checks,
  };
}

async function probe(definition, env, fetchImpl, timeoutMs) {
  const origin = normalizeOrigin(env[definition.envVar] || definition.defaultOrigin);
  const startedAt = performance.now();
  try {
    const response = await fetchImpl(`${origin}${definition.path}`, {
      method: definition.method || "GET",
      headers: {
        accept: definition.parseHealth || definition.expectedErrorCode ? "application/json" : "text/plain",
        ...(definition.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: definition.body === undefined ? undefined : JSON.stringify(definition.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));

    if (definition.expectedStatusCode !== undefined) {
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      const healthy = response.status === definition.expectedStatusCode
        && (definition.expectedErrorCode === undefined || body?.error_code === definition.expectedErrorCode);
      return makeCheck(
        definition,
        healthy,
        latencyMs,
        response.status,
        healthy ? definition.healthyDetail : "Unexpected API contract response",
      );
    }

    if (definition.parseHealth && response.ok) {
      const body = await response.json();
      const healthy = body?.success === true && body?.data?.status === "healthy";
      return makeCheck(
        definition,
        healthy,
        latencyMs,
        response.status,
        healthy ? definition.healthyDetail : "Invalid health response",
      );
    }

    return makeCheck(
      definition,
      response.ok,
      latencyMs,
      response.status,
      response.ok ? definition.healthyDetail : `HTTP ${response.status}`,
    );
  } catch (error) {
    const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
    const detail = error instanceof Error && error.name === "TimeoutError" ? "Probe timed out" : "Unreachable";
    return makeCheck(definition, false, latencyMs, null, detail);
  }
}

function makeCheck(definition, healthy, latencyMs, statusCode, detail) {
  return {
    id: definition.id,
    label: definition.label,
    state: healthy ? "healthy" : "unhealthy",
    latencyMs,
    statusCode,
    detail,
  };
}

async function postSlack(webhookUrl, text) {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.text();
  if (!response.ok || body.trim() !== "ok") {
    throw new Error(`Slack webhook failed with HTTP ${response.status}`);
  }
}

async function runCycle(state, config) {
  let snapshot = await collectSnapshot();
  let currentFailures = failureIds(snapshot);
  if (currentFailures.length > 0) {
    await delay(config.retryDelayMs);
    snapshot = await collectSnapshot();
    currentFailures = failureIds(snapshot);
  }

  const previousFailures = state.failureIds ?? [];
  if (state.failureIds === null ? currentFailures.length > 0 : !sameFailures(previousFailures, currentFailures)) {
    await postSlack(
      config.webhookUrl,
      buildStateChangeMessage(previousFailures, currentFailures, snapshot, config.dashboardUrl),
    );
  }

  const now = new Date();
  let lastDigestDate = state.lastDigestDate;
  if (shouldSendDigest(now, config.timeZone, config.dailyHour, lastDigestDate)) {
    await postSlack(config.webhookUrl, buildDigestMessage(snapshot, config.dashboardUrl));
    lastDigestDate = zonedDateAndHour(now, config.timeZone).date;
  }

  return { failureIds: currentFailures, lastDigestDate };
}

async function loadState(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return {
      failureIds: Array.isArray(parsed.failureIds) ? parsed.failureIds.filter((id) => typeof id === "string").sort() : null,
      lastDigestDate: typeof parsed.lastDigestDate === "string" ? parsed.lastDigestDate : null,
    };
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn("Could not read monitor state; starting with a clean state");
    return { failureIds: null, lastDigestDate: null };
  }
}

async function saveState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeOrigin(value) {
  const url = new URL(value);
  if (url.pathname !== "/" || url.search || url.hash) throw new Error(`Expected an origin without a path: ${value}`);
  return url.origin;
}

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

async function main() {
  const webhookUrl = process.env.SLACK_HEALTH_WEBHOOK_URL?.trim();
  if (!webhookUrl) throw new Error("SLACK_HEALTH_WEBHOOK_URL is required");

  const config = {
    webhookUrl,
    dashboardUrl: normalizeOrigin(process.env.HEALTH_DASHBOARD_URL || "https://health.opensoftware.co"),
    intervalMs: clampInteger(process.env.HEALTH_MONITOR_INTERVAL_MS, 300_000, 60_000, 3_600_000),
    retryDelayMs: clampInteger(process.env.HEALTH_MONITOR_RETRY_DELAY_MS, 15_000, 1_000, 60_000),
    statePath: process.env.HEALTH_MONITOR_STATE_PATH || "/data/os-health-state.json",
    timeZone: process.env.HEALTH_MONITOR_TIME_ZONE || "America/New_York",
    dailyHour: clampInteger(process.env.HEALTH_MONITOR_DAILY_HOUR, 9, 0, 23),
  };

  let state = await loadState(config.statePath);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      state = await runCycle(state, config);
      await saveState(config.statePath, state);
      console.log(JSON.stringify({ event: "health_cycle_complete", failures: state.failureIds, checkedAt: new Date().toISOString() }));
    } catch (error) {
      console.error(JSON.stringify({ event: "health_cycle_failed", message: error instanceof Error ? error.message : "Unknown error" }));
    } finally {
      running = false;
    }
  };

  await tick();
  const interval = setInterval(() => void tick(), config.intervalMs);
  const stop = () => {
    clearInterval(interval);
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Monitor worker failed to start");
    process.exit(1);
  });
}
