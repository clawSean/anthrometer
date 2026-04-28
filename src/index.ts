// @ts-nocheck
import { exec } from "child_process";
import { formatUsage, parseUsage } from "./usage-parser.mjs";

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

function q(s: string) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function looksLikeUsageOutput(raw: string): boolean {
  const t = String(raw || "");
  return /(Current\s+session|Current\s+5[ -]?hour|Current\s+week|Extra\s+usage|Current\s+month|API\s+budget|\b\d+%\s*used\b)/i.test(t);
}

function stripAnsi(text = "") {
  return String(text)
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");
}

function paneHasTrustPrompt(pane: string): boolean {
  return /trust this folder/i.test(pane) || /Yes, I trust/i.test(pane);
}

function paneHasReplPrompt(pane: string): boolean {
  const clean = stripAnsi(pane);
  return clean.split("\n").some((line: string) => /^\s*❯\s*$/.test(line));
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
      try { await sh("sleep 3", 5000); } catch {}
      continue;
    }

    if (paneHasReplPrompt(lastPane)) return { ready: true };

    try { await sh("sleep 1.5", 3000); } catch {}
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

  for (let attempt = 0; attempt < 2; attempt++) {
    const ready = await ensureSessionReady(sessionName, claudeCommand);
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
  const timeoutMs = typeof cfg.timeoutMs === "number" ? cfg.timeoutMs : 20000;
  const claudeCommand = cfg.claudeCommand || "claude";

  const handler = async (ctx: any) => {
    try {
      const args = String(ctx?.args || "");
      const wantRaw = /(?:^|\s)(raw|--raw)(?:\s|$)/i.test(args);
      const wantJson = /(?:^|\s)(json|--json)(?:\s|$)/i.test(args);

      const raw = await fetchUsageRaw(tmuxSession, timeoutMs, claudeCommand);
      const parsed = parseUsage(raw);

      if (wantRaw) return { text: parsed.clean.slice(-3500) };

      if (wantJson) {
        // Omit raw clean text to keep machine output lean.
        const { clean: _clean, ...rest } = parsed;
        return { text: JSON.stringify(rest, null, 2) };
      }

      return { text: formatUsage(parsed) };
    } catch (err: any) {
      return {
        text: `Anthrometer failed.\n${err?.message || String(err)}\nHint: run 'claude' once and login, then retry /anthrometer.`,
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
