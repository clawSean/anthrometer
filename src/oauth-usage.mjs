// Primary Anthrometer data source: Anthropic OAuth usage endpoint.
// Uses the Claude CLI's own OAuth token (~/.claude/.credentials.json) — same
// account as the claude-cli provider. One JSON call, no TUI scraping.
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

export const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export function defaultCredentialsPath() {
  return join(homedir(), ".claude", ".credentials.json");
}

/**
 * Read the Claude CLI OAuth credentials file. The token must only ever be
 * passed to the usage endpoint — never into display/log paths.
 */
export async function readClaudeOAuthCredentials(credentialsPath = defaultCredentialsPath()) {
  let raw;
  try {
    raw = await readFile(credentialsPath, "utf8");
  } catch {
    return { ok: false, reason: "credentials-missing" };
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "credentials-unreadable" };
  }

  const oauth = json?.claudeAiOauth || json;
  const accessToken = typeof oauth?.accessToken === "string" ? oauth.accessToken : null;
  if (!accessToken) return { ok: false, reason: "no-access-token" };

  const expiresAt = typeof oauth?.expiresAt === "number" ? oauth.expiresAt : null;
  return {
    ok: true,
    accessToken,
    expiresAt,
    expired: expiresAt != null ? Date.now() >= expiresAt : false,
    subscriptionType: typeof oauth?.subscriptionType === "string" ? oauth.subscriptionType : null,
  };
}

/**
 * Call the OAuth usage endpoint. Returns { ok, status, data } or
 * { ok: false, status, reason }. Auth failures are reported distinctly so the
 * caller can refresh the token (by booting the Claude CLI) and retry.
 */
export async function fetchOAuthUsage({
  credentialsPath = defaultCredentialsPath(),
  timeoutMs = 10000,
  fetchFn = fetch,
} = {}) {
  const creds = await readClaudeOAuthCredentials(credentialsPath);
  if (!creds.ok) return { ok: false, status: null, reason: creds.reason };

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  timer.unref?.();

  try {
    const res = await fetchFn(OAUTH_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        "User-Agent": "anthrometer",
        Accept: "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: abort.signal,
    });

    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, reason: "auth", tokenExpired: creds.expired };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, reason: `http-${res.status}` };
    }

    let data;
    try {
      data = await res.json();
    } catch {
      return { ok: false, status: res.status, reason: "bad-json" };
    }
    return { ok: true, status: res.status, data, subscriptionType: creds.subscriptionType };
  } catch (err) {
    return { ok: false, status: null, reason: abort.signal.aborted ? "timeout" : `network: ${err?.message || err}` };
  } finally {
    clearTimeout(timer);
  }
}

function formatUtcIso(dt) {
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return "now";
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const mins = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  return parts.join(" ");
}

function normalizeWindow(win, now) {
  if (!win || typeof win !== "object") return null;
  const utilization = typeof win.utilization === "number" && Number.isFinite(win.utilization)
    ? win.utilization
    : null;
  if (utilization == null && !win.resets_at) return null;

  // Endpoint reports utilization on a 0–100 percent scale (matches the
  // /usage screen and OpenClaw's own provider-usage fetcher).
  const pctUsed = utilization != null ? Math.min(100, Math.max(0, Math.round(utilization))) : null;

  const resetAt = win.resets_at ? new Date(win.resets_at) : null;
  const validReset = resetAt && !Number.isNaN(resetAt.getTime()) ? resetAt : null;

  return {
    pctUsed,
    pctRemaining: pctUsed != null ? Math.max(0, 100 - pctUsed) : null,
    resetText: null,
    resetAtIso: formatUtcIso(validReset),
    resetIn: validReset ? formatDuration(validReset.getTime() - now.getTime()) : null,
  };
}

function normalizeExtraUsage(extra) {
  if (!extra || typeof extra !== "object") {
    return { status: "unknown", source: "oauth-usage-endpoint" };
  }

  const isEnabled = extra.is_enabled === true;
  const usedCredits = typeof extra.used_credits === "number" ? extra.used_credits : null;
  const monthlyLimit = typeof extra.monthly_limit === "number" ? extra.monthly_limit : null;
  const utilization = typeof extra.utilization === "number" ? extra.utilization : null;
  const pctUsed = utilization != null
    ? Math.min(100, Math.max(0, Math.round(utilization)))
    : (usedCredits != null && monthlyLimit > 0 ? Math.min(100, Math.round((usedCredits / monthlyLimit) * 100)) : null);

  let status = isEnabled ? "enabled" : "not enabled";
  if (isEnabled && monthlyLimit != null && usedCredits != null && usedCredits >= monthlyLimit) {
    status = "exhausted";
  }

  return {
    status,
    source: "oauth-usage-endpoint",
    isEnabled,
    usedCredits,
    monthlyLimit,
    remainingCredits: usedCredits != null && monthlyLimit != null ? Math.max(0, monthlyLimit - usedCredits) : null,
    pctUsed,
    pctRemaining: pctUsed != null ? Math.max(0, 100 - pctUsed) : null,
    currency: typeof extra.currency === "string" ? extra.currency : null,
    disabledReason: typeof extra.disabled_reason === "string" ? extra.disabled_reason : null,
  };
}

/**
 * Normalize the OAuth usage payload into the same window shape the tmux
 * parser produces, so the formatter can consume either source.
 */
export function normalizeOAuthUsage(data, now = new Date(), meta = {}) {
  if (!data || typeof data !== "object") return null;

  const fiveHour = normalizeWindow(data.five_hour, now);
  const week = normalizeWindow(data.seven_day, now);
  const weekSonnet = normalizeWindow(data.seven_day_sonnet, now);
  const weekOpus = normalizeWindow(data.seven_day_opus, now);
  const extra = normalizeExtraUsage(data.extra_usage);

  if (!fiveHour && !week && !weekSonnet && !weekOpus && extra.status === "unknown") return null;

  return {
    source: "oauth-usage-endpoint",
    mode: "subscription",
    subscriptionType: meta.subscriptionType || null,
    fiveHour,
    week,
    weekSonnet,
    weekOpus,
    extra,
  };
}

/**
 * In-memory cache for OAuth usage payloads. The endpoint rate-limits hard
 * (observed 429 with Retry-After ~195s), so the plugin must not hit it on
 * every invocation. Lives for the gateway process lifetime.
 */
export function createOAuthUsageCache() {
  let entry = null;
  return {
    put(data, subscriptionType, now = Date.now()) {
      entry = { data, subscriptionType, fetchedAt: now };
    },
    get(maxAgeMs, now = Date.now()) {
      if (!entry) return null;
      const ageMs = now - entry.fetchedAt;
      if (ageMs > maxAgeMs) return null;
      return { data: entry.data, subscriptionType: entry.subscriptionType, ageMs };
    },
    clear() { entry = null; },
  };
}
