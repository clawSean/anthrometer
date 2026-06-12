import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  OAUTH_USAGE_URL,
  readClaudeOAuthCredentials,
  fetchOAuthUsage,
  normalizeOAuthUsage,
} from "../src/oauth-usage.mjs";

const NOW = new Date("2026-06-12T16:00:00Z");

// Shape captured live from api.anthropic.com/api/oauth/usage on 2026-06-12
// with Claude CLI 2.1.175 credentials (Max subscription, extra usage off).
const LIVE_DISABLED_FIXTURE = {
  five_hour: { utilization: 23.0, resets_at: "2026-06-12T20:50:00.405741+00:00" },
  seven_day: { utilization: 12.0, resets_at: "2026-06-19T07:00:00.405760+00:00" },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 4.0, resets_at: null },
  extra_usage: {
    is_enabled: false,
    monthly_limit: null,
    used_credits: null,
    utilization: null,
    currency: null,
    disabled_reason: null,
  },
};

const ENABLED_FIXTURE = {
  five_hour: { utilization: 88.0, resets_at: "2026-06-12T20:50:00+00:00" },
  seven_day: { utilization: 97.0, resets_at: "2026-06-19T07:00:00+00:00" },
  seven_day_opus: { utilization: 41.0, resets_at: null },
  seven_day_sonnet: null,
  extra_usage: {
    is_enabled: true,
    monthly_limit: 50,
    used_credits: 12.5,
    utilization: 25.0,
    currency: "USD",
    disabled_reason: null,
  },
};

function fakeCredsFile(extra = {}) {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: "sk-ant-oat-test-token",
      expiresAt: Date.now() + 3600_000,
      subscriptionType: "max",
      ...extra,
    },
  });
}

test("readClaudeOAuthCredentials reads token metadata from claudeAiOauth wrapper", async () => {
  const dir = await mkdtemp(join(tmpdir(), "anthro-"));
  const path = join(dir, ".credentials.json");
  await writeFile(path, fakeCredsFile());

  const creds = await readClaudeOAuthCredentials(path);
  assert.equal(creds.ok, true);
  assert.equal(creds.accessToken, "sk-ant-oat-test-token");
  assert.equal(creds.subscriptionType, "max");
  assert.equal(creds.expired, false);

  await rm(dir, { recursive: true, force: true });
});

test("readClaudeOAuthCredentials fails soft on missing/garbage files", async () => {
  const missing = await readClaudeOAuthCredentials("/nonexistent/creds.json");
  assert.deepEqual(missing, { ok: false, reason: "credentials-missing" });

  const dir = await mkdtemp(join(tmpdir(), "anthro-"));
  const path = join(dir, ".credentials.json");
  await writeFile(path, "not json{{{");
  const garbage = await readClaudeOAuthCredentials(path);
  assert.deepEqual(garbage, { ok: false, reason: "credentials-unreadable" });

  await writeFile(path, JSON.stringify({ claudeAiOauth: {} }));
  const tokenless = await readClaudeOAuthCredentials(path);
  assert.deepEqual(tokenless, { ok: false, reason: "no-access-token" });

  await rm(dir, { recursive: true, force: true });
});

test("fetchOAuthUsage sends OAuth headers and parses 200 JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "anthro-"));
  const path = join(dir, ".credentials.json");
  await writeFile(path, fakeCredsFile());

  let seenUrl = null;
  let seenHeaders = null;
  const fetchFn = async (url, init) => {
    seenUrl = url;
    seenHeaders = init.headers;
    return { ok: true, status: 200, json: async () => LIVE_DISABLED_FIXTURE };
  };

  const res = await fetchOAuthUsage({ credentialsPath: path, fetchFn });
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.equal(res.subscriptionType, "max");
  assert.equal(res.data.five_hour.utilization, 23.0);
  assert.equal(seenUrl, OAUTH_USAGE_URL);
  assert.equal(seenHeaders.Authorization, "Bearer sk-ant-oat-test-token");
  assert.equal(seenHeaders["anthropic-beta"], "oauth-2025-04-20");

  await rm(dir, { recursive: true, force: true });
});

test("fetchOAuthUsage reports auth failures distinctly for token-refresh retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "anthro-"));
  const path = join(dir, ".credentials.json");
  await writeFile(path, fakeCredsFile({ expiresAt: Date.now() - 1000 }));

  const fetchFn = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const res = await fetchOAuthUsage({ credentialsPath: path, fetchFn });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "auth");
  assert.equal(res.tokenExpired, true);

  await rm(dir, { recursive: true, force: true });
});

