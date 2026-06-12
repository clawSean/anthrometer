# anthrometer 🦞

No-LLM Anthropic usage meter plugin for OpenClaw. Reads the Claude subscription
quota for the account the `claude` CLI is signed into (the claude-cli provider).

## Commands
- `/anthrometer` — formatted meters
- `/anthrometer json` — machine-readable output
- `/anthrometer raw` — raw source payload/screen for diagnostics
- `/anthrometer fresh` — bypass the cache
- `/anthrometer tmux` — force the /usage screen scrape path
- `/anthrometer oauth` — force the OAuth endpoint path (no fallback)
- `/anthrometer sdk` — also probe Agent SDK overage state

## How it reads usage (v0.2.0)

**Primary — OAuth usage endpoint.** Calls
`https://api.anthropic.com/api/oauth/usage` with the Claude CLI's own OAuth
token from `~/.claude/.credentials.json`. One JSON call returns the 5-hour
window, 7-day window, Sonnet/Opus weekly sub-windows, and the `extra_usage`
block (enabled state, monthly limit, used credits, utilization, currency,
disabled reason). Responses are cached in-memory (default 2 min fresh TTL,
30 min stale tolerance) because the endpoint rate-limits aggressively —
especially while an interactive Claude Code session is polling it for its
statusline.

**Fallback — /usage screen scrape.** Drives `claude` in an ephemeral tmux
session, runs `/usage`, and parses the screen (Claude Code 2.1.175 layout:
`Current session`, `Current week (all models)`, `Current week (Sonnet only)`,
`Usage credits`). The session is killed after capture so it does not linger
and starve the OAuth quota. Used when the endpoint is rate-limited with no
cache, or when OAuth credentials are missing/stale (booting the CLI also
refreshes the token, after which the endpoint is retried).

**Optional — Agent SDK probe.** A tiny Haiku query that captures the
`rate_limit_event` for live overage status. Costs one micro-inference, so it
is opt-in (`sdkProbe: true` or the `sdk` arg).

### Reported fields
- **5-hour window**: used %, remaining %, reset time, countdown
- **Weekly window**: used %, remaining %, reset time, countdown (+ Sonnet/Opus sub-windows when present)
- **Extra usage / usage credits**: enabled state, used vs monthly limit, remaining, disabled reason
- **Agent SDK overage state** (optional): status, utilization, overage flag, reset times

## Config

```jsonc
{
  "plugins": {
    "entries": {
      "anthrometer": {
        "enabled": true,
        "config": {
          "tmuxSession": "claude_usage_cmd",
          "timeoutMs": 120000,          // tmux scrape budget (cold CLI boot can take ~20s)
          "claudeCommand": "claude",
          "oauth": true,
          "oauthTimeoutMs": 10000,
          "oauthCacheTtlMs": 120000,
          "oauthStaleTtlMs": 1800000,
          "credentialsPath": "~/.claude/.credentials.json (default)",
          "keepTmuxSession": false,     // true = leave the scrape CLI session running
          "sdkProbe": false,
          "sdkProbeTimeoutMs": 30000,
          "sdkProbeClaudeExecutable": "(auto-resolved)"
        }
      }
    }
  }
}
```

## Install (local extension)
Place this folder under `~/.openclaw/extensions/anthrometer`, allow
`"anthrometer"` in `plugins.allow`, build with `npm install && npm run build`
(the runtime loads `./dist/index.js`), and restart the gateway.

## Tests

```bash
node --test test/*.test.mjs
```

Covers: OAuth credential reading/fetching/normalization and cache TTLs, the
Claude Code 2.1.175 `/usage` screen layout, legacy screen layouts, formatter
output, command registration contract, timeout behavior, and stale-dist
detection.
