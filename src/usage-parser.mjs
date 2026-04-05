export function stripAnsi(text = "") {
  return String(text)
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");
}

function toNumber(value) {
  if (value == null) return null;
  const n = Number(String(value).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function utcDateParts(now = new Date()) {
  return {
    y: now.getUTCFullYear(),
    m: now.getUTCMonth(),
    d: now.getUTCDate(),
  };
}

function formatUtcIso(dt) {
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

export function parseResetTime(resetText, now = new Date()) {
  if (!resetText) return null;

  const raw = String(resetText).trim();
  const cleaned = raw.replace(/\(UTC\)/ig, "").replace(/\s+/g, " ").trim();

  // Case 1: "Apr 10, 3pm" / "May 1"
  const monthDayRe = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})(?:,\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm))?$/i;
  const md = cleaned.match(monthDayRe);
  if (md) {
    const monthNames = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };
    const month = monthNames[md[1].slice(0, 3).toLowerCase()];
    const day = Number(md[2]);

    let hour = 0;
    let minute = 0;
    if (md[3]) {
      hour = Number(md[3]);
      minute = Number(md[4] || "0");
      const ap = String(md[5] || "").toLowerCase();
      if (ap === "pm" && hour < 12) hour += 12;
      if (ap === "am" && hour === 12) hour = 0;
    }

    const nowParts = utcDateParts(now);
    let year = nowParts.y;
    let dt = new Date(Date.UTC(year, month, day, hour, minute, 0, 0));
    if (dt.getTime() <= now.getTime()) {
      dt = new Date(Date.UTC(year + 1, month, day, hour, minute, 0, 0));
    }
    return dt;
  }

  // Case 2: "9:59am" / "3pm"
  const timeOnlyRe = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i;
  const t = cleaned.match(timeOnlyRe);
  if (t) {
    let hour = Number(t[1]);
    const minute = Number(t[2] || "0");
    const ap = t[3].toLowerCase();
    if (ap === "pm" && hour < 12) hour += 12;
    if (ap === "am" && hour === 12) hour = 0;

    const { y, m, d } = utcDateParts(now);
    let dt = new Date(Date.UTC(y, m, d, hour, minute, 0, 0));
    if (dt.getTime() <= now.getTime()) {
      dt = new Date(Date.UTC(y, m, d + 1, hour, minute, 0, 0));
    }
    return dt;
  }

  // Fallback parser with UTC hint
  const tryParse = new Date(`${cleaned} UTC`);
  if (!Number.isNaN(tryParse.getTime())) return tryParse;

  return null;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return "now";

  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const mins = totalMinutes % 60;

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  return parts.join(" ");
}

function sectionSlice(lines, startIndex, maxLookahead = 12) {
  return lines.slice(startIndex, Math.min(lines.length, startIndex + maxLookahead));
}

function findHeadingIndex(lines, regex) {
  return lines.findIndex((line) => regex.test(line.trim()));
}

function parseWindowSection(lines, headingRegex, now = new Date()) {
  const idx = findHeadingIndex(lines, headingRegex);
  if (idx < 0) return null;

  const chunk = sectionSlice(lines, idx, 14).join("\n");
  const pct = chunk.match(/(\d+)\s*%\s*used/i)?.[1] ?? null;
  const resetText = chunk.match(/Resets\s+([^\n]+)/i)?.[1]?.trim() ?? null;
  const resetAt = parseResetTime(resetText, now);
  const resetInMs = resetAt ? resetAt.getTime() - now.getTime() : null;

  return {
    pctUsed: pct ? Number(pct) : null,
    pctRemaining: pct ? Math.max(0, 100 - Number(pct)) : null,
    resetText,
    resetAtIso: formatUtcIso(resetAt),
    resetIn: formatDuration(resetInMs),
  };
}

