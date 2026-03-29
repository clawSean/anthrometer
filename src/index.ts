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

function fetchUsageRaw(sessionName: string, timeoutMs: number, claudeCommand: string): string {
  const cmd = [
    `tmux has-session -t ${q(sessionName)} 2>/dev/null || tmux new-session -d -s ${q(sessionName)} -x 120 -y 40 ${q(claudeCommand)}`, 
    `sleep 1`,
    `tmux send-keys -t ${q(sessionName)} C-c`,
    `tmux send-keys -t ${q(sessionName)} C-l`,
    `tmux send-keys -t ${q(sessionName)} '/usage' Enter`,
    `sleep 2`,
    `tmux capture-pane -t ${q(sessionName)} -p | tail -200`,
  ].join(" && ");

  return sh(`bash -lc ${q(cmd)}`, timeoutMs);
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
        text: `Anthrometer failed.\n${err?.message || String(err)}\nHint: run 'claude' once and login, then retry /anthropic_usage.`,
      };
    }
  };

  api.registerCommand({
    name: "anthropic_usage",
    description: "Show Claude usage meters (no LLM inference)",
    acceptsArgs: true,
    requireAuth: true,
    handler,
  });

  api.registerCommand({
    name: "claude_usage",
    description: "Alias for /anthropic_usage",
    acceptsArgs: true,
    requireAuth: true,
    handler,
  });

  api.logger?.info?.("[anthrometer] Loaded: /anthropic_usage and /claude_usage");
}
