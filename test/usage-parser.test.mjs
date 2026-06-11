import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUsage, formatUsage, stripAnsi, parseResetTime, formatDuration } from '../src/usage-parser.mjs';

const fixedNow = new Date('2026-04-05T05:20:00Z');

const subscriptionSample = `
Status Config Usage
Current session
                                                     0% used
Resets 9:59am (UTC)

Current week (all models)
██████████████████████████████████                   68% used
Resets Apr 10, 3pm (UTC)

Extra usage
████████████████████████████████████████████████████ 100% used
$5.75 / $5.00 spent · Resets May 1 (UTC)
`;

const apiSample = `
Status Config Usage
API usage
Current month
██████████████                                       40% used
Resets May 1 (UTC)
$12.40 / $50.00 spent
`;

test('stripAnsi removes escapes', () => {
  const s = '\u001b[31mRed\u001b[0m';
  assert.equal(stripAnsi(s), 'Red');
});

test('parseResetTime parses time-only UTC reset as next occurrence', () => {
  const dt = parseResetTime('9:59am (UTC)', fixedNow);
  assert.ok(dt instanceof Date);
  assert.equal(dt.toISOString(), '2026-04-05T09:59:00.000Z');
});

test('formatDuration formats countdown', () => {
  assert.equal(formatDuration(65 * 60 * 1000), '1h 5m');
  assert.equal(formatDuration(0), 'now');
});

test('parseUsage reads subscription 5h/week + extra usage availability', () => {
  const p = parseUsage(subscriptionSample, fixedNow);

  assert.equal(p.mode, 'subscription');
  assert.equal(p.fiveHour.pctUsed, 0);
  assert.equal(p.fiveHour.pctRemaining, 100);
  assert.equal(p.fiveHour.resetText, '9:59am (UTC)');

  assert.equal(p.week.pctUsed, 68);
  assert.equal(p.week.pctRemaining, 32);
  assert.equal(p.week.resetText, 'Apr 10, 3pm (UTC)');

  assert.equal(p.extra.status, 'enabled');
  assert.equal(p.extra.pctUsed, 100);
  assert.equal(p.extra.pctRemaining, 0);
  assert.equal(p.extra.spentUsd, 5.75);
  assert.equal(p.extra.limitUsd, 5.0);
  assert.equal(p.extra.availableUsd, 0);
  assert.equal(p.extra.overUsd, 0.75);

  // Ensure we did not misclassify this as API budget.
  assert.equal(p.api, null);
});

test('parseUsage reads API month usage when present', () => {
  const p = parseUsage(apiSample, fixedNow);

  assert.equal(p.api.pctUsed, 40);
  assert.equal(p.api.pctRemaining, 60);
  assert.equal(p.api.spentUsd, 12.4);
  assert.equal(p.api.limitUsd, 50);
  assert.equal(p.api.remainingUsd, 37.6);
});

// Phase 1 regression: 5h section with no local Resets line must not borrow the week reset.
const no5hResetSample = `
Status Config Usage
Current session
                                                     0% used

Current week (all models)
██████████████████████████████████                   68% used
Resets Apr 10, 3pm (UTC)
`;

test('parser boundary: 5h section without Resets does not borrow week reset', () => {
  const p = parseUsage(no5hResetSample, fixedNow);

  assert.equal(p.fiveHour.pctUsed, 0);
  assert.equal(p.fiveHour.resetText, null, '5h should have no resetText when its section lacks a Resets line');
  assert.equal(p.fiveHour.resetAtIso, null);

  assert.equal(p.week.pctUsed, 68);
  assert.equal(p.week.resetText, 'Apr 10, 3pm (UTC)', 'week reset should be unaffected');
});

test('formatUsage emits clear remaining usage lines', () => {
  const out = formatUsage(parseUsage(subscriptionSample, fixedNow));
  assert.match(out, /📊[\s\S]*subscription/);
  assert.match(out, /📅/);
  assert.match(out, /⚡ 5h:[\s\S]*0% used · 100% left/);
  assert.match(out, /📆 Week:[\s\S]*68% used · 32% left/);
  assert.match(out, /💸[\s\S]*Spend: \$5\.75 \/ \$5\.00 spent/);
  assert.match(out, /over cap by \$0\.75/);
  assert.match(out, /↺ resets/i);
});

test('formatUsage does not report healthy usage when output is unparsable', () => {
  const out = formatUsage(parseUsage('', fixedNow));
  assert.match(out, /unable to parse usage output/i);
  assert.doesNotMatch(out, /Healthy usage headroom/i);
});

const sdkRateLimitEventSample = `
{"type":"rate_limit_event","rateLimitType":"overage","utilization":0.73,"resetsAt":"2026-04-05T07:20:00.000Z","overageStatus":"enabled","overageDisabledReason":null,"isUsingOverage":true,"overageResetsAt":"2026-04-06T05:20:00.000Z"}
`;

test('parseUsage reads Claude SDK overage rate_limit_event fields', () => {
  const p = parseUsage(sdkRateLimitEventSample, fixedNow);

  assert.equal(p.rateLimitEvents.length, 1);
  assert.equal(p.overage.rateLimitType, 'overage');
  assert.equal(p.overage.overageStatus, 'enabled');
  assert.equal(p.overage.overageDisabledReason, null);
  assert.equal(p.overage.isUsingOverage, true);
  assert.equal(p.overage.utilization, 0.73);
  assert.equal(p.overage.pctUsed, 73);
  assert.equal(p.overage.resetsAt, '2026-04-05T07:20:00.000Z');
  assert.equal(p.overage.resetsAtIso, '2026-04-05T07:20:00.000Z');
  assert.equal(p.overage.resetsIn, '2h 0m');
  assert.equal(p.overage.overageResetsAt, '2026-04-06T05:20:00.000Z');
  assert.equal(p.overage.overageResetsAtIso, '2026-04-06T05:20:00.000Z');
  assert.equal(p.overage.overageResetsIn, '1d 0h 0m');
});

test('formatUsage emits Claude SDK overage state', () => {
  const out = formatUsage(parseUsage(sdkRateLimitEventSample, fixedNow));

  assert.match(out, /🧩[\s\S]*𝗦𝗗𝗞/);
  assert.match(out, /Overage[\s\S]*enabled/);
  assert.match(out, /Utilization:[\s\S]*73%/);
  assert.match(out, /Using overage: yes/);
  assert.match(out, /limit resets 2026-04-05T07:20:00\.000Z · in 2h 0m/);
  assert.match(out, /overage resets 2026-04-06T05:20:00\.000Z · in 1d 0h 0m/);
  assert.match(out, /Claude is using overage capacity/);
});

test('parseUsage keeps SDK overage disabled reason when present', () => {
  const raw = '{"type":"rate_limit_event","rateLimitType":"overage","utilization":100,"resetsAt":"2026-04-05T07:20:00.000Z","overageStatus":"disabled","overageDisabledReason":"billing_not_configured","isUsingOverage":false}';
  const p = parseUsage(raw, fixedNow);

  assert.equal(p.overage.overageStatus, 'disabled');
  assert.equal(p.overage.overageDisabledReason, 'billing_not_configured');
  assert.equal(p.overage.isUsingOverage, false);
  assert.equal(p.overage.pctUsed, 100);
  assert.match(formatUsage(p), /Disabled reason: billing_not_configured/);
});
