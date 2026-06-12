// @ts-nocheck
import { exec } from "child_process";
import { existsSync } from "fs";
import { formatUsage, parseUsage, normalizeSdkOverageInfo } from "./usage-parser.mjs";
import { fetchOAuthUsage, normalizeOAuthUsage, defaultCredentialsPath, createOAuthUsageCache } from "./oauth-usage.mjs";

/**
 * Resolve a Claude Code executable that actually exists on this box.
 * The CLI has moved between /usr/bin and ~/.local/bin across installs.
 */
export function resolveClaudeExecutable(configured?: string): string {
  const home = process.env.HOME || "/root";
  const candidates = [
    configured,
    `${home}/.local/bin/claude`,
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {}
  }
  return configured || "claude";
}

async function importClaudeAgentSdk(): Promise<any | null> {
  const candidates = [
    "@anthropic-ai/claude-agent-sdk",
    "/root/.openclaw/npm/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
  ];

  for (const spec of candidates) {
    try {
      return await import(spec);
    } catch {}
  }
  return null;
}

async function fetchClaudeRateLimitInfo(timeoutMs = 30000, claudeExecutable?: string): Promise<any | null> {
  const sdk = await importClaudeAgentSdk();
  if (!sdk?.query) return null;

  const executable = resolveClaudeExecutable(claudeExecutable);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs).unref?.();

  try {
    for await (const msg of sdk.query({
      prompt: "Reply exactly OK.",
      options: {
        pathToClaudeCodeExecutable: executable,
        cwd: process.cwd(),
        model: "haiku",
        maxTurns: 1,
        tools: [],
        permissionMode: "dontAsk",
        persistSession: false,
        abortController: abort,
        env: {
          ...process.env,
          CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
        },
      },
    })) {
      if (msg?.type === "rate_limit_event" && msg.rate_limit_info) {
        return msg.rate_limit_info;
      }
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer as any);
  }

  return null;
}

