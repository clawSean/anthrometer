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
  return { y: now.getUTCFullYear(), m: now.getUTCMonth(), d: now.getUTCDate() };
}

function formatUtcIso(dt) {
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

function coerceDate(value) {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value > 10_000_000_000 ? value : value * 1000);
  if (typeof value === "string" && value.trim()) {
    const dt = new Date(value);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  return null;
}

export function parseResetTime(resetText, now = new Date()) {
  if (!resetText) return null;
  const cleaned = String(resetText).trim().replace(/\(UTC\)/ig, "").replace(/\s+/g, " ").trim();

  const md = cleaned.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})(?:,\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm))?$/i);
  if (md) {
    const monthNames = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const month = monthNames[md[1].slice(0, 3).toLowerCase()];
    let hour = md[3] ? Number(md[3]) : 0;
    const minute = md[4] ? Number(md[4]) : 0;
    const ap = String(md[5] || "").toLowerCase();
    if (ap === "pm" && hour < 12) hour += 12;
    if (ap === "am" && hour === 12) hour = 0;
    let dt = new Date(Date.UTC(utcDateParts(now).y, month, Number(md[2]), hour, minute, 0, 0));
    if (dt.getTime() <= now.getTime()) dt = new Date(Date.UTC(utcDateParts(now).y + 1, month, Number(md[2]), hour, minute, 0, 0));
    return dt;
  }

  const t = cleaned.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (t) {
    let hour = Number(t[1]);
    const minute = Number(t[2] || "0");
    const ap = t[3].toLowerCase();
    if (ap === "pm" && hour < 12) hour += 12;
    if (ap === "am" && hour === 12) hour = 0;
    const { y, m, d } = utcDateParts(now);
    let dt = new Date(Date.UTC(y, m, d, hour, minute, 0, 0));
    if (dt.getTime() <= now.getTime()) dt = new Date(Date.UTC(y, m, d + 1, hour, minute, 0, 0));
    return dt;
  }

  const tryParse = new Date(`${cleaned} UTC`);
  return Number.isNaN(tryParse.getTime()) ? null : tryParse;
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
  return { pctUsed: pct ? Number(pct) : null, pctRemaining: pct ? Math.max(0, 100 - Number(pct)) : null, resetText, resetAtIso: formatUtcIso(resetAt), resetIn: formatDuration(resetInMs) };
}

function parseExtraSection(lines, now = new Date()) {
  const idx = findHeadingIndex(lines, /^extra usage$/i);
  if (idx < 0) {
    return { status: /out of extra usage/i.test(lines.join("\n")) ? "exhausted" : "unknown", cleanText: null, pctUsed: null, pctRemaining: null, spentUsd: null, limitUsd: null, availableUsd: null, overUsd: null, resetText: null, resetAtIso: null, resetIn: null };
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

  if (status === "unknown" && (pct != null || (spentUsd != null && limitUsd != null))) status = "enabled";
  if (/out of extra usage/i.test(chunk)) status = "exhausted";

  return { status, cleanText: chunk, pctUsed: pct ? Number(pct) : null, pctRemaining: pct ? Math.max(0, 100 - Number(pct)) : null, spentUsd, limitUsd, availableUsd, overUsd, resetText, resetAtIso: formatUtcIso(resetAt), resetIn: formatDuration(resetAt ? resetAt.getTime() - now.getTime() : null) };
}

function parseApiBudget(clean, now = new Date()) {
  const lines = clean.split("\n").map((l) => l.trimEnd());
  const monthSection = parseWindowSection(lines, /^current month(?:\s*\(.*\))?$/i, now);
  if (!monthSection && !/api\s+usage/i.test(clean)) return null;

  const moneyMatch = clean.match(/\$\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*\$\s*([0-9]+(?:\.[0-9]+)?)\s*spent/i);
  const spentUsd = toNumber(moneyMatch?.[1] ?? null);
  const limitUsd = toNumber(moneyMatch?.[2] ?? null);
  const remainingUsd = spentUsd != null && limitUsd != null ? Math.max(0, limitUsd - spentUsd) : null;
  if (!monthSection && spentUsd == null && limitUsd == null) return null;
  return { label: "API budget", pctUsed: monthSection?.pctUsed ?? null, pctRemaining: monthSection?.pctRemaining ?? null, resetText: monthSection?.resetText ?? null, resetAtIso: monthSection?.resetAtIso ?? null, resetIn: monthSection?.resetIn ?? null, spentUsd, limitUsd, remainingUsd };
}

function parseJsonLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return null;
  const data = trimmed.match(/^data:\s*(.+)$/i)?.[1]?.trim();
  const candidate = data && data !== "[DONE]" ? data : trimmed;
  if (!candidate.startsWith("{")) return null;
  try { return JSON.parse(candidate); } catch { return null; }
}

