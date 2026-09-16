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

test("configuration keeps read character bounds aligned with the public schema", () => {
  assert.throws(() => loadConfig({ ...baseEnv, MCP_READ_DEFAULT_MAX_CHARS: "999", MCP_READ_MAX_CHARS: "1000" }), /MCP_READ_DEFAULT_MAX_CHARS/);
  assert.throws(() => loadConfig({ ...baseEnv, MCP_READ_DEFAULT_MAX_CHARS: "1000", MCP_READ_MAX_CHARS: "999" }), /MCP_READ_MAX_CHARS/);
  const config = loadConfig({ ...baseEnv, MCP_READ_DEFAULT_MAX_CHARS: "1000", MCP_READ_MAX_CHARS: "1000" });
  assert.equal(config.readDefaultMaxChars, 1000);
  assert.equal(config.readMaxChars, 1000);
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

test("hard-reference candidates have a bounded default and cannot exceed snapshot capacity", () => {
  const defaults = loadConfig(baseEnv);
  assert.equal(defaults.hardReferenceMaxCandidates, 200);

  const bounded = loadConfig({ ...baseEnv, MCP_HARD_REFERENCE_MAX_CANDIDATES: "300" });
  assert.equal(bounded.hardReferenceMaxCandidates, 300);

  assert.throws(() => loadConfig({ ...baseEnv, MCP_HARD_REFERENCE_MAX_CANDIDATES: "1001" }), /MCP_HARD_REFERENCE_MAX_CANDIDATES/);
  assert.throws(() => loadConfig({ ...baseEnv, MCP_HARD_REFERENCE_MAX_CANDIDATES: "6", MCP_SEARCH_DEFAULT_LIMIT: "5", MCP_SEARCH_MAX_LIMIT: "5", MCP_PAGING_SNAPSHOT_MAX_IDS: "5" }), /MCP_HARD_REFERENCE_MAX_CANDIDATES cannot exceed MCP_PAGING_SNAPSHOT_MAX_IDS/);
});

test("opaque refs are disabled without adding a legacy startup secret requirement", () => {
  const config = loadConfig(baseEnv);
  assert.equal(config.opaqueRefs, null);
});

test("enabled opaque refs require a bounded valid keyring", () => {
  const enabled = { ...baseEnv, MCP_OPAQUE_REFS_ENABLED: "true" };
  assert.throws(() => loadConfig(enabled), /MCP_OPAQUE_REF_KEYS_JSON/);
  assert.throws(() => loadConfig({ ...enabled, MCP_OPAQUE_REF_KEYS_JSON: "not-json" }), /opaque ref keyring/i);
  assert.throws(() => loadConfig({
    ...enabled,
    MCP_OPAQUE_REF_KEYS_JSON: JSON.stringify({ active_kid: "missing", keys: [{ kid: "present", secret_base64url: Buffer.alloc(32).toString("base64url") }] })
  }), /active/i);
  assert.throws(() => loadConfig({
    ...enabled,
    MCP_OPAQUE_REF_KEYS_JSON: JSON.stringify({ active_kid: "duplicate", keys: [
      { kid: "duplicate", secret_base64url: Buffer.alloc(32, 1).toString("base64url") },
      { kid: "duplicate", secret_base64url: Buffer.alloc(32, 2).toString("base64url") }
    ] })
  }), /duplicate/i);
  assert.throws(() => loadConfig({
    ...enabled,
    MCP_OPAQUE_REF_KEYS_JSON: JSON.stringify({ active_kid: "short", keys: [{ kid: "short", secret_base64url: Buffer.alloc(16).toString("base64url") }] })
  }), /32/);

  const config = loadConfig({
    ...enabled,
    MCP_OPAQUE_REF_KEYS_JSON: JSON.stringify({ active_kid: "active-1", keys: [{ kid: "active-1", secret_base64url: Buffer.alloc(32, 3).toString("base64url") }] }),
    MCP_OPAQUE_REF_TTL_SECONDS: "600",
    MCP_OPAQUE_REF_MAX_ENTRIES: "100",
    MCP_OPAQUE_REF_CONTRACT_GENERATION: "1",
    MCP_OPAQUE_REF_CREDENTIAL_CONTEXT_GENERATION: "7"
  });
  assert.equal(config.opaqueRefs?.activeKid, "active-1");
  assert.equal(config.opaqueRefs?.ttlSeconds, 600);
  assert.equal(config.opaqueRefs?.capacity, 100);
  assert.equal(config.opaqueRefs?.contractGeneration, 1);
  assert.equal(config.opaqueRefs?.credentialContextGeneration, 7);
});

test("opaque ref capacity can hold one maximum search page and its top-level refs", () => {
  const keyring = JSON.stringify({ active_kid: "active-1", keys: [{ kid: "active-1", secret_base64url: Buffer.alloc(32, 5).toString("base64url") }] });
  assert.throws(() => loadConfig({
    ...baseEnv,
    MCP_OPAQUE_REFS_ENABLED: "true",
    MCP_OPAQUE_REF_KEYS_JSON: keyring,
    MCP_SEARCH_MAX_LIMIT: "50",
    MCP_OPAQUE_REF_MAX_ENTRIES: "51"
  }), /MCP_SEARCH_MAX_LIMIT \+ 2/);
});

test("production opaque refs accept secret material only from a file", () => {
  const dir = mkdtempSync(join(tmpdir(), "arcsuite-mcp-handle-config-"));
  const keyFile = join(dir, "handle-keys.json");
  const tokenSha256 = createHash("sha256").update("production-token").digest("hex");
  const productionTokens = JSON.stringify({ tokens: [{
    tokenSha256,
    clientProfileId: "production-client",
    allowedScopes: ["example_documents"],
    allowedTools: ["arcsuite_search_documents"],
    rateLimit: { requestsPerMinute: 1, burst: 1 }
  }] });
  const keyring = JSON.stringify({ active_kid: "active-1", keys: [{ kid: "active-1", secret_base64url: Buffer.alloc(32, 4).toString("base64url") }] });
  const env = {
    ...baseEnv,
    NODE_ENV: "production",
    MCP_DEV_BEARER_TOKEN: undefined,
    ARCSUITE_MCP_CLIENT_TOKENS_JSON: productionTokens,
    MCP_CURSOR_HMAC_SECRET_FILE: join(dir, "cursor-secret"),
    MCP_OPAQUE_REFS_ENABLED: "true",
    MCP_OPAQUE_REF_KEYS_JSON: keyring
  };
  writeFileSync(env.MCP_CURSOR_HMAC_SECRET_FILE, "0123456789abcdef0123456789abcdef");
  assert.throws(() => loadConfig(env), /MCP_OPAQUE_REF_KEYS_JSON_FILE/);
  writeFileSync(keyFile, keyring);
  const config = loadConfig({ ...env, MCP_OPAQUE_REF_KEYS_JSON_FILE: keyFile });
  assert.equal(config.opaqueRefs?.activeKid, "active-1");
});
