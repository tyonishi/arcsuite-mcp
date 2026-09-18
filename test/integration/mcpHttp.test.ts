import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  "arcsuite_list_hard_references",
  "arcsuite_read_document",
  "arcsuite_search_documents",
  "arcsuite_validate_document_integrity"
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
  for (const name of ["arcsuite_get_document", "arcsuite_get_document_content_info", "arcsuite_read_document"]) {
    const tool: any = list.json.result.tools.find((item: any) => item.name === name);
    if (name === "arcsuite_read_document") {
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(Object.hasOwn(tool.inputSchema, "anyOf"), false);
      assert.equal(Object.hasOwn(tool.inputSchema, "oneOf"), false);
      assert.ok(tool.inputSchema.required.includes("document_id"));
      assert.equal(tool.inputSchema.properties.revision_number.minimum, 1);
      assert.equal(tool.inputSchema.properties.revision_number.maximum, 2147483647);
      assert.equal(tool.inputSchema.properties.start_page.maximum, 1_000_000);
      assert.equal(tool.inputSchema.properties.end_page.maximum, 1_000_000);
    } else {
      assert.equal(tool.inputSchema.properties.revision_number.minimum, 1);
      assert.equal(tool.inputSchema.properties.revision_number.maximum, 2147483647);
    }
  }
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
  assert.deepEqual(search.inputSchema.properties.text_search_mode.enum, ["none", "stemming", "thesaurus"]);
  assert.match(JSON.stringify(search.inputSchema.properties.filters), /operator/);
  assert.match(search.description, /document_number/);
  assert.equal(search.description.includes("applied_query"), false);
  assert.equal(Object.hasOwn(search.inputSchema.properties, "applied_query"), false);
  assert.deepEqual(Object.keys(search.inputSchema.properties).sort(), [
    "cursor", "filters", "include_path", "limit", "query", "query_mode", "response_contract", "scope", "text_search_mode"
  ]);
  assert.deepEqual(search.inputSchema.properties.response_contract.enum, ["legacy", "opaque_refs_v1"]);
  const hardReferences = tools.find((tool: { name: string }) => tool.name === "arcsuite_list_hard_references");
  assert.equal(hardReferences.inputSchema.type, "object");
  assert.equal(hardReferences.inputSchema.additionalProperties, false);
  assert.deepEqual(hardReferences.inputSchema.required, ["document_id"]);
  assert.ok(hardReferences.inputSchema.properties.limit);
  assert.ok(hardReferences.inputSchema.properties.cursor);
  assert.equal(Object.hasOwn(hardReferences.inputSchema, "anyOf"), false);
  assert.equal(Object.hasOwn(hardReferences.inputSchema, "oneOf"), false);
  const integrity = tools.find((tool: { name: string }) => tool.name === "arcsuite_validate_document_integrity");
  assert.deepEqual(integrity.inputSchema.required, ["document_id"]);
  assert.equal(integrity.inputSchema.properties.include_evidence.default, false);
  assert.equal(integrity.inputSchema.additionalProperties, false);

  const capabilities = await rpc(base, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "arcsuite_describe_capabilities", arguments: {} } });
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.json.result.structuredContent.scopes[0].id, "example_documents");

  const call = await rpc(base, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "arcsuite_search_documents", arguments: { scope: "example_documents", filters: { document_number: "DOC-000001" } } } });
  assert.equal(call.status, 200);
  assert.equal(call.json.result.structuredContent.count, 1);
  assert.equal(call.json.result.structuredContent.results[0].semantic_attributes.document_number, "DOC-000001");

  const typedCall = await rpc(base, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "arcsuite_search_documents", arguments: { scope: "example_documents", query: "DOC", text_search_mode: "thesaurus", filters: { page_count: { operator: "gte", value: 10 } } } } });
  assert.equal(typedCall.status, 200);
  assert.equal(typedCall.json.result.structuredContent.count, 1);

  const relationships = await rpc(base, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "arcsuite_list_hard_references", arguments: { document_id: "rep:mock:EXAMPLE_CABINET:1001" } } });
  assert.equal(relationships.status, 200);
  assert.equal(relationships.json.result.structuredContent.relationship, "hard_reference_incoming");
  assert.equal(relationships.json.result.structuredContent.count, 2);
  assert.equal(JSON.stringify(relationships.json.result.structuredContent).includes("hardref-001"), false);

  const integrityCall = await rpc(base, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "arcsuite_validate_document_integrity", arguments: { document_id: "rep:mock:EXAMPLE_CABINET:1001" } } });
  assert.equal(integrityCall.status, 200);
  assert.equal(integrityCall.json.result.structuredContent.status, "valid");
  assert.equal(Object.hasOwn(integrityCall.json.result.structuredContent, "evidence"), false);

  const integrityEvidenceCall = await rpc(base, { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "arcsuite_validate_document_integrity", arguments: { document_id: "rep:mock:EXAMPLE_CABINET:1001", include_evidence: true } } });
  assert.equal(integrityEvidenceCall.status, 200);
  assert.deepEqual(integrityEvidenceCall.json.result.structuredContent.evidence, [
    { cert_id: 101, evidence_available: true },
    { cert_id: 102, evidence_available: false }
  ]);

  const invalidIntegrityCall = await rpc(base, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "arcsuite_validate_document_integrity", arguments: { document_id: "rep:mock:EXAMPLE_CABINET:1002" } } });
  assert.equal(invalidIntegrityCall.status, 200);
  assert.equal(invalidIntegrityCall.json.result.structuredContent.status, "invalid_or_unverifiable");
  assert.deepEqual(invalidIntegrityCall.json.result.structuredContent.warnings, ["VALIDATION_NOT_PROVEN"]);
});