function parseExtraSection(lines, now = new Date()) {
  const idx = findHeadingIndex(lines, /^extra usage$/i);
  if (idx < 0) {
    return {
      status: /out of extra usage/i.test(lines.join("\n")) ? "exhausted" : "unknown",
      cleanText: null,
      pctUsed: null,
      pctRemaining: null,
      spentUsd: null,
      limitUsd: null,
      availableUsd: null,
      overUsd: null,
      resetText: null,
      resetAtIso: null,
      resetIn: null,
    };
  }

  const chunk = sectionSlice(lines, idx, 16).join("\n");
  const pct = chunk.match(/(\d+)\s*%\s*used/i)?.[1] ?? null;

  let status = "unknown";
  if (/not enabled/i.test(chunk)) status = "not enabled";
  else if (/enabled/i.test(chunk)) status = "enabled";

  const money = chunk.match(/\$\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*\$\s*([0-9]+(?:\.[0-9]+)?)\s*spent/i);
  const spentUsd = toNumber(money?.[1] ?? null);
  const limitUsd = toNumber(money?.[2] ?? null);
  const availableUsd = spentUsd != null && limitUsd != null ? Math.max(0, limitUsd - spentUsd) : null;
  const overUsd = spentUsd != null && limitUsd != null ? Math.max(0, spentUsd - limitUsd) : null;

  const resetText = chunk.match(/Resets\s+([^\n]+)/i)?.[1]?.trim() ?? null;
  const resetAt = parseResetTime(resetText, now);
  const resetInMs = resetAt ? resetAt.getTime() - now.getTime() : null;

  // Infer enabled if usage values are present but banner text omitted.
  if (status === "unknown" && (pct != null || (spentUsd != null && limitUsd != null))) {
    status = "enabled";
  }

  // If CLI explicitly says out-of-extra-usage, force status exhausted.
  if (/out of extra usage/i.test(chunk)) status = "exhausted";

  return {
    status,
    cleanText: chunk,
    pctUsed: pct ? Number(pct) : null,
    pctRemaining: pct ? Math.max(0, 100 - Number(pct)) : null,
    spentUsd,
    limitUsd,
    availableUsd,
    overUsd,
    resetText,
    resetAtIso: formatUtcIso(resetAt),
    resetIn: formatDuration(resetInMs),
  };
}

function parseApiBudget(clean, now = new Date()) {
  // Flexible parse for API-oriented meter lines, e.g. "Current month" + "$X / $Y spent"
  const lines = clean.split("\n").map((l) => l.trimEnd());
  const monthSection = parseWindowSection(lines, /^current month(?:\s*\(.*\))?$/i, now);

  // Guard: don't misclassify subscription extra-usage dollars as API budget.
  if (!monthSection && !/api\s+usage/i.test(clean)) return null;

  const moneyMatch = clean.match(/\$\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*\$\s*([0-9]+(?:\.[0-9]+)?)\s*spent/i);
  const spentUsd = toNumber(moneyMatch?.[1] ?? null);
  const limitUsd = toNumber(moneyMatch?.[2] ?? null);
  const remainingUsd = spentUsd != null && limitUsd != null ? Math.max(0, limitUsd - spentUsd) : null;

  if (!monthSection && spentUsd == null && limitUsd == null) return null;

  return {
    label: "API budget",
    pctUsed: monthSection?.pctUsed ?? null,
    pctRemaining: monthSection?.pctRemaining ?? null,
    resetText: monthSection?.resetText ?? null,
    resetAtIso: monthSection?.resetAtIso ?? null,
    resetIn: monthSection?.resetIn ?? null,
    spentUsd,
    limitUsd,
    remainingUsd,
  };
}

export function parseUsage(raw = "", now = new Date()) {
  const clean = stripAnsi(raw);
  const lines = clean.split("\n").map((l) => l.trimEnd());

  const fiveHour = parseWindowSection(lines, /^current session$/i, now)
    || parseWindowSection(lines, /^current 5[ -]?hour(?: window)?$/i, now)
    || parseWindowSection(lines, /^current 5h(?: window)?$/i, now);

  const week = parseWindowSection(lines, /^current week(?:\s*\(all models\))?$/i, now);
  const extra = parseExtraSection(lines, now);
  const api = parseApiBudget(clean, now);

  const profileLine = lines.find((l) => /Claude\s+(Pro|Max|Team|Enterprise|API)/i.test(l)) || null;
  const mode = /Claude\s+API/i.test(profileLine || "")
    ? "api"
    : (fiveHour || week || /Claude\s+(Pro|Max|Team|Enterprise)/i.test(profileLine || ""))
      ? "subscription"
      : api
        ? "api"
        : "unknown";

  return {
    mode,
    fiveHour,
    week,
    extra,
    api,
    profileLine,
    clean,
  };
}

