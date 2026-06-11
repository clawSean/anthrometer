import test from "node:test";
import assert from "node:assert/strict";

import { normalizeSdkOverageInfo, parseUsage } from "../src/usage-parser.mjs";
import { isRateLimitEvent, probeClaudeSdkRateLimit } from "../src/sdk-probe.mjs";

test("probeClaudeSdkRateLimit fails soft when SDK package is unavailable", async () => {
  const result = await probeClaudeSdkRateLimit({
    importSdk: async () => {
      const err = new Error("Cannot find package");
      err.code = "ERR_MODULE_NOT_FOUND";
      throw err;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.unavailable, true);
  assert.equal(result.reason, "claude-agent-sdk-not-installed");
});

test("probeClaudeSdkRateLimit configures Claude Agent SDK query safely", async () => {
  const messages = [
    {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 0.82,
        resetsAt: 1_779_120_000,
        overageStatus: "allowed",
        isUsingOverage: false,
      },
      session_id: "sid-123",
    },
  ];
  let received;

  const result = await probeClaudeSdkRateLimit({
    timeoutMs: 1000,
    pathToClaudeCodeExecutable: "/usr/bin/claude",
    env: { EXISTING: "1" },
    importSdk: async () => ({
      query(params) {
        received = params;
        return (async function* () {
          yield* messages;
        })();
      },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.sessionId, "sid-123");
  assert.equal(result.rateLimitInfo.status, "allowed_warning");
  assert.equal(received.options.pathToClaudeCodeExecutable, "/usr/bin/claude");
  assert.equal(received.options.env.CLAUDE_CODE_DISABLE_1M_CONTEXT, "1");
  assert.equal(received.options.env.EXISTING, "1");
  assert.equal(received.options.model, "haiku");
  assert.equal(received.options.maxTurns, 1);
  assert.deepEqual(received.options.tools, []);
  assert.equal(received.options.permissionMode, "dontAsk");
  assert.equal(received.options.persistSession, false);
});

test("rate limit event detection and normalization tolerate missing fields", () => {
  assert.equal(isRateLimitEvent({ type: "result" }), false);
  assert.equal(isRateLimitEvent({ type: "rate_limit_event", rate_limit_info: {} }), true);

  const now = new Date("2026-05-12T20:00:00.000Z");
  const normalized = normalizeSdkOverageInfo({
    status: "allowed",
    rateLimitType: "overage",
    utilization: 0.456,
    resetsAt: Math.floor(new Date("2026-05-12T22:30:00.000Z").getTime() / 1000),
  }, now);

  assert.equal(normalized.source, "claude-agent-sdk-rate-limit-event");
  assert.equal(normalized.utilizationPercent, 46);
  assert.equal(normalized.resetsIn, "2h 30m");
  assert.equal(normalized.balanceAvailable, false);
});

test("parseUsage accepts SDK rate limit info without CLI overage dollars", () => {
  const parsed = parseUsage("Claude Max\n\nCurrent session\n12% used\nResets 11pm", new Date("2026-05-12T20:00:00.000Z"), {
    sdkOverage: { status: "allowed", overageDisabledReason: "out_of_credits" },
  });

  assert.equal(parsed.sdkOverage.status, "allowed");
  assert.equal(parsed.sdkOverage.overageDisabledReason, "out_of_credits");
});