test("fetchOAuthUsage fails soft on network error and non-200", async () => {
  const dir = await mkdtemp(join(tmpdir(), "anthro-"));
  const path = join(dir, ".credentials.json");
  await writeFile(path, fakeCredsFile());

  const boom = await fetchOAuthUsage({
    credentialsPath: path,
    fetchFn: async () => { throw new Error("ECONNRESET"); },
  });
  assert.equal(boom.ok, false);
  assert.match(boom.reason, /network: ECONNRESET/);

  const overloaded = await fetchOAuthUsage({
    credentialsPath: path,
    fetchFn: async () => ({ ok: false, status: 429, json: async () => ({}) }),
  });
  assert.equal(overloaded.ok, false);
  assert.equal(overloaded.reason, "http-429");

  await rm(dir, { recursive: true, force: true });
});

test("normalizeOAuthUsage maps live disabled-extra payload to parser shape", () => {
  const n = normalizeOAuthUsage(LIVE_DISABLED_FIXTURE, NOW, { subscriptionType: "max" });
  assert.equal(n.source, "oauth-usage-endpoint");
  assert.equal(n.mode, "subscription");
  assert.equal(n.subscriptionType, "max");

  assert.equal(n.fiveHour.pctUsed, 23);
  assert.equal(n.fiveHour.pctRemaining, 77);
  assert.equal(n.fiveHour.resetAtIso, "2026-06-12T20:50:00.405Z");
  assert.equal(n.fiveHour.resetIn, "4h 50m");

  assert.equal(n.week.pctUsed, 12);
  assert.equal(n.week.resetIn, "6d 15h 0m");

  assert.equal(n.weekSonnet.pctUsed, 4);
  assert.equal(n.weekSonnet.resetAtIso, null);
  assert.equal(n.weekOpus, null);

  assert.equal(n.extra.status, "not enabled");
  assert.equal(n.extra.isEnabled, false);
  assert.equal(n.extra.usedCredits, null);
});

test("normalizeOAuthUsage maps enabled extra usage with credits math", () => {
  const n = normalizeOAuthUsage(ENABLED_FIXTURE, NOW);
  assert.equal(n.extra.status, "enabled");
  assert.equal(n.extra.usedCredits, 12.5);
  assert.equal(n.extra.monthlyLimit, 50);
  assert.equal(n.extra.remainingCredits, 37.5);
  assert.equal(n.extra.pctUsed, 25);
  assert.equal(n.extra.pctRemaining, 75);
  assert.equal(n.extra.currency, "USD");
  assert.equal(n.weekOpus.pctUsed, 41);
});

test("normalizeOAuthUsage flags exhausted extra usage", () => {
  const exhausted = normalizeOAuthUsage({
    ...ENABLED_FIXTURE,
    extra_usage: { is_enabled: true, monthly_limit: 50, used_credits: 50, utilization: 100, currency: "USD", disabled_reason: null },
  }, NOW);
  assert.equal(exhausted.extra.status, "exhausted");
  assert.equal(exhausted.extra.remainingCredits, 0);
});

test("normalizeOAuthUsage returns null on empty/garbage payloads", () => {
  assert.equal(normalizeOAuthUsage(null, NOW), null);
  assert.equal(normalizeOAuthUsage("nope", NOW), null);
  assert.equal(normalizeOAuthUsage({}, NOW), null);
});

test("createOAuthUsageCache serves fresh hits and expires by TTL", async () => {
  const { createOAuthUsageCache } = await import("../src/oauth-usage.mjs");
  const cache = createOAuthUsageCache();

  assert.equal(cache.get(120_000, 1_000_000), null);

  cache.put({ five_hour: { utilization: 5 } }, "max", 1_000_000);

  const fresh = cache.get(120_000, 1_060_000);
  assert.equal(fresh.ageMs, 60_000);
  assert.equal(fresh.subscriptionType, "max");
  assert.equal(fresh.data.five_hour.utilization, 5);

  // Past fresh TTL but within stale tolerance.
  assert.equal(cache.get(120_000, 1_500_000), null);
  assert.ok(cache.get(1_800_000, 1_500_000));

  cache.clear();
  assert.equal(cache.get(1_800_000, 1_000_001), null);
});
