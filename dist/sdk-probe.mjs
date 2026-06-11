const DEFAULT_CLAUDE_EXECUTABLE = "/usr/bin/claude";
const DEFAULT_PROMPT = "Reply exactly: OK";

export function isRateLimitEvent(message) {
  return message?.type === "rate_limit_event" && message?.rate_limit_info && typeof message.rate_limit_info === "object";
}

export async function probeClaudeSdkRateLimit(options = {}) {
  const {
    importSdk = () => import("@anthropic-ai/claude-agent-sdk"),
    pathToClaudeCodeExecutable = DEFAULT_CLAUDE_EXECUTABLE,
    timeoutMs = 15000,
    model = "haiku",
    prompt = DEFAULT_PROMPT,
    env = process.env,
  } = options;

  let sdk;
  try {
    sdk = await importSdk();
  } catch (err) {
    return {
      ok: false,
      unavailable: true,
      reason: err?.code === "ERR_MODULE_NOT_FOUND" ? "claude-agent-sdk-not-installed" : "claude-agent-sdk-import-failed",
      error: err?.message || String(err),
    };
  }

  if (typeof sdk?.query !== "function") {
    return {
      ok: false,
      unavailable: true,
      reason: "claude-agent-sdk-query-unavailable",
    };
  }

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const stream = sdk.query({
      prompt,
      options: {
        abortController,
        pathToClaudeCodeExecutable,
        env: {
          ...env,
          CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
        },
        model,
        maxTurns: 1,
        tools: [],
        permissionMode: "dontAsk",
        persistSession: false,
        cwd: "/tmp",
      },
    });

    let sawResult = false;
    for await (const message of stream) {
      if (isRateLimitEvent(message)) {
        return {
          ok: true,
          rateLimitInfo: message.rate_limit_info,
          sessionId: message.session_id || null,
        };
      }
      if (message?.type === "result") sawResult = true;
    }

    return {
      ok: false,
      unavailable: true,
      reason: sawResult ? "rate-limit-event-not-emitted" : "query-ended-without-rate-limit-event",
    };
  } catch (err) {
    return {
      ok: false,
      unavailable: true,
      reason: abortController.signal.aborted ? "claude-agent-sdk-probe-timeout" : "claude-agent-sdk-probe-failed",
      error: err?.message || String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
