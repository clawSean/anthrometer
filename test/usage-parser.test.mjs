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

test('formatUsage emits clear remaining usage lines', () => {
  const out = formatUsage(parseUsage(subscriptionSample, fixedNow));
  assert.match(out, /\*?📊 Anthrometer\*? — .*subscription/);
  assert.match(out, /\*?📅 Subscription\*?/);
  assert.match(out, /⚡ 5h:[\s\S]*0% used · 100% left/);
  assert.match(out, /📆 Week:[\s\S]*68% used · 32% left/);
  assert.match(out, /\*?💸 Extra Usage\*?[\s\S]*Spend: \$5\.75 \/ \$5\.00 spent/);
  assert.match(out, /over cap by \$0\.75/);
  assert.match(out, /↺ resets/i);
});
