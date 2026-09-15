import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRuntime } from "../../src/server.ts";
import type { AdapterGetManyResult, AdapterRepositoryObject } from "../../src/arcsuite/types.ts";

async function runtime(scopeFile = resolve("config/scopes.mock.yaml"), overrides: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "arcsuite-mcp-semantic-search-"));
  return buildRuntime({
    ...process.env,
    NODE_ENV: "test",
    ARCSUITE_ADAPTER_MODE: "mock",
    MCP_DEV_BEARER_TOKEN: "test-token",
    MCP_SCOPES_FILE: scopeFile,
    MCP_SHARED_TEMP_DIR: join(dir, "shared"),
    MCP_AUDIT_LOG_PATH: join(dir, "audit.jsonl"),
    MCP_CURSOR_HMAC_SECRET: "0123456789abcdef0123456789abcdef",
    MCP_VALIDATE_ON_STARTUP: "true",
    ...overrides
  });
}

function profile() {
  return {
    clientProfileId: "dev-profile",
    allowedScopes: ["example_documents"],
    allowedTools: ["arcsuite_search_documents"],
    rateLimit: { requestsPerMinute: 120, burst: 30 }
  } as any;
}

function document(id: string, attributes: Record<string, any>): AdapterRepositoryObject {
  return {
    id,
    objectClass: "document",
    nativeObjectClass: { ns: "rep", name: "system:document" },
    attributes
  };
}

const baseAttributes = {
  "rep:system:name": { type: "string", value: "synthetic.pdf" },
  "rep:user:example_document_number": { type: "string", value: "DOC-000001" },
  "rep:system:modifiedon": { type: "datetime", value: "2026-09-01T03:00:00Z" },
  "rep:user:page_count": { type: "long", value: 10 },
  "rep:user:approved": { type: "boolean", value: true },
  "rep:user:quality_score": { type: "double", value: 0.95 },
  "rep:user:published_on": { type: "date", value: "2026-09-01" },
  "rep:system:status": { type: "i18n", ns: "rep", name: "ACTIVE" }
} as const;

function installSearch(adapter: any, ids: string[], objects: AdapterRepositoryObject[], failures: AdapterGetManyResult["failures"] = []) {
  adapter.searchIds = async () => ids;
  adapter.getMany = async () => ({ objects, failures });
}

test("string equality mismatch fails the whole search call", async () => {
  const rt = await runtime();
  installSearch(rt.adapter, ["rep:mock:EXAMPLE_CABINET:synthetic-1"], [document("rep:mock:EXAMPLE_CABINET:synthetic-1", {
    ...baseAttributes,
    "rep:user:example_document_number": { type: "string", value: "DOC-OTHER" }
  })]);

  await assert.rejects(
    () => rt.tools.call(profile(), "arcsuite_search_documents", {
      scope: "example_documents",
      filters: { document_number: "DOC-000001" }
    }),
    (error: any) => error?.stableCode === "ARCSUITE_UPSTREAM_ERROR" && error?.category === "upstream_error"
  );
  const audit = JSON.parse((await readFile(rt.config.auditLogPath, "utf8")).trim().split("\n").at(-1)!);
  assert.equal(audit.search_outcome, "predicate_mismatch");
  assert.equal(JSON.stringify(audit).includes("user:example_document_number"), false);
  rt.stopValidationRetry();
});

test("numeric and boolean mismatches fail closed instead of becoming zero results", async () => {
  for (const [filter, value] of [
    [{ page_count: 10 }, { type: "long", value: 9 }],
    [{ approved: true }, { type: "boolean", value: false }]
  ] as const) {
    const rt = await runtime();
    const id = "rep:mock:EXAMPLE_CABINET:synthetic-1";
    const key = Object.keys(value)[0] === "type" && "page_count" in filter ? "rep:user:page_count" : "rep:user:approved";
    installSearch(rt.adapter, [id], [document(id, { ...baseAttributes, [key]: value as any })]);
    await assert.rejects(() => rt.tools.call(profile(), "arcsuite_search_documents", { scope: "example_documents", filters: filter }), /ARCSUITE_UPSTREAM_ERROR/);
    rt.stopValidationRetry();
  }
});