test("tools/list advertises effective request limits and rejects over-limit calls before runtime dispatch", async (t) => {
  const { rt, base } = await start({
    MCP_BATCH_MAX_IDS: "3",
    MCP_SEARCH_DEFAULT_LIMIT: "4",
    MCP_SEARCH_MAX_LIMIT: "5",
    MCP_READ_DEFAULT_MAX_CHARS: "1500",
    MCP_READ_MAX_CHARS: "2000"
  });
  t.after(() => rt.server.close());

  const listed = await rpc(base, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  assert.equal(listed.status, 200);
  const tools = listed.json.result.tools;
  const byName = (name: string) => tools.find((tool: any) => tool.name === name);
  assert.equal(byName("arcsuite_get_documents").inputSchema.properties.document_ids.maxItems, 3);
  assert.match(byName("arcsuite_get_documents").description, /Maximum batch size: 3/);
  assert.equal(byName("arcsuite_search_documents").inputSchema.properties.limit.maximum, 5);
  assert.equal(byName("arcsuite_list_folder").inputSchema.properties.limit.maximum, 5);
  assert.equal(byName("arcsuite_list_document_revisions").inputSchema.properties.limit.maximum, 5);
  assert.equal(byName("arcsuite_list_hard_references").inputSchema.properties.limit.maximum, 5);
  const readSchema = byName("arcsuite_read_document").inputSchema;
  assert.equal(readSchema.type, "object");
  assert.equal(readSchema.properties.max_chars.maximum, 2000);
  assert.equal(readSchema.properties.start_page.maximum, 1_000_000);
  assert.equal(readSchema.properties.end_page.maximum, 1_000_000);
  assert.equal(readSchema.properties.revision_number.minimum, 1);
  assert.equal(readSchema.properties.revision_number.maximum, 2147483647);
  assert.equal(Object.hasOwn(readSchema, "anyOf"), false);
  assert.equal(Object.hasOwn(readSchema, "oneOf"), false);
  const forbiddenPageKeys = (branch: any): string[] => {
    if (Array.isArray(branch.not?.anyOf)) return branch.not.anyOf.flatMap((item: any) => item.required ?? []).sort();
    if (Array.isArray(branch.not?.required)) return [...branch.not.required].sort();
    return ["start_page", "end_page", "cursor"].filter((key) => branch.properties?.[key]?.not !== undefined).sort();
  };
  const expectedForbiddenPageKeys = [
    ["cursor"],
    ["cursor", "end_page"],
    ["end_page", "start_page"],
    ["cursor", "end_page", "start_page"]
  ].sort((a, b) => a.join().localeCompare(b.join()));
  const sortForbiddenPageKeys = (value: string[][]) => value.sort((a, b) => a.join().localeCompare(b.join()));
  assert.equal(readSchema.allOf.length, 2);
  const manualReadSchema: any = rt.tools.list(rt.config.tokenProfiles[0]).find((tool) => tool.name === "arcsuite_read_document");
  assert.deepEqual(sortForbiddenPageKeys(manualReadSchema.inputSchema.anyOf.map(forbiddenPageKeys)), expectedForbiddenPageKeys);
  assert.ok(readSchema.required.includes("document_id"));
  const revisionDefinition: any = rt.tools.list(rt.config.tokenProfiles[0]).find((tool) => tool.name === "arcsuite_list_document_revisions");
  assert.equal(revisionDefinition.inputSchema.properties.limit.default, 4);

  const adapter: any = rt.adapter;
  const providerCalls = { searchIds: 0, listIds: 0, revisions: 0, hardReferences: 0, getMany: 0, content: 0 };
  for (const method of Object.keys(providerCalls) as Array<keyof typeof providerCalls>) {
    const original = adapter[method].bind(adapter);
    adapter[method] = async (...args: unknown[]) => {
      providerCalls[method] += 1;
      return original(...args);
    };
  }
  const runtimeCalls: string[] = [];
  const originalToolCall = rt.tools.call.bind(rt.tools);
  (rt.tools as any).call = async (profile: unknown, name: string, args: unknown) => {
    runtimeCalls.push(name);
    return originalToolCall(profile as any, name, args);
  };
  const invoke = (id: number, name: string, args: Record<string, unknown>) => rpc(base, {
    jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args }
  });

  for (const arguments_ of [
    { document_id: "rep:mock:EXAMPLE_CABINET:1001", cursor: "opaque", start_page: 1 },
    { document_id: "rep:mock:EXAMPLE_CABINET:1001", end_page: 2 },
    { document_id: "rep:mock:EXAMPLE_CABINET:1001", start_page: 3, end_page: 2 }
  ]) {
    const rejected = await invoke(1, "arcsuite_read_document", arguments_);
    assert.ok(rejected.json.error || rejected.json.result?.isError, JSON.stringify(rejected.json));
  }

  const accepted = await Promise.all([
    invoke(2, "arcsuite_search_documents", { scope: "example_documents", query: "DOC", limit: 5 }),
    invoke(3, "arcsuite_list_folder", { scope: "example_documents", limit: 5 }),
    invoke(4, "arcsuite_list_document_revisions", { document_id: "rep:mock:EXAMPLE_CABINET:1001", limit: 5 }),
    invoke(5, "arcsuite_list_hard_references", { document_id: "rep:mock:EXAMPLE_CABINET:1001", limit: 5 }),
    invoke(6, "arcsuite_get_documents", {
      scope: "example_documents",
      document_ids: [
        "rep:mock:EXAMPLE_CABINET:1001",
        "rep:mock:EXAMPLE_CABINET:1002",
        "rep:mock:EXAMPLE_CABINET:1003"
      ]
    }),
    invoke(7, "arcsuite_read_document", { document_id: "rep:mock:EXAMPLE_CABINET:1001", max_chars: 2000 })
  ]);
  for (const response of accepted) {
    assert.equal(response.status, 200);
    assert.equal(Boolean(response.json.result?.isError), false, JSON.stringify(response.json));
  }
  assert.deepEqual(providerCalls, {
    searchIds: 1,
    listIds: 1,
    revisions: 1,
    hardReferences: 1,
    // Search and folder discovery classify their bounded candidate sets before
    // the ordinary page hydration counted by the existing paths below.
    getMany: 6,
    content: 1
  });

  const defaultRevision = await invoke(14, "arcsuite_list_document_revisions", { document_id: "rep:mock:EXAMPLE_CABINET:1001" });
  assert.equal(Boolean(defaultRevision.json.result?.isError), false, JSON.stringify(defaultRevision.json));
  assert.equal(defaultRevision.json.result.structuredContent.limit, 4, "runtime default must match the configured schema default");

  const callsBeforeOverLimit = runtimeCalls.length;
  const rejected = await Promise.all([
    invoke(8, "arcsuite_search_documents", { scope: "example_documents", query: "DOC", limit: 6 }),
    invoke(9, "arcsuite_list_folder", { scope: "example_documents", limit: 6 }),
    invoke(10, "arcsuite_list_document_revisions", { document_id: "rep:mock:EXAMPLE_CABINET:1001", limit: 6 }),
    invoke(11, "arcsuite_list_hard_references", { document_id: "rep:mock:EXAMPLE_CABINET:1001", limit: 6 }),
    invoke(12, "arcsuite_get_documents", {
      scope: "example_documents",
      document_ids: [
        "rep:mock:EXAMPLE_CABINET:1001",
        "rep:mock:EXAMPLE_CABINET:1002",
        "rep:mock:EXAMPLE_CABINET:1003",
        "rep:mock:EXAMPLE_CABINET:1004"
      ]
    }),
    invoke(13, "arcsuite_read_document", { document_id: "rep:mock:EXAMPLE_CABINET:1001", max_chars: 2001 }),
    invoke(15, "arcsuite_read_document", { document_id: "rep:mock:EXAMPLE_CABINET:1001", start_page: 1, end_page: 2, cursor: "opaque" }),
    invoke(16, "arcsuite_read_document", { document_id: "rep:mock:EXAMPLE_CABINET:1001", end_page: 2 }),
    invoke(17, "arcsuite_read_document", { document_id: "rep:mock:EXAMPLE_CABINET:1001", start_page: 1_000_001 }),
    invoke(18, "arcsuite_read_document", { document_id: "rep:mock:EXAMPLE_CABINET:1001", cursor: "opaque", start_page: 1 }),
    invoke(19, "arcsuite_list_hard_references", { document_id: "rep:mock:EXAMPLE_CABINET:1001", limit: 1, cursor: "opaque" })
  ]);
  assert.ok(rejected.every((response) => response.json.error || response.json.result?.isError));
  assert.equal(runtimeCalls.length, callsBeforeOverLimit, "invalid tool input must not reach ToolRegistry.call");
  assert.deepEqual(providerCalls, { searchIds: 1, listIds: 1, revisions: 2, hardReferences: 1, getMany: 6, content: 1 });
});

