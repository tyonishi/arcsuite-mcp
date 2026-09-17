import test from "node:test";
import assert from "node:assert/strict";
import { redactAuditValue } from "../../src/audit/redaction.ts";
import { ArcSuiteAdapterError } from "../../src/arcsuite/errors.ts";
import { toMcpToolError } from "../../src/mcp/errors.ts";
import { RateLimiter } from "../../src/mcp/auth.ts";

test("audit redaction drops secrets, sessions, queries, and extracted content", () => {
  const value = redactAuditValue({
    trace_id: "synthetic",
    password: "secret",
    sessionId: "session",
    query: "private text",
    nested: {
      content: "document text",
      ref: "arh1.private",
      locator: "private-locator",
      tag: "private-tag",
      policyFingerprint: "private-fingerprint",
      tokenSha256: "private-token-hash",
      cursor: "private-provider-cursor",
      keep: "metadata"
    }
  }) as Record<string, unknown>;
  assert.deepEqual(value, { trace_id: "synthetic", nested: { keep: "metadata" } });
});

test("adapter errors map to stable MCP codes without upstream text", () => {
  const mapped = toMcpToolError(new ArcSuiteAdapterError("ARCSUITE_SESSION_EXPIRED", "private upstream detail", { retryable: true }));
  assert.equal(mapped.stableCode, "ARCSUITE_SESSION_EXPIRED");
  assert.equal(mapped.retryable, true);
  assert.equal(mapped.message, "ARCSUITE_SESSION_EXPIRED");
});

test("rate limiter fails closed for malformed profile limits", () => {
  const limiter = new RateLimiter();
  const profile = { clientProfileId: "synthetic", rateLimit: { requestsPerMinute: Number.NaN, burst: 10 } } as any;
  assert.equal(limiter.allow(profile), false);
  profile.rateLimit = { requestsPerMinute: 60, burst: Number.POSITIVE_INFINITY };
  assert.equal(limiter.allow(profile), false);
});
