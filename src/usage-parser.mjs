export function stripAnsi(text = "") {
  return String(text)
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");
}

export function parseUsage(raw = "") {
  const clean = stripAnsi(raw);

  const sessionPct = clean.match(/Current session[\s\S]*?(\d+)% used/i)?.[1] ?? null;
  const sessionReset = clean.match(/Current session[\s\S]*?Resets\s+([^\n]+)/i)?.[1]?.trim() ?? null;

  const weekPct = clean.match(/Current week(?:\s*\(all models\))?[\s\S]*?(\d+)% used/i)?.[1] ?? null;
  const weekReset = clean.match(/Current week(?:\s*\(all models\))?[\s\S]*?Resets\s+([^\n]+)/i)?.[1]?.trim() ?? null;

  const extra = /Extra usage[\s\S]*?not enabled/i.test(clean)
    ? "not enabled"
    : /Extra usage[\s\S]*?enabled/i.test(clean)
      ? "enabled"
      : "unknown";

  return { sessionPct, sessionReset, weekPct, weekReset, extra, clean };
}

export function formatUsage(parsed) {
  if (!parsed?.sessionPct && !parsed?.weekPct) {
    return "Anthrometer: unable to parse usage output. Try /anthropic_usage raw.";
  }
  const lines = ["📊 Anthropic Usage"]; 
  if (parsed.sessionPct) {
    lines.push(`• Current session: ${parsed.sessionPct}% used${parsed.sessionReset ? ` (resets ${parsed.sessionReset})` : ""}`);
  }
  if (parsed.weekPct) {
    lines.push(`• Current week: ${parsed.weekPct}% used${parsed.weekReset ? ` (resets ${parsed.weekReset})` : ""}`);
  }
  lines.push(`• Extra usage: ${parsed.extra ?? "unknown"}`);
  return lines.join("\n");
}
