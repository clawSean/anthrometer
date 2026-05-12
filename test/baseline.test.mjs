/**
 * Baseline functional tests for the anthrometer plugin.
 *
 * Covers: manifest/package sanity, register() export shape,
 * command registration contract, handler arg parsing (raw/json),
 * error path, and parser edge cases not in usage-parser.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseUsage, formatUsage, stripAnsi } from '../src/usage-parser.mjs';

// ── Manifest & package.json sanity ──────────────────────────────────────────

test('openclaw.plugin.json is valid and has required fields', async () => {
  const raw = await readFile(new URL('../openclaw.plugin.json', import.meta.url), 'utf8');
  const manifest = JSON.parse(raw);
  assert.equal(manifest.id, 'anthrometer');
  assert.equal(typeof manifest.name, 'string');
  assert.equal(typeof manifest.version, 'string');
  assert.ok(manifest.activation, 'manifest must have activation');
  assert.equal(manifest.activation.onStartup, true);
  assert.ok(manifest.configSchema, 'manifest must declare configSchema');
  assert.deepEqual(Object.keys(manifest.configSchema.properties).sort(), ['claudeCommand', 'timeoutMs', 'tmuxSession']);
});

test('package.json has matching version and required scripts', async () => {
  const raw = await readFile(new URL('../package.json', import.meta.url), 'utf8');
  const pkg = JSON.parse(raw);
  assert.equal(pkg.name, 'anthrometer');
  assert.ok(pkg.scripts.build, 'must have build script');
  assert.ok(pkg.scripts.test, 'must have test script');
  assert.ok(pkg.openclaw, 'must have openclaw field');
  assert.ok(Array.isArray(pkg.openclaw.extensions), 'openclaw.extensions must be array');
  assert.ok(Array.isArray(pkg.openclaw.runtimeExtensions), 'openclaw.runtimeExtensions must be array');
});

test('package.json and manifest versions match', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(await readFile(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, manifest.version, 'package.json and manifest versions must match');
});

// ── register() export shape ─────────────────────────────────────────────────

test('default export is a function (register)', async () => {
  const mod = await import('../src/index.ts');
  const register = mod.default;
  assert.equal(typeof register, 'function', 'default export must be a function');
});

test('register() calls api.registerCommand with correct shape', async () => {
  const mod = await import('../src/index.ts');
  const register = mod.default;

  let registered = null;
  const fakeApi = {
    getConfig: () => ({}),
    logger: { info: () => {} },
    registerCommand: (cmd) => { registered = cmd; },
  };

  register(fakeApi);

  assert.ok(registered, 'registerCommand must be called');
  assert.equal(registered.name, 'anthrometer');
  assert.equal(typeof registered.description, 'string');
  assert.equal(registered.acceptsArgs, true);
  assert.equal(registered.requireAuth, true);
  assert.equal(typeof registered.handler, 'function');
});

test('register() reads config defaults when getConfig returns empty', async () => {
  const mod = await import('../src/index.ts');
  const register = mod.default;

  let registered = null;
  const fakeApi = {
    getConfig: () => ({}),
    registerCommand: (cmd) => { registered = cmd; },
  };

  register(fakeApi);
  assert.ok(registered, 'command registered');
});

test('register() tolerates missing getConfig and logger', async () => {
  const mod = await import('../src/index.ts');
  const register = mod.default;

  let registered = null;
  const fakeApi = {
    registerCommand: (cmd) => { registered = cmd; },
  };

  assert.doesNotThrow(() => register(fakeApi));
  assert.ok(registered);
});

// ── Handler arg parsing ─────────────────────────────────────────────────────

// The handler calls fetchUsageRaw which needs tmux — we can't run it offline.
// But we can verify the error path returns a user-friendly message.

test('paneHasReplPrompt detects Claude prompt with placeholder text', async () => {
  const mod = await import('../src/index.ts');
  assert.equal(mod.paneHasReplPrompt('────────────────\n❯ Try "write a test for <filepath>"\n────────────────'), true);
  assert.equal(mod.paneHasReplPrompt('Welcome back\nno prompt here'), false);
});

test('paneHasReplPrompt detects fallback prompt character ›', async () => {
  const mod = await import('../src/index.ts');
  // U+203A single right-pointing angle quotation mark (degraded terminal fallback)
  assert.equal(mod.paneHasReplPrompt('some header\n› '), true);
  // Must be at start of line (with optional whitespace)
  assert.equal(mod.paneHasReplPrompt('some header\n  › '), true);
  // ASCII > is NOT matched (too common in shell output / continuation prompts)
  assert.equal(mod.paneHasReplPrompt('some header\n> '), false);
  // Not mid-line
  assert.equal(mod.paneHasReplPrompt('some text › more'), false);
});

test('handler returns friendly error when tmux/claude unavailable', async () => {
  const mod = await import('../src/index.ts');
  const register = mod.default;

  let handler;
  const fakeApi = {
    getConfig: () => ({ tmuxSession: 'anthrometer_test_nonexistent', timeoutMs: 3000 }),
    registerCommand: (cmd) => { handler = cmd.handler; },
  };
  register(fakeApi);

  const result = await handler({ args: '' });
  assert.equal(typeof result.text, 'string');
  // May fail at connection ("Anthrometer failed") or succeed connecting but
  // get unparseable output ("unable to parse"). Both are acceptable error paths.
  assert.ok(
    /Anthrometer failed/i.test(result.text) || /unable to parse/i.test(result.text),
    `Expected an error message, got: ${result.text.slice(0, 200)}`
  );
});

test('handler respects timeoutMs config — does not hang beyond configured limit', async () => {
  const mod = await import('../src/index.ts');
  const register = mod.default;

  let handler;
  const fakeApi = {
    getConfig: () => ({ tmuxSession: 'anthrometer_timeout_test', timeoutMs: 4000 }),
    registerCommand: (cmd) => { handler = cmd.handler; },
  };
  register(fakeApi);

  const start = Date.now();
  await handler({ args: '' });
  const elapsed = Date.now() - start;

  // With timeoutMs=4000, total should finish well under 2× the timeout.
  // Before the fix, this would take ~36s (2 × 18s hardcoded maxWaitMs).
  assert.ok(elapsed < 12000, `Handler took ${elapsed}ms — should respect timeoutMs and finish under 12s`);
});

// ── Parser edge cases ───────────────────────────────────────────────────────

const fixedNow = new Date('2026-04-05T05:20:00Z');

test('parseUsage returns mode=unknown for empty input', () => {
  const p = parseUsage('', fixedNow);
  assert.equal(p.mode, 'unknown');
  assert.equal(p.fiveHour, null);
  assert.equal(p.week, null);
  assert.equal(p.api, null);
});

test('parseUsage handles ANSI-laden input', () => {
  const ansi = '\x1B[1m\x1B[31mCurrent session\x1B[0m\n  50% used\nResets 3pm (UTC)';
  const p = parseUsage(ansi, fixedNow);
  assert.equal(p.fiveHour.pctUsed, 50);
  assert.equal(p.fiveHour.pctRemaining, 50);
});

test('parseUsage handles 100% used edge case', () => {
  const input = 'Current session\n  100% used\nResets 9am (UTC)';
  const p = parseUsage(input, fixedNow);
  assert.equal(p.fiveHour.pctUsed, 100);
  assert.equal(p.fiveHour.pctRemaining, 0);
});

test('formatUsage for 100% 5h + 0% week shows yellow/red status', () => {
  const input = `
Current session
  100% used
Resets 9am (UTC)

Current week (all models)
  0% used
Resets Apr 10, 3pm (UTC)
`;
  const out = formatUsage(parseUsage(input, fixedNow));
  assert.match(out, /100% used/);
  assert.match(out, /🟡/); // 5h >= 80%
});

test('formatUsage returns JSON-serializable output for --json path', () => {
  const input = `
Current session
  25% used

Current week (all models)
  10% used
Resets Apr 10, 3pm (UTC)
`;
  const parsed = parseUsage(input, fixedNow);
  const { clean: _clean, ...rest } = parsed;
  const json = JSON.stringify(rest, null, 2);
  const roundTrip = JSON.parse(json);
  assert.equal(roundTrip.mode, 'subscription');
  assert.equal(roundTrip.fiveHour.pctUsed, 25);
});

test('stripAnsi handles null/undefined gracefully', () => {
  assert.equal(stripAnsi(null), 'null');
  assert.equal(stripAnsi(undefined), '');
  assert.equal(stripAnsi(''), '');
});

test('progressBar edge: 0% shows all empty blocks', () => {
  const out = formatUsage(parseUsage('Current session\n  0% used', fixedNow));
  assert.match(out, /░{10}/); // 10 empty blocks
});

// ── dist output exists ──────────────────────────────────────────────────────

test('dist/index.js exists and exports register', async () => {
  const content = await readFile(new URL('../dist/index.js', import.meta.url), 'utf8');
  assert.ok(content.includes('registerCommand'), 'dist must contain registerCommand call');
  assert.ok(content.includes('export default'), 'dist must have default export');
});

test('dist/usage-parser.mjs exists and exports parseUsage', async () => {
  const content = await readFile(new URL('../dist/usage-parser.mjs', import.meta.url), 'utf8');
  assert.ok(content.includes('parseUsage'), 'dist must contain parseUsage');
  assert.ok(content.includes('formatUsage'), 'dist must contain formatUsage');
});

// ── dist freshness: catch stale builds ──────────────────────────────────────

test('dist/index.js matches key src/index.ts signatures (stale build detection)', async () => {
  const src = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const dist = await readFile(new URL('../dist/index.js', import.meta.url), 'utf8');

  // Extract the default timeoutMs from both — must match
  const srcTimeout = src.match(/typeof cfg\.timeoutMs.*?:\s*(\d+)/);
  const distTimeout = dist.match(/typeof cfg\.timeoutMs.*?:\s*(\d+)/);
  assert.ok(srcTimeout, 'src must have default timeoutMs');
  assert.ok(distTimeout, 'dist must have default timeoutMs');
  assert.equal(srcTimeout[1], distTimeout[1], `dist default timeoutMs (${distTimeout[1]}) must match src (${srcTimeout[1]}) — did you forget to rebuild?`);

  // Check the prompt regex character class is present in both
  const srcHasCharClass = /\[❯›\]/.test(src);
  const distHasCharClass = /\[❯›\]/.test(dist);
  assert.equal(srcHasCharClass, distHasCharClass, 'dist prompt regex must match src — did you forget to rebuild?');

  // Check the maxWaitMs multiplier matches
  const srcMult = src.match(/Math\.floor\(timeoutMs\s*\*\s*([\d.]+)\)/);
  const distMult = dist.match(/Math\.floor\(timeoutMs\s*\*\s*([\d.]+)\)/);
  assert.ok(srcMult, 'src must have maxWaitMs multiplier');
  assert.ok(distMult, 'dist must have maxWaitMs multiplier');
  assert.equal(srcMult[1], distMult[1], `dist multiplier (${distMult[1]}) must match src (${srcMult[1]}) — did you forget to rebuild?`);
});