function extractRateLimitInfo(event = {}) {
  return event?.rate_limit_info && typeof event.rate_limit_info === "object" ? event.rate_limit_info : event;
}

export function normalizeSdkOverageInfo(info = {}, now = new Date()) {
  info = extractRateLimitInfo(info);
  if (!info || typeof info !== "object") return null;

  const rateLimitType = typeof info.rate_limit_type === "string" ? info.rate_limit_type : typeof info.rateLimitType === "string" ? info.rateLimitType : null;
  const status = typeof info.status === "string" ? info.status : null;
  const overageStatus = typeof info.overage_status === "string" ? info.overage_status : typeof info.overageStatus === "string" ? info.overageStatus : null;
  const overageDisabledReason = typeof info.overage_disabled_reason === "string" ? info.overage_disabled_reason : typeof info.overageDisabledReason === "string" ? info.overageDisabledReason : null;
  const isUsingOverage = typeof info.is_using_overage === "boolean" ? info.is_using_overage : typeof info.isUsingOverage === "boolean" ? info.isUsingOverage : null;
  const utilizationRaw = typeof info.utilization === "number" && Number.isFinite(info.utilization) ? info.utilization : null;
  const utilization = utilizationRaw != null && utilizationRaw > 1 ? utilizationRaw / 100 : utilizationRaw;
  const resetsAtRaw = info.resets_at ?? info.resetsAt ?? null;
  const overageResetsAtRaw = info.overage_resets_at ?? info.overageResetsAt ?? null;
  const resetsAt = coerceDate(resetsAtRaw);
  const overageResetsAt = coerceDate(overageResetsAtRaw);

  if (!rateLimitType && !status && !overageStatus && !overageDisabledReason && isUsingOverage == null && utilization == null && !resetsAt && !overageResetsAt) return null;

  return {
    source: "claude-agent-sdk-rate-limit-event",
    rateLimitType,
    status,
    overageStatus,
    overageDisabledReason,
    isUsingOverage,
    utilization,
    pctUsed: utilization != null ? Math.round(utilization * 100) : null,
    pctRemaining: utilization != null ? Math.max(0, 100 - Math.round(utilization * 100)) : null,
    utilizationPercent: utilization != null ? Math.round(utilization * 100) : null,
    resetsAt: resetsAtRaw ?? formatUtcIso(resetsAt),
    resetsAtIso: formatUtcIso(resetsAt),
    resetsIn: resetsAt ? formatDuration(resetsAt.getTime() - now.getTime()) : null,
    overageResetsAt: overageResetsAtRaw ?? formatUtcIso(overageResetsAt),
    overageResetsAtIso: formatUtcIso(overageResetsAt),
    overageResetsIn: overageResetsAt ? formatDuration(overageResetsAt.getTime() - now.getTime()) : null,
    balanceAvailable: false,
    balanceNote: "Extra-usage dollar balance is not exposed by the Claude Agent SDK rate_limit_event.",
  };
}

function parseRateLimitEvents(clean = "") {
  return clean.split(/\n+/).map(parseJsonLine).filter((event) => event?.type === "rate_limit_event");
}

