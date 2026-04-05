// @ts-nocheck
import { execSync } from "child_process";
import { formatUsage, parseUsage } from "./usage-parser.mjs";

function sh(cmd: string, timeoutMs = 20000): string {
  return execSync(cmd, {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function q(s: string) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function looksLikeUsageOutput(raw: string): boolean {
  const t = String(raw || "");
  return /(Current\s+session|Current\s+5[ -]?hour|Current\s+week|Extra\s+usage|Current\s+month|API\s+budget|\b\d+%\s*used\b)/i.test(t);
}

function fetchUsageRaw(sessionName: string, timeoutMs: number, claudeCommand: string): string {
  const setup = [
    `tmux has-session -t ${q(sessionName)} 2>/dev/null || tmux new-session -d -s ${q(sessionName)} -x 120 -y 40 ${q(claudeCommand)}`,
    `sleep 1`,
    `tmux send-keys -t ${q(sessionName)} C-c`,
    `tmux send-keys -t ${q(sessionName)} C-l`,
  ].join("; ");

  const attempts = [
    // Most reliable for Claude Code UI: type slash command, then confirm twice.
    [
      `tmux send-keys -t ${q(sessionName)} '/usage'`,
      `sleep 0.6`,
      `tmux send-keys -t ${q(sessionName)} Enter`,
      `sleep 0.8`,
      `tmux send-keys -t ${q(sessionName)} Enter`,
      `sleep 2.5`,
      `tmux capture-pane -t ${q(sessionName)} -p | tail -260`,
    ].join("; "),

    // Fallback: direct submit then one extra Enter.
    [
      `tmux send-keys -t ${q(sessionName)} '/usage' Enter`,
      `sleep 1.0`,
      `tmux send-keys -t ${q(sessionName)} Enter`,
      `sleep 2.5`,
      `tmux capture-pane -t ${q(sessionName)} -p | tail -260`,
    ].join("; "),
  ];

  let last = "";
  for (const step of attempts) {
    try {
      const raw = sh(`bash -lc ${q(`${setup}; ${step}`)}`, timeoutMs);
      last = raw;
      if (looksLikeUsageOutput(raw)) return raw;
    } catch (err: any) {
      last = err?.message || String(err);
    }
  }

  return last;
}

export default function register(api: any) {
  const cfg = api.getConfig?.() || {};
  const tmuxSession = cfg.tmuxSession || "claude_usage_cmd";
  const timeoutMs = typeof cfg.timeoutMs === "number" ? cfg.timeoutMs : 20000;
  const claudeCommand = cfg.claudeCommand || "claude";

  const handler = async (ctx: any) => {
    try {
      const raw = fetchUsageRaw(tmuxSession, timeoutMs, claudeCommand);
      const parsed = parseUsage(raw);
      const wantRaw = /(?:^|\s)(raw|--raw)(?:\s|$)/i.test(String(ctx?.args || ""));
      if (wantRaw) return { text: parsed.clean.slice(-3500) };
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

  api.registerCommand({
    name: "anthropic_usage",
    description: "Alias for /anthrometer",
    acceptsArgs: true,
    requireAuth: true,
    handler,
  });

  api.registerCommand({
    name: "claude_usage",
    description: "Alias for /anthrometer",
    acceptsArgs: true,
    requireAuth: true,
    handler,
  });

  api.logger?.info?.("[anthrometer] Loaded: /anthrometer, /anthropic_usage, /claude_usage");
}