test("ref-native read combinations are accepted or rejected before runtime dispatch exactly as advertised", async (t) => {
  const token = "http-token";
  const { rt, base } = await start({
    MCP_OPAQUE_REFS_ENABLED: "true",
    MCP_OPAQUE_REF_KEYS_JSON: JSON.stringify({
      active_kid: "http-test",
      keys: [{ kid: "http-test", secret_base64url: Buffer.alloc(32, 0x42).toString("base64url") }]
    }),
    ARCSUITE_MCP_CLIENT_TOKENS_JSON: JSON.stringify({ tokens: [{
      tokenSha256: createHash("sha256").update(token).digest("hex"),
      clientProfileId: "http-p2-profile",
      allowedScopes: ["example_documents"],
      allowedTools: ["arcsuite_read_document_by_ref"],
      rateLimit: { requestsPerMinute: 120, burst: 30 }
    }] })
  });
  t.after(() => rt.server.close());

  let runtimeCalls = 0;
  const originalToolCall = rt.tools.call.bind(rt.tools);
  (rt.tools as any).call = async (profile: unknown, name: string, args: unknown) => {
    runtimeCalls += 1;
    return originalToolCall(profile as any, name, args);
  };
  const invoke = (id: number, arguments_: Record<string, unknown>) => rpc(base, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "arcsuite_read_document_by_ref", arguments: arguments_ }
  });

  let id = 1;
  for (const arguments_ of [
    { result_ref: "synthetic-ref" },
    { result_ref: "synthetic-ref", max_chars: 1000 },
    { result_ref: "synthetic-ref", start_page: 1 },
    { result_ref: "synthetic-ref", start_page: 1, end_page: 2 },
    { result_ref: "synthetic-ref", cursor: "synthetic-cursor" }
  ]) {
    const before = runtimeCalls;
    const response = await invoke(id++, arguments_);
    assert.equal(response.status, 200);
    assert.equal(response.json.result?.isError, true, JSON.stringify(response.json));
    assert.equal(runtimeCalls, before + 1, JSON.stringify(arguments_));
  }

  for (const arguments_ of [
    { result_ref: "synthetic-ref", cursor: "synthetic-cursor", start_page: 1 },
    { result_ref: "synthetic-ref", cursor: "synthetic-cursor", end_page: 2 },
    { result_ref: "synthetic-ref", start_page: 5, end_page: 4 },
    { result_ref: "synthetic-ref", end_page: 5 },
    { result_ref: "synthetic-ref", unknown: true }
  ]) {
    const before = runtimeCalls;
    const response = await invoke(id++, arguments_);
    assert.ok(response.json.error || response.json.result?.isError, JSON.stringify(response.json));
    assert.equal(runtimeCalls, before, JSON.stringify(arguments_));
  }
});

