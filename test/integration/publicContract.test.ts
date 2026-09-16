import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRuntime } from "../../src/server.ts";
import fixture from "../fixtures/public-contract/vnext-p1-tools-list.json" with { type: "json" };
import p2Fixture from "../fixtures/public-contract/vnext-p2-tools-list.json" with { type: "json" };
import baselineFixture from "../fixtures/public-contract/round3-tools-list.json" with { type: "json" };

const P2_TOOLS = p2Fixture.intentional_public_contract_delta.new_tools;
const opaqueKeyring = JSON.stringify({
  active_kid: "contract-test",
  keys: [{ kid: "contract-test", secret_base64url: Buffer.alloc(32, 0x71).toString("base64url") }]
});

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function hashTools(tools: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(tools))).digest("hex");
}

async function listTools(
  protocolVersion: "2025-03-26" | "2026-07-28",
  p2 = false,
  inheritedEnv: NodeJS.ProcessEnv = process.env
) {
  const dir = await mkdtemp(join(tmpdir(), "arcsuite-mcp-public-contract-"));
  const runtime = await buildRuntime({
    ...inheritedEnv,
    ARCSUITE_MCP_CLIENT_TOKENS_JSON: undefined,
    ARCSUITE_MCP_CLIENT_TOKENS_JSON_FILE: undefined,
    MCP_OPAQUE_REFS_ENABLED: "false",
    MCP_OPAQUE_REF_KEYS_JSON: undefined,
    MCP_OPAQUE_REF_KEYS_JSON_FILE: undefined,
    NODE_ENV: "test",
    ARCSUITE_ADAPTER_MODE: "mock",
    MCP_DEV_BEARER_TOKEN: "test-token",
    MCP_SCOPES_FILE: resolve("config/scopes.mock.yaml"),
    MCP_SHARED_TEMP_DIR: join(dir, "shared"),
    MCP_AUDIT_LOG_PATH: join(dir, "audit.jsonl"),
    MCP_CURSOR_HMAC_SECRET: "0123456789abcdef0123456789abcdef",
    MCP_VALIDATE_ON_STARTUP: "true",
    MCP_SEARCH_DEFAULT_LIMIT: "20",
    MCP_SEARCH_MAX_LIMIT: "50",
    MCP_BATCH_MAX_IDS: "50",
    MCP_READ_DEFAULT_MAX_CHARS: "20000",
    MCP_READ_MAX_CHARS: "50000",
    MCP_PAGING_SNAPSHOT_MAX_IDS: "1000",
    MCP_ALLOWED_HOSTNAMES: "127.0.0.1,localhost",
    MCP_ALLOWED_ORIGIN_HOSTNAMES: "127.0.0.1,localhost",
    ...(p2 ? {
      MCP_OPAQUE_REFS_ENABLED: "true",
      MCP_OPAQUE_REF_KEYS_JSON: opaqueKeyring,
      ARCSUITE_MCP_CLIENT_TOKENS_JSON: JSON.stringify({ tokens: [{
        tokenSha256: createHash("sha256").update("test-token").digest("hex"),
        clientProfileId: "p2-contract-profile",
        allowedScopes: ["example_documents"],
        allowedTools: [...fixture.tool_names, ...P2_TOOLS],
        rateLimit: { requestsPerMinute: 120, burst: 30 }
      }] })
    } : {})
  });
  try {
    await new Promise<void>((resolveListen) => runtime.server.listen(0, "127.0.0.1", resolveListen));
    const address = runtime.server.address();
    if (!address || typeof address === "string") throw new Error("server address unavailable");
    const params = protocolVersion === "2026-07-28"
      ? { _meta: { "io.modelcontextprotocol/protocolVersion": protocolVersion, "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "fixture", version: "1" } } }
      : {};
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": protocolVersion,
        "mcp-method": "tools/list"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params })
    });
    const body = await response.text();
    const dataLine = body.split("\n").find((line) => line.startsWith("data:"));
    const envelope = JSON.parse(dataLine ? dataLine.slice(5) : body) as { result: any };
    return { status: response.status, result: envelope.result };
  } finally {
    try {
      runtime.stopValidationRetry();
    } finally {
      if (runtime.server.listening) {
        await new Promise<void>((resolveClose) => {
          runtime.server.close(() => resolveClose());
        });
      }
    }
  }
}