export function parseUsage(raw = "", now = new Date(), options = {}) {
  const clean = stripAnsi(raw);
  const lines = clean.split("\n").map((l) => l.trimEnd());
  const rateLimitEvents = parseRateLimitEvents(clean);
  const sdkOverage = normalizeSdkOverageInfo(options.sdkOverage || options.rateLimitInfo || rateLimitEvents[0] || null, now);

  const fiveHour = parseWindowSection(lines, /^current session$/i, now)
    || parseWindowSection(lines, /^current 5[ -]?hour(?: window)?$/i, now)
    || parseWindowSection(lines, /^current 5h(?: window)?$/i, now);
  const week = parseWindowSection(lines, /^current week(?:\s*\(all models\))?$/i, now);
  const extra = parseExtraSection(lines, now);
  const api = parseApiBudget(clean, now);

  const profileLine = lines.find((l) => /Claude\s+(Pro|Max|Team|Enterprise|API)/i.test(l)) || null;
  const mode = /Claude\s+API/i.test(profileLine || "") ? "api" : (fiveHour || week || /Claude\s+(Pro|Max|Team|Enterprise)/i.test(profileLine || "")) ? "subscription" : api ? "api" : "unknown";

  return { mode, fiveHour, week, extra, api, rateLimitEvents, overage: sdkOverage, sdkOverage, profileLine, clean };
}