test("missing or malformed verification attributes fail rather than returning count zero", async () => {
  const id = "rep:mock:EXAMPLE_CABINET:synthetic-1";
  for (const attributes of [
    { ...baseAttributes, "rep:user:page_count": undefined },
    { ...baseAttributes, "rep:user:page_count": { type: "string", value: "10" } }
  ]) {
    const rt = await runtime();
    installSearch(rt.adapter, [id], [document(id, attributes as any)]);
    await assert.rejects(() => rt.tools.call(profile(), "arcsuite_search_documents", { scope: "example_documents", filters: { page_count: 10 } }), /ARCSUITE_UPSTREAM_ERROR/);
    const audit = JSON.parse((await readFile(rt.config.auditLogPath, "utf8")).trim().split("\n").at(-1)!);
    assert.equal(audit.search_outcome, "metadata_unverifiable");
    rt.stopValidationRetry();
  }
});

test("verification-only attributes are unioned into hydration and never exposed", async () => {
  const rt = await runtime();
  const id = "rep:mock:EXAMPLE_CABINET:synthetic-1";
  let requested: any[] = [];
  rt.adapter.searchIds = async () => [id];
  rt.adapter.getMany = async (request: any) => {
    requested = request.attrIds;
    return { objects: [document(id, baseAttributes)], failures: [] };
  };
  const result: any = (await rt.tools.call(profile(), "arcsuite_search_documents", {
    scope: "example_documents",
    filters: { page_count: { operator: "gte", value: 10 } }
  })).structuredContent;
  assert.ok(requested.some((attr) => attr.ns === "rep" && attr.name === "user:page_count"));
  assert.equal(new Set(requested.map((attr) => `${attr.ns}:${attr.name}`)).size, requested.length);
  assert.equal(JSON.stringify(result).includes("user:page_count"), false);
  assert.equal(result.results[0].semantic_attributes.page_count, 10);
  assert.deepEqual(result.failures, []);
  const audit = JSON.parse((await readFile(rt.config.auditLogPath, "utf8")).trim().split("\n").at(-1)!);
  assert.equal(audit.search_outcome, "matches");
  rt.stopValidationRetry();
});

test("LIKE and full-text results remain provider-authoritative", async () => {
  const id = "rep:mock:EXAMPLE_CABINET:synthetic-1";
  for (const args of [
    { scope: "example_documents", filters: { name: "*.pdf" } },
    { scope: "example_documents", query: "provider-indexed-term" }
  ]) {
    const rt = await runtime();
    installSearch(rt.adapter, [id], [document(id, { ...baseAttributes, "rep:system:name": { type: "string", value: "provider-authoritative.txt" } })]);
    const result: any = (await rt.tools.call(profile(), "arcsuite_search_documents", args)).structuredContent;
    assert.equal(result.count, 1);
    assert.equal(result.results[0].document_id, id);
    rt.stopValidationRetry();
  }
});

test("one mismatch among multiple results prevents a partial successful page", async () => {
  const rt = await runtime();
  const first = "rep:mock:EXAMPLE_CABINET:synthetic-1";
  const second = "rep:mock:EXAMPLE_CABINET:synthetic-2";
  installSearch(rt.adapter, [first, second], [
    document(first, baseAttributes),
    document(second, { ...baseAttributes, "rep:user:page_count": { type: "long", value: 4 } })
  ]);
  await assert.rejects(() => rt.tools.call(profile(), "arcsuite_search_documents", { scope: "example_documents", filters: { page_count: { operator: "gte", value: 10 } } }), /ARCSUITE_UPSTREAM_ERROR/);
  rt.stopValidationRetry();
});

test("deterministic searches fail atomically when any candidate cannot be hydrated", async () => {
  const rt = await runtime();
  const id = "rep:mock:EXAMPLE_CABINET:synthetic-1";
  const failedId = "rep:mock:EXAMPLE_CABINET:synthetic-2";
  installSearch(rt.adapter, [id, failedId], [document(id, baseAttributes)], [{ index: 1, code: "ARCSUITE_NOT_AVAILABLE" }]);
  await assert.rejects(() => rt.tools.call(profile(), "arcsuite_search_documents", { scope: "example_documents", filters: { page_count: 10 } }), /ARCSUITE_UPSTREAM_ERROR/);
  const audit = JSON.parse((await readFile(rt.config.auditLogPath, "utf8")).trim().split("\n").at(-1)!);
  assert.equal(audit.search_outcome, "hydration_failure");
  rt.stopValidationRetry();
});

