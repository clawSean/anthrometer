# anthrometer 🦞

No-LLM Anthropic usage meter plugin for OpenClaw.

## Commands
- `/anthrometer`
- add `raw` argument for diagnostics: `/anthrometer raw`
- add `json` argument for structured parsed output: `/anthrometer json`

## Behavior
Anthrometer drives `claude` CLI in a tmux session, runs `/usage`, parses meter output, and returns factual usage lines without invoking LLM inference.

It now supports both **subscription** and **API-style** usage layouts when present in Claude usage output. The runner is resilient to Claude boot delays, stale input, and first-run trust prompts, and it retries once with a fresh tmux session if the REPL is not ready.

### Reported fields
- **5-hour window**: used %, remaining %, reset time, and countdown (`in Xh Ym`)
- **Weekly window**: used %, remaining %, reset time, and countdown
- **Extra usage**: enabled/exhausted state, spent vs cap, available amount, overage amount, reset time/countdown
- **API budget** (when available): month usage %, dollars spent/cap, dollars remaining, reset countdown

## Install (local extension)
Place this folder under:

`~/.openclaw/extensions/anthrometer`

This plugin is packaged with `openclaw.extensions = ["./src/index.ts"]` and also provides a root `index.ts` shim for compatibility across loader modes.

Enable in `openclaw.json`:

- `plugins.allow` includes `"anthrometer"`
- `plugins.entries["anthrometer"].enabled = true`
- optional: `plugins.entries["anthrometer"].config.claudeCommand` (default `"claude"`)

Restart gateway.

## Requirements
- `claude` CLI installed and logged in on host
- `tmux`
- Node 20+

## Test
```bash
npm test
```