function fmtPctLine(label, section) {
  if (!section || section.pctUsed == null) return null;
  let s = `• ${label}: ${section.pctUsed}% used`;
  if (section.pctRemaining != null) s += ` (${section.pctRemaining}% remaining)`;
  if (section.resetText) {
    s += `\n  ↳ reset: ${section.resetText}`;
    if (section.resetIn) s += ` (in ${section.resetIn})`;
  }
  return s;
}

export function formatUsage(parsed) {
  const lines = ["📊 Anthropic Usage"]; 

  if (parsed?.mode && parsed.mode !== "unknown") {
    lines.push(`• Mode: ${parsed.mode}`);
  }

  const fiveHourLine = fmtPctLine("5-hour window", parsed?.fiveHour);
  if (fiveHourLine) lines.push(fiveHourLine);

  const weekLine = fmtPctLine("Current week", parsed?.week);
  if (weekLine) lines.push(weekLine);

  if (parsed?.api) {
    const a = parsed.api;
    const apiParts = [];
    if (a.spentUsd != null && a.limitUsd != null) {
      apiParts.push(`$${a.spentUsd.toFixed(2)} / $${a.limitUsd.toFixed(2)} spent`);
      if (a.remainingUsd != null) apiParts.push(`$${a.remainingUsd.toFixed(2)} remaining`);
    }
    if (a.pctUsed != null) {
      apiParts.push(`${a.pctUsed}% used`);
      if (a.pctRemaining != null) apiParts.push(`${a.pctRemaining}% remaining`);
    }
    if (apiParts.length) {
      let s = `• API budget: ${apiParts.join(" · ")}`;
      if (a.resetText) {
        s += `\n  ↳ reset: ${a.resetText}`;
        if (a.resetIn) s += ` (in ${a.resetIn})`;
      }
      lines.push(s);
    }
  }

  const ex = parsed?.extra;
  if (ex) {
    if (ex.status === "not enabled") {
      lines.push("• Extra usage: not enabled");
    } else if (ex.status === "enabled" || ex.status === "exhausted" || ex.pctUsed != null || (ex.spentUsd != null && ex.limitUsd != null)) {
      const chunks = [];
      if (ex.spentUsd != null && ex.limitUsd != null) {
        chunks.push(`$${ex.spentUsd.toFixed(2)} / $${ex.limitUsd.toFixed(2)} spent`);
        if (ex.availableUsd != null) chunks.push(`$${ex.availableUsd.toFixed(2)} available`);
        if (ex.overUsd && ex.overUsd > 0) chunks.push(`over by $${ex.overUsd.toFixed(2)}`);
      } else if (ex.pctUsed != null) {
        chunks.push(`${ex.pctUsed}% used`);
        if (ex.pctRemaining != null) chunks.push(`${ex.pctRemaining}% available`);
      }

      let head = "• Extra usage";
      if (ex.status === "exhausted") head += " (exhausted)";
      if (chunks.length) head += `: ${chunks.join(" · ")}`;
      lines.push(head);

      if (ex.resetText) {
        let resetLine = `  ↳ reset: ${ex.resetText}`;
        if (ex.resetIn) resetLine += ` (in ${ex.resetIn})`;
        lines.push(resetLine);
      }
    } else {
      lines.push("• Extra usage: unknown");
    }
  }

  if (lines.length <= 2) {
    return "Anthrometer: unable to parse usage output. Try /anthrometer raw.";
  }

  return lines.join("\n");
}
