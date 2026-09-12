import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRuntime } from "../../src/server.ts";

async function start(overrides: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "arcsuite-mcp-http-"));
  const rt = await buildRuntime({
    ...process.env,
    NODE_ENV: "test",
    ARCSUITE_ADAPTER_MODE: "mock",
    MCP_DEV_BEARER_TOKEN: "http-token",
    MCP_SCOPES_FILE: resolve("config/scopes.mock.yaml"),
    MCP_SHARED_TEMP_DIR: join(dir, "shared"),
    MCP_AUDIT_LOG_PATH: join(dir, "audit.jsonl"),
    MCP_CURSOR_HMAC_SECRET: "0123456789abcdef0123456789abcdef",
    MCP_ALLOWED_HOSTNAMES: "127.0.0.1,localhost",
    MCP_ALLOWED_ORIGIN_HOSTNAMES: "127.0.0.1,localhost",
    MCP_VALIDATE_ON_STARTUP: "true",
    ...overrides
  });
  await new Promise<void>((resolveListen) => rt.server.listen(0, "127.0.0.1", resolveListen));
  const addr = rt.server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  return { rt, base: `http://127.0.0.1:${addr.port}` };
}

async function rpc(base: string, body: unknown, token = "http-token", extraHeaders: Record<string, string> = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-03-26",
      ...extraHeaders
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    const payload = text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean).at(-1);
    return { status: res.status, json: JSON.parse(payload ?? "{}") as any };
  }
  return { status: res.status, json: JSON.parse(text) as any };
}

async function modernRpc(base: string, id: number, method: string, params: Record<string, unknown> = {}) {
  return rpc(base, {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1" }
      },
      ...params
    }
  }, "http-token", {
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method
  });
}

const expectedNames = [
  "arcsuite_describe_capabilities",
  "arcsuite_get_document",
  "arcsuite_get_document_content_info",
  "arcsuite_get_documents",
  "arcsuite_list_document_revisions",
  "arcsuite_list_folder",
  "arcsuite_read_document",
  "arcsuite_search_documents"
];

test("current MCP discovery envelope works over Streamable HTTP", async (t) => {
  const { rt, base } = await start();
  t.after(() => rt.server.close());
  const discovery = await modernRpc(base, 1, "server/discover");
  assert.equal(discovery.status, 200);
  assert.ok(discovery.json.result.supportedVersions.includes("2026-07-28"));

  const list = await modernRpc(base, 2, "tools/list");
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.result.tools.map((tool: { name: string }) => tool.name).sort(), expectedNames);
});

test("MCP initialize, profile-aware discovery and semantic search work over Streamable HTTP", async (t) => {
  const { rt, base } = await start();
  t.after(() => rt.server.close());
  const init = await rpc(base, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test-client", version: "1" } } });
  assert.equal(init.status, 200);
  assert.equal(init.json.result.protocolVersion, "2025-03-26");

  const list = await rpc(base, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.equal(list.status, 200);
  const tools = list.json.result.tools;
  assert.deepEqual(tools.map((tool: { name: string }) => tool.name).sort(), expectedNames);
  const search = tools.find((tool: { name: string }) => tool.name === "arcsuite_search_documents");
  assert.deepEqual(search.inputSchema.properties.scope.enum, ["example_documents"]);
  assert.match(search.description, /document_number/);

  const capabilities = await rpc(base, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "arcsuite_describe_capabilities", arguments: {} } });
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.json.result.structuredContent.scopes[0].id, "example_documents");

  const call = await rpc(base, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "arcsuite_search_documents", arguments: { scope: "example_documents", filters: { document_number: "DOC-000001" } } } });
  assert.equal(call.status, 200);
  assert.equal(call.json.result.structuredContent.count, 1);
  assert.equal(call.json.result.structuredContent.results[0].semantic_attributes.document_number, "DOC-000001");
});

test("MCP rejects unknown bearer token", async (t) => {
  const { rt, base } = await start();
  t.after(() => rt.server.close());
  const res = await rpc(base, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, "wrong");
  assert.equal(res.status, 401);
});

test("MCP rejects an untrusted browser Origin", async (t) => {
  const { rt, base } = await start();
  t.after(() => rt.server.close());
  const res = await rpc(base, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, "http-token", { origin: "https://untrusted.example.invalid" });
  assert.equal(res.status, 403);
});

test("MCP rejects a request body above the configured bound", async (t) => {
  const { rt, base } = await start({ MCP_MAX_REQUEST_BYTES: "1024" });
  t.after(() => rt.server.close());
  const res = await rpc(base, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: { padding: "x".repeat(2048) }
  });
  assert.equal(res.status, 413);
  assert.equal(res.json.error.code, -32600);
});
