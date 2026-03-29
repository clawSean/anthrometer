import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUsage, formatUsage, stripAnsi } from '../src/usage-parser.mjs';

const sample = `
Status Config Usage
Current session
████ 59% used
Resets 10am (UTC)
Current week (all models)
████ 85% used
Resets 3pm (UTC)
Extra usage
Extra usage not enabled • /extra-usage to enable
`;

test('stripAnsi removes escapes', () => {
  const s = '\u001b[31mRed\u001b[0m';
  assert.equal(stripAnsi(s), 'Red');
});

test('parseUsage reads percentages and resets', () => {
  const p = parseUsage(sample);
  assert.equal(p.sessionPct, '59');
  assert.equal(p.sessionReset, '10am (UTC)');
  assert.equal(p.weekPct, '85');
  assert.equal(p.weekReset, '3pm (UTC)');
  assert.equal(p.extra, 'not enabled');
});

test('formatUsage emits readable output', () => {
  const out = formatUsage(parseUsage(sample));
  assert.match(out, /Current session: 59% used/);
  assert.match(out, /Current week: 85% used/);
});