function sh(cmd: string, timeoutMs = 20000): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, {
      encoding: "utf8",
      timeout: timeoutMs,
      shell: "/bin/bash",
    }, (err, stdout) => {
      if (err) reject(err);
      else resolve((stdout || "").trim());
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function q(s: string) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function looksLikeUsageOutput(raw: string): boolean {
  const t = String(raw || "");
  return /(Current\s+session|Current\s+5[ -]?hour|Current\s+week|Extra\s+usage|Usage\s+credits|Current\s+month|API\s+budget|Settings\s+Status\s+Config\s+Usage\s+Stats|Total\s+cost:|\b\d+%\s*used\b)/i.test(t);
}

function stripAnsi(text = "") {
  return String(text)
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");
}

function paneHasTrustPrompt(pane: string): boolean {
  return /trust this folder/i.test(pane) || /Yes, I trust/i.test(pane);
}

export function paneHasReplPrompt(pane: string): boolean {
  const clean = stripAnsi(pane);
  // Match primary prompt ❯ (U+276F) and fallback › (U+203A) used in some terminal configs.
  return clean.split("\n").some((line: string) => /^\s*[❯›](?:\s|\u00a0|$)/.test(line));
}

async function sessionExists(sessionName: string): Promise<boolean> {
  try {
    await sh(`tmux has-session -t ${q(sessionName)} 2>/dev/null`, 5000);
    return true;
  } catch {
    return false;
  }
}

async function capturePaneText(sessionName: string): Promise<string> {
  try {
    return await sh(`tmux capture-pane -t ${q(sessionName)} -p 2>/dev/null`, 5000);
  } catch {
    return "";
  }
}

async function killSession(sessionName: string): Promise<void> {
  try { await sh(`tmux kill-session -t ${q(sessionName)} 2>/dev/null`, 5000); } catch {}
}

/**
 * Ensure the tmux session exists and Claude is at its REPL prompt.
 * Handles: session creation, trust-dialog acceptance, boot wait.
 */
async function ensureSessionReady(
  sessionName: string,
  claudeCommand: string,
  maxWaitMs = 18000,
): Promise<{ ready: boolean; error?: string }> {
  if (!(await sessionExists(sessionName))) {
    try {
      await sh(`tmux new-session -d -s ${q(sessionName)} -x 120 -y 40 ${q(claudeCommand)}`, 10000);
    } catch (err: any) {
      return { ready: false, error: `tmux new-session failed: ${err?.message || err}` };
    }
  }

  // Dismiss any stale dialog left from a previous run.
  try { await sh(`tmux send-keys -t ${q(sessionName)} Escape 2>/dev/null`, 3000); } catch {}

  const start = Date.now();
  const maxTrustPrompts = 3;
  let trustPromptAccepts = 0;
  let lastPane = "";

  while (Date.now() - start < maxWaitMs) {
    lastPane = await capturePaneText(sessionName);

    if (paneHasTrustPrompt(lastPane)) {
      trustPromptAccepts += 1;
      if (trustPromptAccepts > maxTrustPrompts) {
        return {
          ready: false,
          error: `Claude trust prompt persisted after ${maxTrustPrompts} attempts`,
        };
      }
      try { await sh(`tmux send-keys -t ${q(sessionName)} Enter`, 3000); } catch {}
      await delay(3000);
      continue;
    }

    if (paneHasReplPrompt(lastPane)) return { ready: true };

    await delay(1200);
  }

  return {
    ready: false,
    error: `Claude REPL not ready after ${Math.round(maxWaitMs / 1000)}s`,
  };
}

/**
 * Reset the REPL input line: dismiss any open dialog, cancel pending input, clear line buffer.
 */
async function resetReplInput(sessionName: string): Promise<void> {
  const cmds = [
    `tmux send-keys -t ${q(sessionName)} Escape`,
    "sleep 0.3",
    `tmux send-keys -t ${q(sessionName)} C-c`,
    "sleep 0.3",
    `tmux send-keys -t ${q(sessionName)} C-u`,
    `tmux send-keys -t ${q(sessionName)} C-l`,
    "sleep 0.5",
  ].join("; ");
  try { await sh(cmds, 8000); } catch {}
}

async function fetchUsageRaw(sessionName: string, timeoutMs: number, claudeCommand: string): Promise<string> {
  let lastReadyError = "";
  // Cap per-attempt wait to leave room for the /usage send+capture steps afterward.
  const maxWaitMs = Math.max(3000, Math.floor(timeoutMs * 0.9));

  for (let attempt = 0; attempt < 2; attempt++) {
    const ready = await ensureSessionReady(sessionName, claudeCommand, maxWaitMs);
    if (!ready.ready) {
      lastReadyError = ready.error || "Claude REPL was not ready";
      if (attempt === 0) { await killSession(sessionName); continue; }
      throw new Error(lastReadyError);
    }

    const steps = [
      // Most reliable: type slash command, press Enter, then confirm once more.
      [
        `tmux send-keys -t ${q(sessionName)} '/usage'`,
        "sleep 0.6",
        `tmux send-keys -t ${q(sessionName)} Enter`,
        "sleep 0.8",
        `tmux send-keys -t ${q(sessionName)} Enter`,
        "sleep 2.5",
        `tmux capture-pane -t ${q(sessionName)} -p | tail -260`,
      ].join("; "),
      // Fallback: direct submit.
      [
        `tmux send-keys -t ${q(sessionName)} '/usage' Enter`,
        "sleep 1.0",
        `tmux send-keys -t ${q(sessionName)} Enter`,
        "sleep 2.5",
        `tmux capture-pane -t ${q(sessionName)} -p | tail -260`,
      ].join("; "),
    ];

    let last = "";
    for (const step of steps) {
      await resetReplInput(sessionName);
      try {
        const raw = await sh(step, timeoutMs);
        last = raw;
        if (looksLikeUsageOutput(raw)) return raw;
      } catch (err: any) {
        last = err?.message || String(err);
      }
    }

    if (attempt === 0) {
      await killSession(sessionName);
    } else if (last) {
      return last;
    }
  }

  throw new Error(lastReadyError || "Unable to capture Claude usage output from tmux");
}

export default function register(api: any) {
  const cfg = api.getConfig?.() || {};
  const tmuxSession = cfg.tmuxSession || "claude_usage_cmd";
  const timeoutMs = typeof cfg.timeoutMs === "number" ? cfg.timeoutMs : 120000;
  const claudeCommand = cfg.claudeCommand || "claude";
  // A persistent scrape session means a Claude Code instance polling the
  // usage endpoint in the background forever — which starves the OAuth
  // primary path of its tight per-account quota. Default to ephemeral.
  const keepTmuxSession = cfg.keepTmuxSession === true;
  const oauthEnabled = cfg.oauth !== false;
  const oauthTimeoutMs = typeof cfg.oauthTimeoutMs === "number" ? cfg.oauthTimeoutMs : 10000;
  const oauthCacheTtlMs = typeof cfg.oauthCacheTtlMs === "number" ? cfg.oauthCacheTtlMs : 120000;
  const oauthStaleTtlMs = typeof cfg.oauthStaleTtlMs === "number" ? cfg.oauthStaleTtlMs : 1800000;
  const credentialsPath = cfg.credentialsPath || defaultCredentialsPath();
  const oauthCache = createOAuthUsageCache();
  const sdkProbeEnabled = cfg.sdkProbe === true;
  const sdkProbeTimeoutMs = typeof cfg.sdkProbeTimeoutMs === "number" ? cfg.sdkProbeTimeoutMs : 30000;
  const sdkProbeClaudeExecutable = cfg.sdkProbeClaudeExecutable;

  const handler = async (ctx: any) => {
    const args = String(ctx?.args || "");
    const wantRaw = /(?:^|\s)(raw|--raw)(?:\s|$)/i.test(args);
    const wantJson = /(?:^|\s)(json|--json)(?:\s|$)/i.test(args);
    const wantSdkProbe = sdkProbeEnabled || /(?:^|\s)(sdk|--sdk|probe|--probe|overage|--overage)(?:\s|$)/i.test(args);
    const forceTmux = /(?:^|\s)(tmux|--tmux|cli|--cli|scrape|--scrape)(?:\s|$)/i.test(args);
    const forceOauth = /(?:^|\s)(oauth|--oauth|api|--api)(?:\s|$)/i.test(args);

    let oauthFailReason: string | null = null;

    // ── Primary: Anthropic OAuth usage endpoint (claude-cli account) ────────
    if (oauthEnabled && !forceTmux) {
      try {
        const wantFresh = /(?:^|\s)(fresh|--fresh)(?:\s|$)/i.test(args);
        let payload: any = null;
        let subscriptionType: string | null = null;
        let cacheNote: string | null = null;

        if (!wantFresh) {
          const hit = oauthCache.get(oauthCacheTtlMs);
          if (hit) {
            payload = hit.data;
            subscriptionType = hit.subscriptionType;
            cacheNote = `cached ${Math.round(hit.ageMs / 1000)}s ago`;
          }
        }

        if (!payload) {
          let res = await fetchOAuthUsage({ credentialsPath, timeoutMs: oauthTimeoutMs });

          if (!res.ok && res.reason === "auth") {
            // Token stale — boot the Claude CLI once so it refreshes the
            // credentials file, then retry the endpoint.
            const ready = await ensureSessionReady(tmuxSession, claudeCommand, Math.min(60000, timeoutMs));
            if (ready.ready) {
              res = await fetchOAuthUsage({ credentialsPath, timeoutMs: oauthTimeoutMs });
            }
          }

          if (res.ok) {
            payload = res.data;
            subscriptionType = res.subscriptionType || null;
            oauthCache.put(res.data, subscriptionType);
          } else {
            oauthFailReason = res.reason || "unknown";
            // Endpoint down or rate-limited — tolerate a stale cache before
            // falling back to the slow tmux scrape.
            const stale = oauthCache.get(oauthStaleTtlMs);
            if (stale) {
              payload = stale.data;
              subscriptionType = stale.subscriptionType;
              cacheNote = `cached ${Math.round(stale.ageMs / 1000)}s ago (endpoint: ${oauthFailReason})`;
            }
          }
        }

        if (payload) {
          const parsed = normalizeOAuthUsage(payload, new Date(), { subscriptionType });
          if (parsed) {
            if (wantSdkProbe) {
              const info = await fetchClaudeRateLimitInfo(Math.min(sdkProbeTimeoutMs, timeoutMs), sdkProbeClaudeExecutable);
              parsed.sdkOverage = normalizeSdkOverageInfo(info || null, new Date());
            }
            const note = cacheNote ? `\n⚙︎ ${cacheNote}` : "";
            if (wantRaw) return { text: JSON.stringify(payload, null, 2).slice(0, 3500) };
            if (wantJson) return { text: JSON.stringify(parsed, null, 2) };
            return { text: formatUsage(parsed) + note };
          }
          oauthFailReason = "empty-payload";
        }
      } catch (err: any) {
        oauthFailReason = err?.message || String(err);
      }
    }

    if (forceOauth) {
      return {
        text: `Anthrometer failed.\nOAuth usage endpoint unavailable (${oauthFailReason || "disabled"}).\nHint: run 'claude' once and login to refresh credentials, or try /anthrometer tmux.`,
      };
    }

    // ── Fallback: scrape the Claude CLI /usage screen via tmux ──────────────
    try {
      const raw = await fetchUsageRaw(tmuxSession, timeoutMs, claudeCommand);
      const rateLimitInfo = wantSdkProbe && looksLikeUsageOutput(raw)
        ? await fetchClaudeRateLimitInfo(Math.min(sdkProbeTimeoutMs, timeoutMs), sdkProbeClaudeExecutable)
        : null;
      const parsed = parseUsage(raw, new Date(), { sdkOverage: rateLimitInfo });

      if (wantRaw) {
        if (!keepTmuxSession) await killSession(tmuxSession);
        return { text: parsed.clean.slice(-3500) };
      }

      if (wantJson) {
        if (!keepTmuxSession) await killSession(tmuxSession);
        // Omit raw clean text to keep machine output lean.
        const { clean: _clean, ...rest } = parsed;
        return { text: JSON.stringify(rest, null, 2) };
      }

      if (!keepTmuxSession) await killSession(tmuxSession);

      const note = oauthFailReason
        ? `\n\n⚠️ OAuth usage API unavailable (${oauthFailReason}) — read from /usage screen instead.`
        : "";
      return { text: formatUsage(parsed) + note };
    } catch (err: any) {
      if (!keepTmuxSession) await killSession(tmuxSession);
      const oauthNote = oauthFailReason ? `\nOAuth usage API also failed: ${oauthFailReason}` : "";
      return {
        text: `Anthrometer failed.\n${err?.message || String(err)}${oauthNote}\nHint: run 'claude' once and login, then retry /anthrometer.`,
      };
    }
  };

  api.registerCommand({
    name: "anthrometer",
    description: "Show Claude usage meters (no LLM inference)",
    acceptsArgs: true,
    requireAuth: true,
    handler,
  });

  api.logger?.info?.("[anthrometer] Loaded: /anthrometer");
}
