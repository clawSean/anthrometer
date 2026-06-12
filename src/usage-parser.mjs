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

// Matches any top-level section heading so we can stop parsing at section boundaries.
const SECTION_HEADING_RE = /^(?:Current\s+(?:session|5[\s-]?hour(?:\s+window)?|5h(?:\s+window)?|week|month)|Extra\s+usage|Usage\s+credits$|API\s+usage|What's\s+contributing)/i;

function findHeadingIndex(lines, regex) {
  return lines.findIndex((line) => regex.test(line.trim()));
}

/**
 * Returns the line index where the next section heading starts after startIndex,
 * or lines.length if none is found. Used to prevent cross-section data bleed.
 */
function sectionEnd(lines, startIndex) {
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (SECTION_HEADING_RE.test(lines[i].trim())) return i;
  }
  return lines.length;
}

function parseWindowSection(lines, headingRegex, now = new Date()) {
  const idx = findHeadingIndex(lines, headingRegex);
  if (idx < 0) return null;

  const end = sectionEnd(lines, idx);
  const chunk = lines.slice(idx, end).join("\n");
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
  let idx = findHeadingIndex(lines, /^extra usage$/i);
  if (idx < 0) idx = findHeadingIndex(lines, /^usage credits$/i);
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

  const end = sectionEnd(lines, idx);
  const chunk = lines.slice(idx, end).join("\n");
  const pct = chunk.match(/(\d+)\s*%\s*used/i)?.[1] ?? null;

  let status = "unknown";
  if (/not enabled/i.test(chunk)) status = "not enabled";
  else if (/usage credits are off/i.test(chunk)) status = "not enabled";
  else if (/usage credits are on/i.test(chunk)) status = "enabled";
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

function parseLocalStats(clean) {
  if (!/Settings\s+Status\s+Config\s+Usage\s+Stats/i.test(clean)) return null;
  if (!/Total cost:|Total duration|What's contributing to your limits usage\?/i.test(clean)) return null;

  const money = clean.match(/Total cost:\s*\$\s*([0-9]+(?:\.[0-9]+)?)/i);
  const apiDuration = clean.match(/Total duration \(API\):\s*([^\n]+)/i)?.[1]?.trim() ?? null;
  const wallDuration = clean.match(/Total duration \(wall\):\s*([^\n]+)/i)?.[1]?.trim() ?? null;
  const usageLine = clean.match(/Usage:\s*([^\n]+)/i)?.[1]?.trim() ?? null;
  const topInsight = clean.match(/\n\s*(\d+% of your usage[^\n]+)/i)?.[1]?.trim() ?? null;

  return {
    kind: "claude-code-local-stats",
    totalCostUsd: toNumber(money?.[1] ?? null),
    apiDuration,
    wallDuration,
    usageLine,
    topInsight,
  };
}

export function normalizeSdkOverageInfo(info = {}, now = new Date()) {
  if (!info || typeof info !== "object") return null;

  const rateLimitType = typeof info.rateLimitType === "string" ? info.rateLimitType : null;
  const status = typeof info.status === "string" ? info.status : null;
  const overageStatus = typeof info.overageStatus === "string" ? info.overageStatus : null;
  const overageDisabledReason = typeof info.overageDisabledReason === "string" ? info.overageDisabledReason : null;
  const isUsingOverage = typeof info.isUsingOverage === "boolean" ? info.isUsingOverage : null;
  const utilization = typeof info.utilization === "number" && Number.isFinite(info.utilization)
    ? info.utilization
    : null;
  const resetsAt = typeof info.resetsAt === "number" && Number.isFinite(info.resetsAt)
    ? new Date(info.resetsAt * 1000)
    : null;
  const overageResetsAt = typeof info.overageResetsAt === "number" && Number.isFinite(info.overageResetsAt)
    ? new Date(info.overageResetsAt * 1000)
    : null;

  if (!rateLimitType && !status && !overageStatus && !overageDisabledReason && isUsingOverage == null && utilization == null && !resetsAt && !overageResetsAt) {
    return null;
  }

  return {
    source: "claude-agent-sdk-rate-limit-event",
    rateLimitType,
    status,
    overageStatus,
    overageDisabledReason,
    isUsingOverage,
    utilization,
    utilizationPercent: utilization != null ? Math.round(utilization * 100) : null,
    resetsAtIso: formatUtcIso(resetsAt),
    resetsIn: resetsAt ? formatDuration(resetsAt.getTime() - now.getTime()) : null,
    overageResetsAtIso: formatUtcIso(overageResetsAt),
    overageResetsIn: overageResetsAt ? formatDuration(overageResetsAt.getTime() - now.getTime()) : null,
    balanceAvailable: false,
    balanceNote: "Extra-usage dollar balance is not exposed by the Claude Agent SDK rate_limit_event.",
  };
}

export function parseUsage(raw = "", now = new Date(), options = {}) {
  const clean = stripAnsi(raw);
  const lines = clean.split("\n").map((l) => l.trimEnd());

  const fiveHour = parseWindowSection(lines, /^current session$/i, now)
    || parseWindowSection(lines, /^current 5[ -]?hour(?: window)?$/i, now)
    || parseWindowSection(lines, /^current 5h(?: window)?$/i, now);

  const week = parseWindowSection(lines, /^current week(?:\s*\(all models\))?$/i, now);
  const weekSonnet = parseWindowSection(lines, /^current week\s*\(sonnet(?:\s+only)?\)$/i, now);
  const weekOpus = parseWindowSection(lines, /^current week\s*\(opus(?:\s+only)?\)$/i, now);
  const extra = parseExtraSection(lines, now);
  const api = parseApiBudget(clean, now);
  const localStats = parseLocalStats(clean);

  const profileLine = lines.find((l) => /Claude\s+(Pro|Max|Team|Enterprise|API)/i.test(l)) || null;
  const mode = /Claude\s+API/i.test(profileLine || "")
    ? "api"
    : (fiveHour || week || /Claude\s+(Pro|Max|Team|Enterprise)/i.test(profileLine || ""))
      ? "subscription"
      : api
        ? "api"
        : localStats
          ? "local-stats"
          : "unknown";

  return {
    mode,
    fiveHour,
    week,
    weekSonnet,
    weekOpus,
    extra,
    sdkOverage: normalizeSdkOverageInfo(options.sdkOverage || options.rateLimitInfo || null, now),
    api,
    localStats,
    profileLine,
    clean,
  };
}

function progressBar(pct, width = 10) {
  if (typeof pct !== "number" || Number.isNaN(pct)) return "";
  const n = Math.max(0, Number(pct));
  const capped = Math.min(100, n);
  const raw = (capped / 100) * width;
  let filled = Math.floor(raw);
  if (capped > 0 && filled === 0) filled = 1;
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

function fmtWindowBlock(title, section, emoji = "•") {
  if (!section || section.pctUsed == null) return null;
  const pct = section.pctUsed;
  const rem = section.pctRemaining;
  const bar = progressBar(pct, 10);

  const lines = [
    `${emoji} ${title}: ${bar}  ${pct}% used${rem != null ? ` · ${rem}% left` : ""}`,
  ];

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
  if (!parts.length) return null;
  return `${prefix}${parts.join(" · ")}`;
}

function computeStatus(parsed) {
  const ex = parsed?.extra;
  if (ex?.status === "exhausted") {
    return {
      emoji: "🔴",
      label: "RED",
      hint: "Extra usage exhausted — switch Anthropic-heavy tasks to fallback providers.",
    };
  }

  if (ex?.overUsd && ex.overUsd > 0) {
    return {
      emoji: "🔴",
      label: "RED",
      hint: "Over cap on extra usage — avoid Anthropic unless urgent.",
    };
  }

  if (typeof parsed?.week?.pctUsed === "number" && parsed.week.pctUsed >= 80) {
    return {
      emoji: "🟡",
      label: "YELLOW",
      hint: "Weekly usage high — route routine tasks to cheaper models.",
    };
  }

  if (typeof parsed?.fiveHour?.pctUsed === "number" && parsed.fiveHour.pctUsed >= 80) {
    return {
      emoji: "🟡",
      label: "YELLOW",
      hint: "5-hour window tight — avoid heavy bursts.",
    };
  }

  return {
    emoji: "🟢",
    label: "GREEN",
    hint: "Healthy usage headroom right now.",
  };
}

export function formatUsage(parsed) {
  const hasUsageData = Boolean(
    parsed?.fiveHour?.pctUsed != null
    || parsed?.week?.pctUsed != null
    || parsed?.api
    || parsed?.localStats
    || parsed?.extra?.status === "enabled"
    || parsed?.extra?.status === "exhausted"
    || parsed?.extra?.status === "not enabled"
    || parsed?.extra?.pctUsed != null
    || parsed?.extra?.spentUsd != null
    || parsed?.extra?.usedCredits != null
    || parsed?.sdkOverage
  );

  if (!hasUsageData) {
    return "Anthrometer: unable to parse usage output. Try /anthrometer raw.";
  }

  const status = computeStatus(parsed);
  const modeSuffix = parsed?.mode && parsed.mode !== "unknown" ? ` · ${parsed.mode}` : "";
  const lines = [`📊 𝗔𝗻𝘁𝗵𝗿𝗼𝗺𝗲𝘁𝗲𝗿${modeSuffix}`];

  const fiveHourLine = fmtWindowBlock("5h", parsed?.fiveHour, "⚡");
  const weekLine = fmtWindowBlock("Week", parsed?.week, "📆");
  const weekSonnetLine = fmtWindowBlock("Week (Sonnet)", parsed?.weekSonnet, "🎵");
  const weekOpusLine = fmtWindowBlock("Week (Opus)", parsed?.weekOpus, "🎼");
  if (fiveHourLine || weekLine || weekSonnetLine || weekOpusLine) {
    const sub = parsed?.subscriptionType ? ` (${parsed.subscriptionType})` : "";
    lines.push("", `📅 𝗦𝘂𝗯𝘀𝗰𝗿𝗶𝗽𝘁𝗶𝗼𝗻${sub}`);
    if (fiveHourLine) lines.push(fiveHourLine);
    if (weekLine) lines.push(weekLine);
    if (weekSonnetLine) lines.push(weekSonnetLine);
    if (weekOpusLine) lines.push(weekOpusLine);
  }

  if (parsed?.localStats && !parsed?.fiveHour && !parsed?.week && !parsed?.api) {
    const s = parsed.localStats;
    lines.push("", "🧭 𝗖𝗹𝗮𝘂𝗱𝗲 𝗖𝗼𝗱𝗲 𝗟𝗼𝗰𝗮𝗹 𝗦𝘁𝗮𝘁𝘀");
    if (s.totalCostUsd != null) lines.push(`• Session cost: $${s.totalCostUsd.toFixed(4)}`);
    if (s.apiDuration || s.wallDuration) {
      lines.push(`• Duration: ${s.apiDuration || "0s"} API${s.wallDuration ? ` · ${s.wallDuration} wall` : ""}`);
    }
    if (s.usageLine) lines.push(`• Tokens: ${s.usageLine}`);
    if (s.topInsight) lines.push(`• Insight: ${s.topInsight}`);
    lines.push("", "⚠️ Claude Code 2.1 changed `/usage`: subscription quota meters are not exposed in this screen anymore.");
  }

  if (parsed?.api) {
    const a = parsed.api;
    lines.push("", "🧾 𝗔𝗣𝗜 𝗕𝘂𝗱𝗴𝗲𝘁");

    if (a.pctUsed != null) {
      lines.push(`• Meter: ${progressBar(a.pctUsed, 10)}  ${a.pctUsed}% used${a.pctRemaining != null ? ` · ${a.pctRemaining}% left` : ""}`);
    }

    if (a.spentUsd != null && a.limitUsd != null) {
      let spend = `• Spend: $${a.spentUsd.toFixed(2)} / $${a.limitUsd.toFixed(2)} spent`;
      if (a.remainingUsd != null) spend += ` · $${a.remainingUsd.toFixed(2)} left`;
      lines.push(spend);
    }

    const apiReset = formatResetLine("• ↺ resets ", a.resetText, a.resetIn);
    if (apiReset) lines.push(apiReset);
  }

  const sdk = parsed?.sdkOverage;
  if (sdk) {
    const prettyReason = sdk.overageDisabledReason ? sdk.overageDisabledReason.replace(/_/g, " ") : null;
    const state = sdk.isUsingOverage
      ? "active"
      : sdk.overageStatus === "allowed"
        ? "allowed"
        : sdk.overageStatus === "allowed_warning"
          ? "allowed — warning"
          : sdk.overageStatus === "rejected"
            ? "rejected"
            : "unknown";

    lines.push("", `💸 𝗘𝘅𝘁𝗿𝗮 𝗨𝘀𝗮𝗴𝗲 — ${state}`);
    if (sdk.isUsingOverage) lines.push("• Currently billing through extra usage");
    if (sdk.overageStatus) lines.push(`• Overage status: ${sdk.overageStatus}`);
    if (prettyReason) lines.push(`• Reason: ${prettyReason}`);
    if (sdk.rateLimitType) lines.push(`• Rate-limit window: ${sdk.rateLimitType}`);
    if (sdk.utilizationPercent != null) lines.push(`• Window utilization: ${progressBar(sdk.utilizationPercent, 10)}  ${sdk.utilizationPercent}%`);
    if (sdk.resetsAtIso || sdk.resetsIn) {
      const parts = [];
      if (sdk.resetsAtIso) parts.push(sdk.resetsAtIso);
      if (sdk.resetsIn) parts.push(`in ${sdk.resetsIn}`);
      lines.push(`• ↺ window resets ${parts.join(" · ")}`);
    }
    if (sdk.overageResetsAtIso || sdk.overageResetsIn) {
      const parts = [];
      if (sdk.overageResetsAtIso) parts.push(sdk.overageResetsAtIso);
      if (sdk.overageResetsIn) parts.push(`in ${sdk.overageResetsIn}`);
      lines.push(`• ↺ overage resets ${parts.join(" · ")}`);
    }
    lines.push("• Dollar balance: unavailable from supported Claude SDK/statusline fields");
  }

  const ex = parsed?.extra;
  const hasExtraData = !sdk && ex && (
    ex.status === "enabled"
    || ex.status === "exhausted"
    || ex.status === "not enabled"
    || ex.pctUsed != null
    || ex.spentUsd != null
    || ex.usedCredits != null
  );
  if (hasExtraData) {
    const exStatus = ex.status || "enabled";
    lines.push("", `💸 𝗘𝘅𝘁𝗿𝗮 𝗨𝘀𝗮𝗴𝗲${exStatus ? ` — ${exStatus}` : ""}`);

    if (ex.status === "not enabled") {
      lines.push("• Not enabled");
      if (ex.disabledReason) lines.push(`• Reason: ${String(ex.disabledReason).replace(/_/g, " ")}`);
    } else if (ex.status === "enabled" || ex.status === "exhausted" || ex.pctUsed != null || (ex.spentUsd != null && ex.limitUsd != null) || ex.usedCredits != null) {
      const pctFromDollars = (ex.spentUsd != null && ex.limitUsd != null && ex.limitUsd > 0)
        ? (ex.spentUsd / ex.limitUsd) * 100
        : null;
      const meterPct = ex.pctUsed != null ? ex.pctUsed : pctFromDollars;
      if (meterPct != null) {
        lines.push(`• Meter: ${progressBar(meterPct, 10)}  ${Math.round(meterPct)}% used${ex.pctRemaining != null ? ` · ${ex.pctRemaining}% left` : ""}`);
      }

      if (ex.spentUsd != null && ex.limitUsd != null) {
        let spend = `• Spend: $${ex.spentUsd.toFixed(2)} / $${ex.limitUsd.toFixed(2)} spent`;
        if (ex.availableUsd != null) spend += ` · $${ex.availableUsd.toFixed(2)} left`;
        if (ex.overUsd != null && ex.overUsd > 0) spend += ` · over cap by $${ex.overUsd.toFixed(2)}`;
        lines.push(spend);
      } else if (ex.usedCredits != null && ex.monthlyLimit != null) {
        const unit = ex.currency === "USD" ? "$" : "";
        const suffix = ex.currency && ex.currency !== "USD" ? ` ${ex.currency}` : "";
        let spend = `• Credits: ${unit}${ex.usedCredits.toFixed(2)}${suffix} / ${unit}${ex.monthlyLimit.toFixed(2)}${suffix} used`;
        if (ex.remainingCredits != null) spend += ` · ${unit}${ex.remainingCredits.toFixed(2)}${suffix} left`;
        lines.push(spend);
      }

      const exReset = formatResetLine("• ↺ resets ", ex.resetText, ex.resetIn);
      if (exReset) lines.push(exReset);
    } else {
      lines.push("• Unknown");
    }
  }

  lines.push("", `${status.emoji} ${status.hint}`);

  if (parsed?.source === "oauth-usage-endpoint") {
    lines.push("⚙︎ source: Anthropic OAuth usage API (claude-cli account)");
  } else if (parsed?.fiveHour || parsed?.week) {
    lines.push("⚙︎ source: Claude CLI /usage screen");
  }

  const rendered = lines.join("\n").trim();
  if (!rendered || rendered.length < 24) {
    return "Anthrometer: unable to parse usage output. Try /anthrometer raw.";
  }

  return rendered;
}
