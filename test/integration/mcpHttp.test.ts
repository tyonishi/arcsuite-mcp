import test from "node:test";
import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { ProfileStore, RateLimiter } from "../../src/mcp/auth.ts";
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

async function modernRpc(base: string, id: number, method: string, params: Record<string, unknown> = {}, token = "http-token") {
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
  }, token, {
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

test("read output schemas are advertised and validate bounded structured results over HTTP", async (t) => {
  const bearerValue = "issue43-bearer";
  const { rt, base } = await start({
    MCP_DEV_BEARER_TOKEN: "",
    MCP_READ_DEFAULT_MAX_CHARS: "1500",
    MCP_READ_MAX_CHARS: "2000",
    MCP_OPAQUE_REFS_ENABLED: "true",
    MCP_OPAQUE_REF_KEYS_JSON: JSON.stringify({
      active_kid: "issue43-test",
      keys: [{ kid: "issue43-test", secret_base64url: Buffer.alloc(32, 0x43).toString("base64url") }]
    }),
    ARCSUITE_MCP_CLIENT_TOKENS_JSON: JSON.stringify({ tokens: [{
      tokenSha256: createHash("sha256").update(bearerValue).digest("hex"),
      clientProfileId: "issue43-output-schema-test",
      allowedScopes: ["example_documents"],
      allowedTools: ["arcsuite_search_documents", "arcsuite_read_document", "arcsuite_read_document_by_ref"],
      requiredSearchResponseContract: "opaque_refs_v2",
      rateLimit: { requestsPerMinute: 120, burst: 30 }
    }] })
  });
  t.after(() => rt.server.close());

  const legacyList = await rpc(base, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, bearerValue);
  const modernList = await modernRpc(base, 2, "tools/list", {}, bearerValue);
  assert.equal(legacyList.status, 200);
  assert.equal(modernList.status, 200);

  const directProperties = [
    "cached", "content", "content_label", "content_type", "document_id", "extractor",
    "file_name", "next_cursor", "page_range", "revision_number", "truncated", "warnings"
  ];
  const refProperties = [
    "cached", "content", "content_label", "content_type", "extractor", "file_name",
    "next_cursor", "page_range", "result_ref", "revision_number", "truncated", "warnings"
  ];
  for (const listed of [legacyList, modernList]) {
    const tools = listed.json.result.tools;
    assert.deepEqual(tools.map((tool: { name: string }) => tool.name).sort(), [
      "arcsuite_read_document", "arcsuite_read_document_by_ref", "arcsuite_search_documents"
    ]);
    const byName = (name: string) => tools.find((tool: any) => tool.name === name);
    const directSchema = byName("arcsuite_read_document").outputSchema;
    const refSchema = byName("arcsuite_read_document_by_ref").outputSchema;
    assert.equal(directSchema.type, "object");
    assert.equal(directSchema.additionalProperties, false);
    assert.equal(directSchema.properties.content.maxLength, 2000);
    assert.deepEqual(Object.keys(directSchema.properties).sort(), directProperties);
    assert.deepEqual(directSchema.required, [
      "document_id", "content_label", "file_name", "content_type", "extractor", "content",
      "truncated", "next_cursor", "warnings", "cached"
    ]);
    assert.equal(refSchema.type, "object");
    assert.equal(refSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(refSchema.properties).sort(), refProperties);
    assert.equal(Object.hasOwn(refSchema.properties, "document_id"), false);
    assert.equal(Object.hasOwn(refSchema.properties, "open_url"), false);
    assert.deepEqual(refSchema.required, [
      "result_ref", "content_label", "file_name", "content_type", "extractor", "content",
      "truncated", "next_cursor", "warnings", "cached"
    ]);
    assert.deepEqual(byName("arcsuite_search_documents").inputSchema.properties.response_contract.enum,
      ["legacy", "opaque_refs_v1", "opaque_refs_v2"]);
    assert.equal(byName("arcsuite_search_documents").inputSchema.properties.response_contract.default, "opaque_refs_v2");
    assert.equal(Object.hasOwn(byName("arcsuite_search_documents").inputSchema.properties, "cursor"), false);
    assert.deepEqual(tools.filter((tool: any) => tool.outputSchema).map((tool: any) => tool.name).sort(), [
      "arcsuite_read_document", "arcsuite_read_document_by_ref"
    ]);
  }

  const profile = rt.config.tokenProfiles.find((item: any) => item.clientProfileId === "issue43-output-schema-test");
  assert.ok(profile);
  const definitions = rt.tools.list(profile);
  const directDefinition: any = definitions.find((tool: any) => tool.name === "arcsuite_read_document");
  const refDefinition: any = definitions.find((tool: any) => tool.name === "arcsuite_read_document_by_ref");

  const directCall = await rpc(base, {
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "arcsuite_read_document", arguments: { document_id: "rep:mock:EXAMPLE_CABINET:1001", max_chars: 1000 } }
  }, bearerValue);
  assert.equal(directCall.status, 200);
  assert.equal(directCall.json.result.isError, undefined, JSON.stringify(directCall.json));
  const direct = directCall.json.result.structuredContent;
  assert.equal(typeof direct.content, "string");
  assert.ok(direct.content.length > 0);
  assert.equal(directDefinition.outputSchema.safeParse(direct).success, true);
  const directText = directCall.json.result.content.find((item: any) => item.type === "text").text;
  assert.match(directText, /^ArcSuite document content \(/);
  assert.ok(directText.endsWith(direct.content));

  const searchCall = await rpc(base, {
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "arcsuite_search_documents", arguments: { scope: "example_documents", filters: { document_number: "DOC-000001" } } }
  }, bearerValue);
  assert.equal(searchCall.json.result.isError, undefined, JSON.stringify(searchCall.json));
  const resultRef = searchCall.json.result.structuredContent.results[0].result_ref;
  assert.equal(typeof resultRef, "string");

  const refCall = await rpc(base, {
    jsonrpc: "2.0", id: 5, method: "tools/call",
    params: { name: "arcsuite_read_document_by_ref", arguments: { result_ref: resultRef, max_chars: 1000 } }
  }, bearerValue);
  assert.equal(refCall.status, 200);
  assert.equal(refCall.json.result.isError, undefined, JSON.stringify(refCall.json));
  const ref = refCall.json.result.structuredContent;
  assert.equal(ref.result_ref, resultRef);
  assert.equal(Object.hasOwn(ref, "document_id"), false);
  assert.equal(Object.hasOwn(ref, "open_url"), false);
  assert.equal(typeof ref.content, "string");
  assert.ok(ref.content.length > 0);
  assert.equal(refDefinition.outputSchema.safeParse(ref).success, true);
  const refText = refCall.json.result.content.find((item: any) => item.type === "text").text;
  assert.match(refText, /^ArcSuite document content \(/);
  assert.ok(refText.endsWith(ref.content));
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
  assert.deepEqual(search.inputSchema.properties.response_contract.enum, ["legacy", "opaque_refs_v1", "opaque_refs_v2"]);
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

test("HTTP tools/list reflects required opaque_refs_v2 policy and preserves normal profiles", async (t) => {
  const strictToken = "test-token";
  const normalToken = "http-token";
  const makeProfile = (token: string, clientProfileId: string, required = false) => ({
    tokenSha256: createHash("sha256").update(token).digest("hex"),
    clientProfileId,
    allowedScopes: ["example_documents"],
    allowedTools: ["arcsuite_describe_capabilities", "arcsuite_search_documents"],
    rateLimit: { requestsPerMinute: 120, burst: 30 },
    ...(required ? { requiredSearchResponseContract: "opaque_refs_v2" } : {})
  });
  const strictProfileConfig = makeProfile(strictToken, "http-strict-v2", true);
  const normalProfileConfig = makeProfile(normalToken, "http-normal");
  const { rt, base } = await start({
    MCP_DEV_BEARER_TOKEN: "",
    MCP_OPAQUE_REFS_ENABLED: "true",
    MCP_OPAQUE_REF_KEYS_JSON: JSON.stringify({
      active_kid: "http-test",
      keys: [{ kid: "http-test", secret_base64url: Buffer.alloc(32, 0x42).toString("base64url") }]
    }),
    ARCSUITE_MCP_CLIENT_TOKENS_JSON: JSON.stringify({ tokens: [strictProfileConfig, normalProfileConfig] })
  });
  t.after(() => rt.server.close());

  const strictList = await rpc(base, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, strictToken);
  assert.equal(strictList.status, 200);
  const strictSearch: any = strictList.json.result.tools.find((tool: any) => tool.name === "arcsuite_search_documents");
  assert.deepEqual(strictSearch.inputSchema.properties.scope.enum, ["example_documents"]);
  assert.deepEqual(strictSearch.inputSchema.properties.response_contract.enum, ["legacy", "opaque_refs_v1", "opaque_refs_v2"]);
  assert.equal(strictSearch.inputSchema.properties.response_contract.default, "opaque_refs_v2");
  assert.equal(Object.hasOwn(strictSearch.inputSchema.properties, "cursor"), false);
  const strictProfile = rt.config.tokenProfiles.find((profile: any) => profile.clientProfileId === "http-strict-v2")!;
  const strictDefinition: any = rt.tools.list(strictProfile).find((tool: any) => tool.name === "arcsuite_search_documents");
  assert.equal(strictSearch.description, strictDefinition.description);
  assert.match(strictSearch.description, /requires opaque_refs_v2/);

  const normalList = await rpc(base, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, normalToken);
  assert.equal(normalList.status, 200);
  const normalSearch: any = normalList.json.result.tools.find((tool: any) => tool.name === "arcsuite_search_documents");
  assert.deepEqual(normalSearch.inputSchema.properties.scope.enum, ["example_documents"]);
  assert.deepEqual(normalSearch.inputSchema.properties.response_contract.enum, ["legacy", "opaque_refs_v1", "opaque_refs_v2"]);
  assert.equal(Object.hasOwn(normalSearch.inputSchema.properties, "cursor"), true);
  assert.equal(normalSearch.inputSchema.properties.response_contract.default, undefined);
  assert.match(normalSearch.inputSchema.properties.response_contract.description, /Omission selects legacy/);

  for (const [id, token] of [[3, strictToken], [4, normalToken]] as const) {
    const capabilities = await rpc(base, {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "arcsuite_describe_capabilities", arguments: {} }
    }, token);
    assert.equal(capabilities.status, 200);
    assert.equal(capabilities.json.result.structuredContent.version, "1.2");
  }

  let searchDispatches = 0;
  const originalSearchIds = (rt.adapter as any).searchIds.bind(rt.adapter);
  (rt.adapter as any).searchIds = async (...args: unknown[]) => {
    searchDispatches += 1;
    return originalSearchIds(...args);
  };
  const runtimeCalls: string[] = [];
  const originalToolCall = rt.tools.call.bind(rt.tools);
  (rt.tools as any).call = async (profile: unknown, name: string, args: unknown) => {
    runtimeCalls.push(name);
    return originalToolCall(profile as any, name, args);
  };
  let searchCallId = 5;
  const invokeStrictSearch = (arguments_: Record<string, unknown>) => rpc(base, {
    jsonrpc: "2.0",
    id: searchCallId++,
    method: "tools/call",
    params: { name: "arcsuite_search_documents", arguments: arguments_ }
  }, strictToken);

  const runtimeCallsBeforeDefault = runtimeCalls.length;
  const dispatchesBeforeDefault = searchDispatches;
  const defaultContractSearch = await invokeStrictSearch({
    scope: "example_documents",
    filters: { document_number: "DOC-000001" }
  });
  assert.equal(defaultContractSearch.status, 200);
  assert.equal(Boolean(defaultContractSearch.json.result?.isError), false, JSON.stringify(defaultContractSearch.json));
  assert.equal(runtimeCalls.length, runtimeCallsBeforeDefault + 1);
  assert.equal(runtimeCalls.at(-1), "arcsuite_search_documents");
  assert.equal(searchDispatches, dispatchesBeforeDefault + 1);
  searchDispatches = 0;
  const defaultContractResult: any = defaultContractSearch.json.result.structuredContent.results[0];
  assert.equal(typeof defaultContractResult.result_ref, "string");
  assert.equal(Object.hasOwn(defaultContractResult, "document_id"), false);
  assert.equal(JSON.stringify(defaultContractSearch.json.result).includes("rep:mock:EXAMPLE_CABINET:1001"), false);

  for (const responseContract of ["legacy", "opaque_refs_v1"]) {
    const runtimeCallsBeforeDowngrade = runtimeCalls.length;
    const dispatchesBeforeDowngrade = searchDispatches;
    assert.equal(dispatchesBeforeDowngrade, 0);
    const rejectedDowngrade = await invokeStrictSearch({
      scope: "example_documents",
      filters: { document_number: "DOC-000001" },
      response_contract: responseContract
    });
    assert.equal(rejectedDowngrade.status, 200);
    assert.equal(rejectedDowngrade.json.result?.isError, true, JSON.stringify(rejectedDowngrade.json));
    const downgradeError = JSON.parse(rejectedDowngrade.json.result.content[0].text);
    assert.equal(downgradeError.code, "ARCSUITE_INVALID_ARGUMENT");
    assert.equal(downgradeError.category, "search_response_contract_required");
    assert.equal(runtimeCalls.length, runtimeCallsBeforeDowngrade + 1);
    assert.equal(runtimeCalls.at(-1), "arcsuite_search_documents");
    assert.equal(searchDispatches, 0);
  }

  const runtimeCallsBeforeCursor = runtimeCalls.length;
  const dispatchesBeforeCursor = searchDispatches;
  assert.equal(dispatchesBeforeCursor, 0);
  const rawCursorRejected = await invokeStrictSearch({
    scope: "example_documents",
    cursor: "raw-test-cursor"
  });
  assert.equal(rawCursorRejected.json.result?.isError, true, JSON.stringify(rawCursorRejected.json));
  assert.match(rawCursorRejected.json.result.content[0].text, /^Input validation error:/);
  assert.match(rawCursorRejected.json.result.content[0].text, /Unrecognized key: "cursor"/);
  assert.equal(runtimeCalls.length, runtimeCallsBeforeCursor, "raw cursor must fail HTTP/SDK validation before ToolRegistry.call");
  assert.equal(searchDispatches, 0, "raw cursor must not dispatch to the provider");
  const legacySearch = await rpc(base, {
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: {
      name: "arcsuite_search_documents",
      arguments: { scope: "example_documents", filters: { document_number: "DOC-000001" } }
    }
  }, normalToken);
  assert.equal(legacySearch.status, 200);
  assert.equal(typeof legacySearch.json.result.structuredContent.results[0].document_id, "string");
  assert.equal(Object.hasOwn(legacySearch.json.result.structuredContent.results[0], "result_ref"), false);
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


test("invalid request-target parsing is contained before authentication", async (t) => {
  const { rt, base } = await start();
  t.after(() => rt.server.close());
  const authenticate = t.mock.method(ProfileStore.prototype, "authenticate");
  const limit = t.mock.method(RateLimiter.prototype, "allow");
  const dispatch = t.mock.method(rt.tools, "call");
  const socket = new Socket();
  t.after(() => socket.destroy());
  const request = new IncomingMessage(socket);
  request.method = "GET";
  request.url = "http://[invalid";
  request.headers = { host: "localhost" };
  const response = new ServerResponse(request);
  let body = "";
  const head = t.mock.method(response, "writeHead");
  const end = t.mock.method(response, "end", function (chunk?: unknown) {
    body = String(chunk ?? "");
    return response;
  });

  // Invoke the registered listener directly; no malformed traffic is sent.
  assert.doesNotThrow(() => rt.server.emit("request", request, response));
  assert.equal(response.statusCode, 400);
  assert.deepEqual(head.mock.calls[0]?.arguments, [400, { "content-type": "application/json; charset=utf-8" }]);
  assert.equal(end.mock.callCount(), 1);
  assert.deepEqual(JSON.parse(body), { error: "invalid_request_target" });
  assert.equal(authenticate.mock.callCount(), 0);
  assert.equal(limit.mock.callCount(), 0);
  assert.equal(dispatch.mock.callCount(), 0);

  assert.equal((await fetch(`${base}/healthz?probe=1`)).status, 200);
  assert.equal((await fetch(`${base}/readyz?probe=1`)).status, 200);
  assert.equal((await fetch(`${base}/unknown?probe=1`)).status, 404);
  assert.equal((await fetch(`${base}/mcp?probe=1`)).status, 401);
  const normal = await modernRpc(base, 90, "tools/list");
  assert.equal(normal.status, 200);
  assert.deepEqual(normal.json.result.tools.map((tool: { name: string }) => tool.name).sort(), expectedNames);
});
