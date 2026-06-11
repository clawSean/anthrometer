# RALPH LOG

## Iteration 1 — 2026-05-10 21:36 UTC [foreman]

### Slice
- Dispatched Foreman to diagnose readiness/display path.
- Result: blocked — no usable patch or summary returned.

## Iteration 2 — 2026-05-10 23:53 UTC [foreman]

### Slice
- Re-dispatched Foreman with tighter display-focused prompt.
- Result: blocked — same outcome.

## Iteration 3 — 2026-05-11 00:25 UTC (local)

### Slice
- Inspected the actual code path myself. Found 4 stacking issues:
  1. **dist was stale** — `npm run build` hadn't been run after source changes. OpenClaw loads `dist/index.js`, which still had the old prompt regex and old timeout multiplier.
  2. **Default timeout too tight for cold boot** — 20s × 0.8 = 16s max wait. Claude CLI cold boot takes 10-20s.
  3. **No tmux session existed** — previous test runs killed `claude_usage_cmd`, forcing cold starts every time.
  4. **Stale test sessions** cluttering tmux.

### Fix
- Bumped default `timeoutMs` from 20000 to 45000 (gives ~40s for cold boot).
- Rebuilt dist so it matches source (prompt regex fix, multiplier 0.9, fallback `›` char).
- Cleaned up stale tmux test sessions.

### Verification
- `npm test`: 28/28 pass
- `npm run build`: OK
- Cold-start smoke test (no pre-existing tmux session): good reading in 6.4s
- Evidence: `📊 Anthrometer · subscription ... 🟢 Healthy usage headroom right now.`

### Learnings
- Always rebuild dist after source changes — OpenClaw loads the compiled JS, not the TS source.
- The root cause was never a code logic bug per se; it was a stale build + too-tight default timeout for cold starts.

### Next
- DONE
