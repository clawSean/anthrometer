# Anthrometer — Baseline Plugin Audit

**Date:** 2026-05-09
**Plugin ID:** `anthrometer`
**Version:** 0.1.0

## Existing Baseline

- **8 parser tests** in `test/usage-parser.test.mjs` covering: stripAnsi, parseResetTime, formatDuration, subscription parsing, API parsing, section-boundary regression, formatUsage output, and unparsable-input guard.
- TypeScript builds cleanly (`tsc --noEmit` — zero errors).
- `dist/` output present and up to date with source.

## New Baseline Tests Added

**File:** `test/baseline.test.mjs` — 17 tests added:

| # | Test | Status |
|---|------|--------|
| 1 | `openclaw.plugin.json` required fields & config schema | PASS |
| 2 | `package.json` required fields & openclaw entry points | PASS |
| 3 | package.json ↔ manifest version match | PASS |
| 4 | default export is a function (register) | PASS |
| 5 | register() calls api.registerCommand with correct shape | PASS |
| 6 | register() reads config defaults from empty getConfig | PASS |
| 7 | register() tolerates missing getConfig and logger | PASS |
| 8 | handler returns friendly error when tmux unavailable | PASS |
| 9 | parseUsage returns mode=unknown for empty input | PASS |
| 10 | parseUsage handles ANSI-laden input | PASS |
| 11 | parseUsage handles 100% used edge case | PASS |
| 12 | formatUsage shows yellow status at 100% 5h usage | PASS |
| 13 | formatUsage JSON path is serializable/round-trippable | PASS |
| 14 | stripAnsi handles null/undefined | PASS |
| 15 | progressBar 0% shows all empty blocks | PASS |
| 16 | dist/index.js exists and contains registerCommand | PASS |
| 17 | dist/usage-parser.mjs exists and contains exports | PASS |

## Commands Run

```bash
node --test test/usage-parser.test.mjs          # 8/8 pass
node --test test/baseline.test.mjs              # 17/17 pass
node --test test/usage-parser.test.mjs test/baseline.test.mjs  # 25/25 pass
npx tsc --noEmit                                # 0 errors
```

## Button/Menu UX Changes

**N/A** — This plugin is a pure slash command (`/anthrometer`). It does not register any Telegram inline keyboards, buttons, callback queries, or menus. No button/UX fixes apply.

## Remaining Gaps

1. **Live integration test**: The handler's happy path (actual tmux + Claude REPL) cannot be tested offline. A CI fixture that mocks `sh()` at the module level would enable full handler coverage without tmux.
2. **`--raw` / `--json` arg branches**: Currently only tested via the error path. Stubbing `fetchUsageRaw` would allow verifying the raw/json output formatting.
3. **Config validation**: The manifest declares `configSchema` but the register function does no runtime validation (e.g. negative `timeoutMs`). Low risk but could be hardened.
4. **dist freshness CI gate**: `dist/` is gitignored. A CI step like `tsc && git diff --exit-code dist/` would catch stale builds if dist were tracked, or the prepare script suffices if consumers always `npm install`.
5. **No SDK type stubs**: `api: any` in register() — no compile-time contract with the OpenClaw SDK. Adding an `openclaw.d.ts` or SDK dep would catch API drift.