function progressBar(pct, width = 10) {
  if (typeof pct !== "number" || Number.isNaN(pct)) return "";
  const capped = Math.min(100, Math.max(0, Number(pct)));
  let filled = Math.floor((capped / 100) * width);
  if (capped > 0 && filled === 0) filled = 1;
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

function fmtWindowBlock(title, section, emoji = "•") {
  if (!section || section.pctUsed == null) return null;
  const lines = [`${emoji} ${title}: ${progressBar(section.pctUsed, 10)}  ${section.pctUsed}% used${section.pctRemaining != null ? ` · ${section.pctRemaining}% left` : ""}`];
  if (section.resetText || section.resetIn) {
    const parts = [];
    if (section.resetText) parts.push(section.resetText);
    if (section.resetIn) parts.push(`in ${section.resetIn}`);
    lines.push(`   ↺ resets ${parts.join(" · ")}`);
  }
  return lines.join("\n");
}

function formatResetLine(prefix, resetText, resetIn) {
  const parts = [];
  if (resetText) parts.push(resetText);
  if (resetIn) parts.push(`in ${resetIn}`);
  return parts.length ? `${prefix}${parts.join(" · ")}` : null;
}

function formatSdkResetLine(prefix, iso, resetIn) {
  const parts = [];
  if (iso) parts.push(iso);
  if (resetIn) parts.push(`in ${resetIn}`);
  return parts.length ? `• ↺ ${prefix} ${parts.join(" · ")}` : null;
}

function formatSdkOverageBlock(overage) {
  if (!overage) return null;
  const lines = ["", `🧩 𝗦𝗗𝗞 Overage — ${overage.overageStatus || overage.status || "reported"}`];
  if (overage.pctUsed != null) lines.push(`• Utilization: ${progressBar(overage.pctUsed, 10)}  ${overage.pctUsed}%`);
  lines.push(`• Using overage: ${overage.isUsingOverage == null ? "unavailable" : overage.isUsingOverage ? "yes" : "no"}`);
  const limitReset = formatSdkResetLine("limit resets", overage.resetsAtIso, overage.resetsIn);
  if (limitReset) lines.push(limitReset);
  const overageReset = formatSdkResetLine("overage resets", overage.overageResetsAtIso, overage.overageResetsIn);
  if (overageReset) lines.push(overageReset);
  if (overage.overageDisabledReason) lines.push(`• Disabled reason: ${overage.overageDisabledReason}`);
  lines.push("• Dollar balance: unavailable");
  if (overage.isUsingOverage === true) lines.push("• Claude is using overage capacity");
  return lines.join("\n");
}

function computeStatus(parsed) {
  const ex = parsed?.extra;
  if (ex?.status === "exhausted") return { emoji: "🔴", label: "RED", hint: "Extra usage exhausted — switch Anthropic-heavy tasks to fallback providers." };
  if (ex?.overUsd && ex.overUsd > 0) return { emoji: "🔴", label: "RED", hint: "Over cap on extra usage — avoid Anthropic unless urgent." };
  if (typeof parsed?.week?.pctUsed === "number" && parsed.week.pctUsed >= 80) return { emoji: "🟡", label: "YELLOW", hint: "Weekly usage high — route routine tasks to cheaper models." };
  if (typeof parsed?.fiveHour?.pctUsed === "number" && parsed.fiveHour.pctUsed >= 80) return { emoji: "🟡", label: "YELLOW", hint: "5-hour window tight — avoid heavy bursts." };
  return { emoji: "🟢", label: "GREEN", hint: "Healthy usage headroom right now." };
}

export function formatUsage(parsed, options = {}) {
  const status = computeStatus(parsed);
  const modeSuffix = parsed?.mode && parsed.mode !== "unknown" ? ` · ${parsed.mode}` : "";
  const lines = [`📊 𝗔𝗻𝘁𝗵𝗿𝗼𝗺𝗲𝘁𝗲𝗿${modeSuffix}`];

  const fiveHourLine = fmtWindowBlock("5h", parsed?.fiveHour, "⚡");
  const weekLine = fmtWindowBlock("Week", parsed?.week, "📆");
  if (fiveHourLine || weekLine) {
    lines.push("", "📅 𝗦𝘂𝗯𝘀𝗰𝗿𝗶𝗽𝘁𝗶𝗼𝗻");
    if (fiveHourLine) lines.push(fiveHourLine);
    if (weekLine) lines.push(weekLine);
  }

  if (parsed?.api) {
    const a = parsed.api;
    lines.push("", "🧾 𝗔𝗣𝗜 𝗕𝘂𝗱𝗴𝗲𝘁");
    if (a.pctUsed != null) lines.push(`• Meter: ${progressBar(a.pctUsed, 10)}  ${a.pctUsed}% used${a.pctRemaining != null ? ` · ${a.pctRemaining}% left` : ""}`);
    if (a.spentUsd != null && a.limitUsd != null) {
      let spend = `• Spend: $${a.spentUsd.toFixed(2)} / $${a.limitUsd.toFixed(2)} spent`;
      if (a.remainingUsd != null) spend += ` · $${a.remainingUsd.toFixed(2)} left`;
      lines.push(spend);
    }
    const apiReset = formatResetLine("• ↺ resets ", a.resetText, a.resetIn);
    if (apiReset) lines.push(apiReset);
  }

  const ex = parsed?.extra;
  if (ex) {
    lines.push("", `💸 𝗘𝘅𝘁𝗿𝗮 𝗨𝘀𝗮𝗴𝗲${ex.status ? ` — ${ex.status}` : ""}`);
    if (ex.status === "not enabled") lines.push("• Not enabled");
    else if (ex.status === "enabled" || ex.status === "exhausted" || ex.pctUsed != null || (ex.spentUsd != null && ex.limitUsd != null)) {
      const pctFromDollars = ex.spentUsd != null && ex.limitUsd != null && ex.limitUsd > 0 ? (ex.spentUsd / ex.limitUsd) * 100 : null;
      const meterPct = ex.pctUsed != null ? ex.pctUsed : pctFromDollars;
      if (meterPct != null) lines.push(`• Meter: ${progressBar(meterPct, 10)}  ${Math.round(meterPct)}% used${ex.pctRemaining != null ? ` · ${ex.pctRemaining}% left` : ""}`);
      if (ex.spentUsd != null && ex.limitUsd != null) {
        let spend = `• Spend: $${ex.spentUsd.toFixed(2)} / $${ex.limitUsd.toFixed(2)} spent`;
        if (ex.availableUsd != null) spend += ` · $${ex.availableUsd.toFixed(2)} left`;
        if (ex.overUsd != null && ex.overUsd > 0) spend += ` · over cap by $${ex.overUsd.toFixed(2)}`;
        lines.push(spend);
      }
      const exReset = formatResetLine("• ↺ resets ", ex.resetText, ex.resetIn);
      if (exReset) lines.push(exReset);
    } else lines.push("• Unknown");
  }

  const sdkBlock = formatSdkOverageBlock(parsed?.sdkOverage || parsed?.overage);
  if (sdkBlock) lines.push(sdkBlock);

  if (options?.sdkProbe && options.sdkProbe.ok === false && options.sdkProbe.reason) lines.push("", `🧩 𝗦𝗗𝗞 Overage — unavailable (${options.sdkProbe.reason})`, "• Dollar balance: unavailable");

  lines.push("", `${status.emoji} ${status.hint}`);
  const rendered = lines.join("\n").trim();
  return !rendered || rendered.length < 24 ? "Anthrometer: unable to parse usage output. Try /anthrometer raw." : rendered;
}