for (const protocolVersion of ["2025-03-26", "2026-07-28"] as const) {
  test(`authenticated HTTP tools/list matches the P1 additive public contract (${protocolVersion})`, async () => {
    const listed = await listTools(protocolVersion);
    assert.equal(listed.status, 200);
    assert.deepEqual(Object.keys(listed.result).sort(), protocolVersion === "2026-07-28" ? fixture.modern_result_keys : fixture.result_keys);
    assert.equal(listed.result.tools.length, fixture.tool_count);
    assert.deepEqual(listed.result.tools.map((tool: { name: string }) => tool.name), fixture.tool_names);
    assert.deepEqual([...new Set(listed.result.tools.map((tool: Record<string, unknown>) => Object.keys(tool).sort().join(",")))].sort(), fixture.tool_key_sets);
    assert.equal(hashTools(listed.result.tools), fixture.canonical_tools_sha256);
    const search = listed.result.tools.find((tool: { name: string }) => tool.name === "arcsuite_search_documents");
    assert.deepEqual(search.inputSchema.properties.response_contract.enum, fixture.intentional_public_contract_delta.allowed_values);
    assert.equal(search.inputSchema.properties.response_contract.description.includes("Initial searches only"), true);
    assert.deepEqual(fixture.intentional_public_contract_delta.changed_tool_input_schemas, ["arcsuite_search_documents"]);
    assert.deepEqual(fixture.intentional_public_contract_delta.new_tools, []);
    assert.deepEqual(fixture.intentional_public_contract_delta.removed_tools, []);
    const legacyProjection = structuredClone(listed.result.tools);
    const projectedSearch = legacyProjection.find((tool: { name: string }) => tool.name === "arcsuite_search_documents");
    delete projectedSearch.inputSchema.properties.response_contract;
    assert.equal(hashTools(legacyProjection), baselineFixture.canonical_tools_sha256,
      "removing response_contract must restore the exact previous public tools/list contract");
  });
}

test("public contract fixtures ignore inherited token and opaque-ref authority", async () => {
  const hostileInheritedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ARCSUITE_MCP_CLIENT_TOKENS_JSON: "not-json",
    ARCSUITE_MCP_CLIENT_TOKENS_JSON_FILE: join(tmpdir(), "must-not-read-token-config.json"),
    MCP_OPAQUE_REFS_ENABLED: "true",
    MCP_OPAQUE_REF_KEYS_JSON: "not-json",
    MCP_OPAQUE_REF_KEYS_JSON_FILE: join(tmpdir(), "must-not-read-key-config.json")
  };
  const p1 = await listTools("2025-03-26", false, hostileInheritedEnv);
  assert.equal(p1.status, 200);
  assert.equal(hashTools(p1.result.tools), fixture.canonical_tools_sha256);
  const p2 = await listTools("2025-03-26", true, hostileInheritedEnv);
  assert.equal(p2.status, 200);
  assert.equal(hashTools(p2.result.tools), p2Fixture.canonical_tools_sha256);
});

for (const protocolVersion of ["2025-03-26", "2026-07-28"] as const) {
  test(`authenticated HTTP tools/list matches the P2 additive public contract (${protocolVersion})`, async () => {
    const listed = await listTools(protocolVersion, true);
    assert.equal(listed.status, 200);
    assert.deepEqual(Object.keys(listed.result).sort(), protocolVersion === "2026-07-28" ? p2Fixture.modern_result_keys : p2Fixture.result_keys);
    assert.equal(listed.result.tools.length, p2Fixture.tool_count);
    assert.deepEqual(listed.result.tools.map((tool: { name: string }) => tool.name), p2Fixture.tool_names);
    assert.deepEqual([...new Set(listed.result.tools.map((tool: Record<string, unknown>) => Object.keys(tool).sort().join(",")))].sort(), p2Fixture.tool_key_sets);
    assert.equal(hashTools(listed.result.tools), p2Fixture.canonical_tools_sha256);
    assert.deepEqual(listed.result.tools.slice(0, fixture.tool_count), (await listTools(protocolVersion)).result.tools,
      "P2 must not change any P1 tool schema or description");
    assert.deepEqual(listed.result.tools.slice(fixture.tool_count).map((tool: { name: string }) => tool.name), P2_TOOLS);
    assert.deepEqual(p2Fixture.intentional_public_contract_delta.changed_existing_tool_input_schemas, []);
    assert.deepEqual(p2Fixture.intentional_public_contract_delta.removed_tools, []);
  });
}
