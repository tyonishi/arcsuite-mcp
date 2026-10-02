import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AuditLogger } from "../../src/audit/auditLogger.ts";
import { buildRuntime } from "../../src/server.ts";

test("audit rejection preserves successful and failed business outcomes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "arcsuite-audit-open-"));
  const rt = await buildRuntime({
    ...process.env, NODE_ENV: "test", ARCSUITE_ADAPTER_MODE: "mock", MCP_DEV_BEARER_TOKEN: "test-token",
    MCP_SCOPES_FILE: resolve("config/scopes.mock.yaml"), MCP_SHARED_TEMP_DIR: join(dir, "shared"),
    MCP_AUDIT_LOG_PATH: join(dir, "audit.jsonl"), MCP_CURSOR_HMAC_SECRET: "0123456789abcdef0123456789abcdef",
    MCP_VALIDATE_ON_STARTUP: "true"
  });
  t.after(async () => { rt.stopValidationRetry(); await rm(dir, { recursive: true, force: true }); });
  const audit = t.mock.method(AuditLogger.prototype, "write", async () => { throw new Error("synthetic audit failure"); });
  const profile = rt.config.tokenProfiles[0]!;
  const result = await rt.tools.call(profile, "arcsuite_describe_capabilities", {});
  assert.ok(result.structuredContent);
  await assert.rejects(rt.tools.call(profile, "arcsuite_get_document", {}), (error: unknown) => {
    assert.equal((error as { stableCode: string }).stableCode, "ARCSUITE_INVALID_ARGUMENT");
    return true;
  });
  assert.equal(audit.mock.callCount(), 2);
});
