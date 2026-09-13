import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";

const baseEnv = {
  NODE_ENV: "test",
  ARCSUITE_ADAPTER_MODE: "mock",
  MCP_DEV_BEARER_TOKEN: "test-token",
  MCP_SCOPES_FILE: "config/scopes.mock.yaml",
  MCP_CURSOR_HMAC_SECRET: "0123456789abcdef0123456789abcdef"
};

test("configuration rejects request and content limits above hard bounds", () => {
  assert.throws(() => loadConfig({ ...baseEnv, MCP_MAX_REQUEST_BYTES: String(4 * 1024 * 1024 + 1) }), /MCP_MAX_REQUEST_BYTES/);
  assert.throws(() => loadConfig({ ...baseEnv, MCP_MAX_CONTENT_BYTES: String(100 * 1024 * 1024 + 1) }), /MCP_MAX_CONTENT_BYTES/);
});

test("configuration rejects malformed token profile rate limits", () => {
  const tokenSha256 = createHash("sha256").update("synthetic").digest("hex");
  const tokens = JSON.stringify({ tokens: [{
    tokenSha256,
    clientProfileId: "synthetic-client",
    allowedScopes: ["example_documents"],
    allowedTools: ["arcsuite_search_documents"],
    rateLimit: { requestsPerMinute: "not-a-number", burst: 1 }
  }] });
  assert.throws(() => loadConfig({ ...baseEnv, MCP_DEV_BEARER_TOKEN: undefined, ARCSUITE_MCP_CLIENT_TOKENS_JSON: tokens }), /rateLimit\.requestsPerMinute/);
});

test("configuration normalizes the adapter URL and exposes a bounded request limit", () => {
  const config = loadConfig({ ...baseEnv, ARCSUITE_ADAPTER_BASE_URL: "http://adapter.example.invalid///", MCP_MAX_REQUEST_BYTES: "2048" });
  assert.equal(config.adapterBaseUrl, "http://adapter.example.invalid");
  assert.equal(config.maxRequestBytes, 2048);
});

test("production requires a non-empty cursor secret file and ignores the inline secret", () => {
  const dir = mkdtempSync(join(tmpdir(), "arcsuite-mcp-config-"));
  const secretFile = join(dir, "cursor-secret");
  const tokenSha256 = createHash("sha256").update("production-token").digest("hex");
  const productionTokens = JSON.stringify({ tokens: [{
    tokenSha256,
    clientProfileId: "production-client",
    allowedScopes: ["example_documents"],
    allowedTools: ["arcsuite_search_documents"],
    rateLimit: { requestsPerMinute: 1, burst: 1 }
  }] });
  const env = {
    ...baseEnv,
    NODE_ENV: "production",
    MCP_DEV_BEARER_TOKEN: undefined,
    ARCSUITE_MCP_CLIENT_TOKENS_JSON: productionTokens,
    MCP_CURSOR_HMAC_SECRET: "inline-secret"
  };
  assert.throws(() => loadConfig({ ...env, MCP_CURSOR_HMAC_SECRET_FILE: undefined }), /MCP_CURSOR_HMAC_SECRET_FILE/);
  writeFileSync(secretFile, "");
  assert.throws(() => loadConfig({ ...env, MCP_CURSOR_HMAC_SECRET_FILE: secretFile }), /MCP_CURSOR_HMAC_SECRET_FILE/);
  writeFileSync(secretFile, "file-secret\n");
  const config = loadConfig({ ...env, MCP_CURSOR_HMAC_SECRET_FILE: secretFile });
  assert.equal(config.cursorSecret.toString("utf8"), "file-secret");
});

test("configuration keeps search page sizes compatible with paging snapshots", () => {
  assert.throws(() => loadConfig({ ...baseEnv, MCP_SEARCH_DEFAULT_LIMIT: "4", MCP_SEARCH_MAX_LIMIT: "5", MCP_PAGING_SNAPSHOT_MAX_IDS: "4" }), /MCP_SEARCH_MAX_LIMIT cannot exceed MCP_PAGING_SNAPSHOT_MAX_IDS/);
  const config = loadConfig({ ...baseEnv, MCP_SEARCH_DEFAULT_LIMIT: "5", MCP_SEARCH_MAX_LIMIT: "5", MCP_PAGING_SNAPSHOT_MAX_IDS: "5" });
  assert.equal(config.searchMaxLimit, 5);
  assert.equal(config.pagingSnapshotMaxIds, 5);
});