test("provider failures remain distinct from successful zero results", async () => {
  const rt = await runtime();
  rt.adapter.searchIds = async () => { throw new Error("synthetic provider fault"); };
  await assert.rejects(() => rt.tools.call(profile(), "arcsuite_search_documents", { scope: "example_documents", query: "provider-term" }), /ARCSUITE_UPSTREAM_ERROR/);
  const audit = JSON.parse((await readFile(rt.config.auditLogPath, "utf8")).trim().split("\n").at(-1)!);
  assert.equal(audit.search_outcome, "provider_failure");
  rt.stopValidationRetry();
});

test("LIKE-only searches retain per-ID hydration failures", async () => {
  const rt = await runtime();
  const id = "rep:mock:EXAMPLE_CABINET:synthetic-1";
  const failedId = "rep:mock:EXAMPLE_CABINET:synthetic-2";
  installSearch(rt.adapter, [id, failedId], [document(id, baseAttributes)], [{ index: 1, code: "ARCSUITE_NOT_AVAILABLE" }]);
  const result: any = (await rt.tools.call(profile(), "arcsuite_search_documents", { scope: "example_documents", filters: { name: "*.pdf" } })).structuredContent;
  assert.equal(result.count, 1);
  assert.deepEqual(result.failures, [{ index: 1, document_id: failedId, code: "ARCSUITE_NOT_AVAILABLE" }]);
  const audit = JSON.parse((await readFile(rt.config.auditLogPath, "utf8")).trim().split("\n").at(-1)!);
  assert.equal(audit.search_outcome, "matches");
  rt.stopValidationRetry();
});

test("full-text-only searches retain per-ID hydration failures", async () => {
  const rt = await runtime();
  const id = "rep:mock:EXAMPLE_CABINET:synthetic-1";
  const failedId = "rep:mock:EXAMPLE_CABINET:synthetic-2";
  installSearch(rt.adapter, [id, failedId], [document(id, baseAttributes)], [{ index: 1, code: "ARCSUITE_NOT_AVAILABLE" }]);
  const result: any = (await rt.tools.call(profile(), "arcsuite_search_documents", {
    scope: "example_documents",
    query: "provider-indexed-term",
    text_search_mode: "stemming"
  })).structuredContent;
  assert.equal(result.count, 1);
  assert.deepEqual(result.failures, [{ index: 1, document_id: failedId, code: "ARCSUITE_NOT_AVAILABLE" }]);
  const audit = JSON.parse((await readFile(rt.config.auditLogPath, "utf8")).trim().split("\n").at(-1)!);
  assert.equal(audit.search_outcome, "matches");
  rt.stopValidationRetry();
});

test("all provider hydration failures are distinct from a successful zero result", async () => {
  const rt = await runtime();
  const failedId = "rep:mock:EXAMPLE_CABINET:synthetic-2";
  installSearch(rt.adapter, [failedId], [], [{ index: 0, code: "ARCSUITE_NOT_AVAILABLE" }]);
  const result: any = (await rt.tools.call(profile(), "arcsuite_search_documents", {
    scope: "example_documents",
    query: "provider-indexed-term",
    text_search_mode: "stemming"
  })).structuredContent;
  assert.equal(result.count, 0);
  assert.deepEqual(result.failures, [{ index: 0, document_id: failedId, code: "ARCSUITE_NOT_AVAILABLE" }]);
  const audit = JSON.parse((await readFile(rt.config.auditLogPath, "utf8")).trim().split("\n").at(-1)!);
  assert.equal(audit.result_code, "OK");
  assert.equal(audit.search_outcome, "hydration_failure");
  rt.stopValidationRetry();
});

