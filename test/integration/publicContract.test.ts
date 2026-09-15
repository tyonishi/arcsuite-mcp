import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRuntime } from "../../src/server.ts";
import fixture from "../fixtures/public-contract/round3-tools-list.json" with { type: "json" };

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

async function listTools(protocolVersion: "2025-03-26" | "2026-07-28") {
  const dir = await mkdtemp(join(tmpdir(), "arcsuite-mcp-public-contract-"));
  const runtime = await buildRuntime({
    ...process.env,
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
    MCP_ALLOWED_ORIGIN_HOSTNAMES: "127.0.0.1,localhost"
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
  test(`authenticated HTTP tools/list remains the Round-3 public contract (${protocolVersion})`, async () => {
    const listed = await listTools(protocolVersion);
    assert.equal(listed.status, 200);
    assert.deepEqual(Object.keys(listed.result).sort(), protocolVersion === "2026-07-28" ? fixture.modern_result_keys : fixture.result_keys);
    assert.equal(listed.result.tools.length, fixture.tool_count);
    assert.deepEqual(listed.result.tools.map((tool: { name: string }) => tool.name), fixture.tool_names);
    assert.deepEqual([...new Set(listed.result.tools.map((tool: Record<string, unknown>) => Object.keys(tool).sort().join(",")))].sort(), fixture.tool_key_sets);
    assert.equal(hashTools(listed.result.tools), fixture.canonical_tools_sha256);
  });
}
