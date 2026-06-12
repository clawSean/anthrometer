import test from "node:test";
import assert from "node:assert/strict";
import { parseUsage, formatUsage } from "../src/usage-parser.mjs";

const NOW = new Date("2026-06-12T15:57:00Z");

// Verbatim layout captured live from Claude Code 2.1.175 /usage on 2026-06-12
// (percentages adjusted to non-zero so meters are asserted meaningfully).
const LIVE_SCREEN = `
  Settings  Status   Config   Usage   Stats

  Session
  Total cost:            $0.0000
  Total duration (API):  0s
  Total duration (wall): 41s
  Total code changes:    0 lines added, 0 lines removed
  Usage:                 0 input, 0 output, 0 cache read, 0 cache write

  Current session
  █████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 23% used
  Resets 8:50pm (UTC)

  Current week (all models)
  ████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 12% used
  Resets Jun 19, 7am (UTC)

  Current week (Sonnet only)
  ██░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 4% used

  What's contributing to your limits usage?
  Approximate, based on local sessions on this machine — does not include other devices or claude.ai
  Last 24h · these are independent characteristics of your usage, not a breakdown
  20% of your usage was at >150k context

  Usage credits
  Usage credits are off · /usage-credits to turn them on

  Esc to cancel
`;

test("parseUsage reads Claude Code 2.1.175 subscription meters", () => {
  const parsed = parseUsage(LIVE_SCREEN, NOW);

  assert.equal(parsed.mode, "subscription");
  assert.equal(parsed.fiveHour.pctUsed, 23);
  assert.equal(parsed.fiveHour.pctRemaining, 77);
  assert.equal(parsed.fiveHour.resetAtIso, "2026-06-12T20:50:00.000Z");

  assert.equal(parsed.week.pctUsed, 12);
  assert.equal(parsed.week.resetAtIso, "2026-06-19T07:00:00.000Z");

  assert.equal(parsed.weekSonnet.pctUsed, 4);
  assert.equal(parsed.weekOpus, null);
});

test("parseUsage maps 2.1.175 'Usage credits are off' to extra not enabled", () => {
  const parsed = parseUsage(LIVE_SCREEN, NOW);
  assert.equal(parsed.extra.status, "not enabled");
});

test("parseUsage maps 'Usage credits are on' to extra enabled with dollars", () => {
  const onScreen = LIVE_SCREEN.replace(
    "Usage credits are off · /usage-credits to turn them on",
    "Usage credits are on\n  $12.50 / $50.00 spent\n  Resets Jul 1, 12am (UTC)",
  );
  const parsed = parseUsage(onScreen, NOW);
  assert.equal(parsed.extra.status, "enabled");
  assert.equal(parsed.extra.spentUsd, 12.5);
  assert.equal(parsed.extra.limitUsd, 50);
  assert.equal(parsed.extra.availableUsd, 37.5);
});

test("week section does not bleed into Sonnet-only or local-stats sections", () => {
  const parsed = parseUsage(LIVE_SCREEN, NOW);
  // Sonnet window has no Resets line of its own and must not borrow one.
  assert.equal(parsed.weekSonnet.resetText, null);
  // Week keeps its own reset, not the Sonnet 4% or stats 20% noise.
  assert.equal(parsed.week.pctUsed, 12);
});

test("formatUsage renders 2.1.175 output with all three windows and credits state", () => {
  const parsed = parseUsage(LIVE_SCREEN, NOW);
  const out = formatUsage(parsed);
  assert.match(out, /5h.*23% used/s);
  assert.match(out, /Week.*12% used/s);
  assert.match(out, /Week \(Sonnet\).*4% used/s);
  assert.match(out, /Not enabled/);
  assert.match(out, /source: Claude CLI \/usage screen/);
});