test("provider empty IDs remain a successful zero result", async () => {
  const rt = await runtime();
  let hydrated = false;
  rt.adapter.searchIds = async () => [];
  rt.adapter.getMany = async () => { hydrated = true; return { objects: [], failures: [] }; };
  const result: any = (await rt.tools.call(profile(), "arcsuite_search_documents", { scope: "example_documents", filters: { page_count: 10 } })).structuredContent;
  assert.equal(result.count, 0);
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.failures, []);
  assert.equal(hydrated, false);
  const audit = JSON.parse((await readFile(rt.config.auditLogPath, "utf8")).trim().split("\n").at(-1)!);
  assert.equal(audit.search_outcome, "zero");
  rt.stopValidationRetry();
});

test("search response keeps the existing public top-level shape", async () => {
  const rt = await runtime();
  const id = "rep:mock:EXAMPLE_CABINET:synthetic-1";
  installSearch(rt.adapter, [id], [document(id, baseAttributes)]);
  const result: any = (await rt.tools.call(profile(), "arcsuite_search_documents", { scope: "example_documents", query: "provider-term" })).structuredContent;
  assert.deepEqual(Object.keys(result).sort(), ["count", "failures", "limit", "next_cursor", "results", "scope", "snapshot_limited", "truncated"]);
  assert.equal(typeof result.count, "number");
  assert.equal(typeof result.limit, "number");
  assert.equal(typeof result.truncated, "boolean");
  assert.equal(typeof result.snapshot_limited, "boolean");
  assert.equal(result.next_cursor, null);
  assert.ok(Array.isArray(result.failures));
  assert.ok(Array.isArray(result.results));
  rt.stopValidationRetry();
});

test("continuation pages reuse the original verification plan", async () => {
  const rt = await runtime();
  const first = "rep:mock:EXAMPLE_CABINET:synthetic-1";
  const second = "rep:mock:EXAMPLE_CABINET:synthetic-2";
  let searches = 0;
  rt.adapter.searchIds = async () => { searches += 1; return [first, second]; };
  rt.adapter.getMany = async (request: any) => {
    const id = request.ids[0];
    return {
      objects: [document(id, id === first ? baseAttributes : { ...baseAttributes, "rep:user:page_count": { type: "long", value: 4 } })],
      failures: []
    };
  };
  const firstPage: any = (await rt.tools.call(profile(), "arcsuite_search_documents", {
    scope: "example_documents", filters: { page_count: { operator: "gte", value: 10 } }, limit: 1
  })).structuredContent;
  assert.equal(firstPage.count, 1);
  assert.equal(typeof firstPage.next_cursor, "string");
  await assert.rejects(() => rt.tools.call(profile(), "arcsuite_search_documents", { scope: "example_documents", cursor: firstPage.next_cursor }), /ARCSUITE_UPSTREAM_ERROR/);
  assert.equal(searches, 1);
  rt.stopValidationRetry();
});

test("named paths cannot bypass root scope proof before normalization", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arcsuite-mcp-root-proof-"));
  const scopeFile = join(dir, "scopes.yaml");
  await writeFile(scopeFile, `version: 1
scopes:
  example_documents:
    description: Synthetic root-scoped repository
    enabled: true
    arcsuite:
      cabinet_alias: EXAMPLE_CABINET
      cabinet_id: rep:mock:EXAMPLE_CABINET
      root_object_id: rep:mock:EXAMPLE_CABINET:required-root
      resolve_references: true
    allowed_object_types: [document, folder]
    default_attr_ids:
      - {ns: rep, name: system:name}
    semantic_attributes: {}
`);
  const rt = await runtime(scopeFile);
  const id = "rep:mock:EXAMPLE_CABINET:synthetic-1";
  rt.adapter.searchIds = async () => [id];
  rt.adapter.getMany = async () => ({
    objects: [document(id, baseAttributes)],
    failures: []
  });
  rt.adapter.get = async () => ({
    ...document(id, baseAttributes),
    pathObjects: [{ id: "rep:mock:EXAMPLE_CABINET:wrong-root", name: "Wrong root", objectClass: "folder", nativeObjectClass: { ns: "rep", name: "system:folder" } }]
  });
  await assert.rejects(() => rt.tools.call({ ...profile(), allowedScopes: ["example_documents"] }, "arcsuite_search_documents", { scope: "example_documents", query: "synthetic" }), /ARCSUITE_FORBIDDEN/);
  rt.stopValidationRetry();
});
