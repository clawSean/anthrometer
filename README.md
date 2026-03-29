# anthrometer 🦞

No-LLM Anthropic usage meter plugin for OpenClaw.

## Commands
- `/anthropic_usage`
- `/claude_usage` (alias)
- add `raw` argument for diagnostics: `/anthropic_usage raw`

## Behavior
Anthrometer drives `claude` CLI in a tmux session, runs `/usage`, parses meter output, and returns factual usage lines without invoking LLM inference.

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
