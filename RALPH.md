# RALPH

## Goal
- Fix Anthrometer so it reliably displays a good Claude usage reading instead of timing out at REPL readiness.

## Done Means
- [ ] Anthrometer returns a readable usage report in a direct run.
- [ ] Regression test covers the readiness/prompt case.
- [ ] `npm test` and `npm run build` pass.

## Constraints
- Keep it small.
- No restarts.
- Do not expand scope without asking.

## Checks
- `npm test`
- `npm run build`
- direct handler smoke run

## Current Slice
- Reproduce the display path, then adjust the readiness/timeout logic only if it is actually the blocker.

## Status
- Iteration: 0/3
- State: active
- Blocker: none