test("actual tools/call enforces the advertised revision maximum before provider dispatch", async (t) => {
  const { rt, base } = await start();
  t.after(() => rt.server.close());
  const list = await rpc(base, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const getTool: any = list.json.result.tools.find((item: any) => item.name === "arcsuite_get_document");
  assert.equal(getTool.inputSchema.properties.revision_number.maximum, 2147483647);
  let providerCalls = 0;
  const originalGet = (rt.adapter as any).get.bind(rt.adapter);
  (rt.adapter as any).get = async (...args: unknown[]) => {
    providerCalls += 1;
    return originalGet(...args);
  };
  const accepted = await rpc(base, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "arcsuite_get_document", arguments: { document_id: "rep:mock:EXAMPLE_CABINET:1001", revision_number: 2147483647 } }
  });
  assert.equal(Boolean(accepted.json.result?.isError), false, JSON.stringify(accepted.json));
  assert.equal(providerCalls, 1);
  const beforeRejected = providerCalls;
  const rejected = await rpc(base, {
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "arcsuite_get_document", arguments: { document_id: "rep:mock:EXAMPLE_CABINET:1001", revision_number: 2147483648 } }
  });
  assert.ok(rejected.json.error || rejected.json.result?.isError);
  assert.equal(providerCalls, beforeRejected);
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
