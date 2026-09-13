import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRuntime } from "../../src/server.ts";

async function runtime(scopeFile = resolve("config/scopes.mock.yaml"), overrides: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "arcsuite-mcp-test-"));
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
    allowedTools: [
      "arcsuite_describe_capabilities",
      "arcsuite_search_documents",
      "arcsuite_get_document",
      "arcsuite_get_documents",
      "arcsuite_list_folder",
      "arcsuite_list_document_revisions",
      "arcsuite_get_document_content_info",
      "arcsuite_read_document"
    ],
    rateLimit: { requestsPerMinute: 120, burst: 30 }
  } as any;
}

const expectedTools = [
  "arcsuite_describe_capabilities",
  "arcsuite_search_documents",
  "arcsuite_get_document",
  "arcsuite_get_documents",
  "arcsuite_list_folder",
  "arcsuite_list_document_revisions",
  "arcsuite_get_document_content_info",
  "arcsuite_read_document"
];

test("mock tool surface exposes the eight generic v1.1 read tools", async () => {
  const rt = await runtime();
  const names = rt.tools.list(profile()).map((tool) => tool.name);
  assert.deepEqual(names, expectedTools);
  assert.equal(names.some((name) => /drawing|delete|acl|admin|privilege/i.test(name)), false);
});

test("capability discovery exposes only semantic scope metadata", async () => {
  const rt = await runtime();
  const result = await rt.tools.call(profile(), "arcsuite_describe_capabilities", {});
  const data: any = result.structuredContent;
  assert.equal(data.version, "1.1");
  assert.equal(data.read_only, true);
  assert.deepEqual(data.allowed_tools, expectedTools);
  assert.equal(data.scopes[0].id, "example_documents");
  assert.ok(data.scopes[0].filters.some((filter: any) => filter.name === "document_number"));
  assert.equal(JSON.stringify(data).includes("EXAMPLE_CABINET"), false);
  assert.equal(JSON.stringify(data).includes("example_document_number"), false);
});

test("synthetic search, metadata, batch, folder, revisions, content info and text read work", async () => {
  const rt = await runtime();
  const p = profile();
  const found = await rt.tools.call(p, "arcsuite_search_documents", { scope: "example_documents", filters: { document_number: "DOC-000001" } });
  const search: any = found.structuredContent;
  assert.equal(search.count, 1);
  assert.equal(search.next_cursor, null);
  const id = search.results[0].document_id;
  assert.equal(id, "rep:mock:EXAMPLE_CABINET:1001");

  const doc = await rt.tools.call(p, "arcsuite_get_document", { document_id: id });
  assert.equal((doc.structuredContent as any).semantic_attributes.document_number, "DOC-000001");
  assert.equal("attributes" in doc.structuredContent, false);

  const batch = await rt.tools.call(p, "arcsuite_get_documents", {
    scope: "example_documents",
    document_ids: ["rep:mock:EXAMPLE_CABINET:1001", "rep:mock:EXAMPLE_CABINET:missing"]
  });
  const batchData: any = batch.structuredContent;
  assert.equal(batchData.count, 1);
  assert.equal(batchData.failures.length, 1);
  assert.equal(batchData.failures[0].document_id, "rep:mock:EXAMPLE_CABINET:missing");
  assert.equal(batchData.failures[0].code, "ARCSUITE_NOT_AVAILABLE");

  const folder = await rt.tools.call(p, "arcsuite_list_folder", { scope: "example_documents" });
  assert.equal((folder.structuredContent as any).count, 2);
  const revisions = await rt.tools.call(p, "arcsuite_list_document_revisions", { document_id: id });
  assert.equal((revisions.structuredContent as any).count, 3);

  const info = await rt.tools.call(p, "arcsuite_get_document_content_info", { document_id: id });
  assert.equal((info.structuredContent as any).content_type, "text/plain");
  assert.equal((info.structuredContent as any).extractable, true);
  assert.equal((info.structuredContent as any).cached, false, "first content_info request must report an upstream/cache miss");

  const read = await rt.tools.call(p, "arcsuite_read_document", { document_id: id, max_chars: 1000 });
  const result: any = read.structuredContent;
  assert.match(result.content, /Synthetic ArcSuite document/);
  assert.equal(result.truncated, false);
  assert.equal(result.cached, true, "content_info should warm the private snapshot cache");
  assert.equal("base64" in result, false);
});

test("LIKE filters treat only wildcard characters as pattern syntax", async () => {
  const rt = await runtime();
  const p = profile();
  const wildcard: any = (await rt.tools.call(p, "arcsuite_search_documents", {
    scope: "example_documents",
    filters: { document_number: "DOC-00000?" }
  })).structuredContent;
  assert.equal(wildcard.count, 2);

  const punctuation: any = (await rt.tools.call(p, "arcsuite_search_documents", {
    scope: "example_documents",
    filters: { document_number: "DOC-00000." }
  })).structuredContent;
  assert.equal(punctuation.count, 0);
});

test("content-info cache hits preserve the adapter-provided label", async () => {
  const rt = await runtime();
  const originalContent = (rt.adapter as any).content.bind(rt.adapter);
  (rt.adapter as any).content = async (request: any) => ({ ...await originalContent(request), label: "adapter:canonical" });
  const first: any = (await rt.tools.call(profile(), "arcsuite_get_document_content_info", { document_id: "rep:mock:EXAMPLE_CABINET:1001" })).structuredContent;
  const second: any = (await rt.tools.call(profile(), "arcsuite_get_document_content_info", { document_id: "rep:mock:EXAMPLE_CABINET:1001" })).structuredContent;
  assert.equal(first.label, "adapter:canonical");
  assert.equal(first.cached, false);
  assert.equal(second.label, "adapter:canonical");
  assert.equal(second.cached, true);
});

test("search and folder paging use stable opaque cursors", async () => {
  const rt = await runtime(undefined, { MCP_SEARCH_DEFAULT_LIMIT: "1", MCP_SEARCH_MAX_LIMIT: "2" });
  const p = profile();
  const first: any = (await rt.tools.call(p, "arcsuite_search_documents", { scope: "example_documents", query: "DOC", limit: 1 })).structuredContent;
  assert.equal(first.count, 1);
  assert.equal(typeof first.next_cursor, "string");
  const second: any = (await rt.tools.call(p, "arcsuite_search_documents", { scope: "example_documents", cursor: first.next_cursor })).structuredContent;
  assert.equal(second.count, 1);
  assert.notEqual(first.results[0].document_id, second.results[0].document_id);
  assert.equal(second.next_cursor, null);

  const folderFirst: any = (await rt.tools.call(p, "arcsuite_list_folder", { scope: "example_documents", limit: 1 })).structuredContent;
  assert.equal(typeof folderFirst.next_cursor, "string");
  const folderSecond: any = (await rt.tools.call(p, "arcsuite_list_folder", { scope: "example_documents", cursor: folderFirst.next_cursor })).structuredContent;
  assert.equal(folderSecond.count, 1);
  assert.equal(folderSecond.next_cursor, null);
});

test("paging cursor is profile and scope bound and continuation cannot redefine the query", async () => {
  const rt = await runtime(undefined, { MCP_SEARCH_DEFAULT_LIMIT: "1", MCP_SEARCH_MAX_LIMIT: "2" });
  const p = profile();
  const first: any = (await rt.tools.call(p, "arcsuite_search_documents", { scope: "example_documents", query: "DOC", limit: 1 })).structuredContent;
  await assert.rejects(() => rt.tools.call(p, "arcsuite_search_documents", { scope: "example_documents", cursor: first.next_cursor, query: "changed" }));
  const other = { ...p, clientProfileId: "other-profile" };
  await assert.rejects(() => rt.tools.call(other, "arcsuite_search_documents", { scope: "example_documents", cursor: first.next_cursor }));
});

test("raw physical ArcSuite fields and non-generic semantic tool names are unreachable", async () => {
  const rt = await runtime();
  const p = profile();
  await assert.rejects(() => rt.tools.call(p, "arcsuite_search_documents", { scope: "example_documents", query: "x", cabinetId: "rep:other" }));
  await assert.rejects(() => rt.tools.call(p, "arcsuite_search_documents", { scope: "example_documents", filters: { attr_id: "system:name" } }));
  await assert.rejects(() => rt.tools.call(p, ["arcsuite", "find", "drawing"].join("_"), { document_number: "DOC-000001" }));
});

test("tool results cannot bypass object-type or cabinet scope", async () => {
  const rt = await runtime();
  const adapter = rt.adapter as any;
  adapter.searchIds = async () => ["rep:mock:EXAMPLE_CABINET:unexpected"];
  adapter.getMany = async () => ({ objects: [{ id: "rep:mock:EXAMPLE_CABINET:unexpected", objectClass: "cabinet", attributes: {} }], failures: [] });
  await assert.rejects(
    () => rt.tools.call(profile(), "arcsuite_search_documents", { scope: "example_documents", query: "synthetic" }),
    (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN" && error?.category === "object_type_not_allowed"
  );

  const rt2 = await runtime();
  (rt2.adapter as any).searchIds = async () => ["rep:mock:OTHER_CABINET:leak"];
  await assert.rejects(
    () => rt2.tools.call(profile(), "arcsuite_search_documents", { scope: "example_documents", query: "synthetic" }),
    (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN" && error?.category === "cabinet_scope"
  );
});

test("batch results fail closed when success and failure coverage is inconsistent", async () => {
  const ids = ["rep:mock:EXAMPLE_CABINET:1001", "rep:mock:EXAMPLE_CABINET:missing"];
  const object = { id: ids[0], objectClass: "document", attributes: {} };
  const cases = [
    { category: "batch_identity", result: { objects: [object, object], failures: [] } },
    { category: "batch_identity", result: { objects: [object], failures: [{ index: 1, code: "ARCSUITE_NOT_AVAILABLE" }, { index: 1, code: "ARCSUITE_NOT_AVAILABLE" }] } },
    { category: "batch_identity", result: { objects: [object], failures: [{ index: 0, code: "ARCSUITE_NOT_AVAILABLE" }] } },
    { category: "batch_coverage", result: { objects: [object], failures: [] } }
  ];
  for (const item of cases) {
    const rt = await runtime();
    (rt.adapter as any).getMany = async () => item.result;
    await assert.rejects(
      () => rt.tools.call(profile(), "arcsuite_get_documents", { scope: "example_documents", document_ids: ids }),
      (error: any) => error?.stableCode === "ARCSUITE_UPSTREAM_ERROR" && error?.category === item.category
    );
  }
});

test("content responses must preserve the requested object identity", async () => {
  const rt = await runtime();
  (rt.adapter as any).content = async () => ({
    id: "rep:mock:EXAMPLE_CABINET:other-document",
    label: "system:primary",
    fileName: "synthetic.txt",
    contentType: "text/plain",
    sizeBytes: 0,
    filePath: "/tmp/not-used"
  });
  await assert.rejects(
    () => rt.tools.call(profile(), "arcsuite_get_document_content_info", { document_id: "rep:mock:EXAMPLE_CABINET:1001" }),
    (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN" && error?.category === "object_identity"
  );
});

test("configured root scope is revalidated for batch-fetched search objects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arcsuite-mcp-root-scope-test-"));
  const scopeFile = join(dir, "scopes.yaml");
  await writeFile(scopeFile, `version: 1
scopes:
  example_documents:
    description: Synthetic root-scoped repository
    enabled: true
    arcsuite:
      service_dn: service:example
      cabinet_alias: EXAMPLE_CABINET
      cabinet_id: rep:mock:EXAMPLE_CABINET
      root_object_id: rep:mock:EXAMPLE_CABINET:folder-a
      resolve_references: true
    allowed_object_types: [document, folder, reference]
    default_attr_ids:
      - {ns: rep, name: system:name}
    semantic_attributes: {}
`);
  const rt = await runtime(scopeFile);
  (rt.adapter as any).searchIds = async () => ["rep:mock:EXAMPLE_CABINET:1002"];
  (rt.adapter as any).getMany = async () => ({ objects: [{ id: "rep:mock:EXAMPLE_CABINET:1002", objectClass: "document", attributes: {} }], failures: [] });
  (rt.adapter as any).get = async () => ({
    id: "rep:mock:EXAMPLE_CABINET:1002",
    objectClass: "document",
    attributes: {},
    pathObjects: [{ id: "rep:mock:EXAMPLE_CABINET:other-folder", objectClass: "folder" }]
  });
  await assert.rejects(
    () => rt.tools.call(profile(), "arcsuite_search_documents", { scope: "example_documents", query: "synthetic" }),
    (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN" && error?.category === "root_scope"
  );
});

test("trusted deep-link templates add open_url without exposing configuration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arcsuite-mcp-link-test-"));
  const scopeFile = join(dir, "scopes.yaml");
  await writeFile(scopeFile, `version: 1
scopes:
  example_documents:
    description: Synthetic linked repository
    enabled: true
    arcsuite:
      cabinet_alias: EXAMPLE_CABINET
      cabinet_id: rep:mock:EXAMPLE_CABINET
      root_object_id: null
      resolve_references: true
    ui:
      document_url_template: https://arcsuite.example.invalid/open?id={document_id}
    allowed_object_types: [document, folder, reference]
    default_attr_ids:
      - {ns: rep, name: system:name}
    semantic_attributes: {}
`);
  const rt = await runtime(scopeFile);
  const doc: any = (await rt.tools.call(profile(), "arcsuite_get_document", { document_id: "rep:mock:EXAMPLE_CABINET:1001" })).structuredContent;
  assert.equal(doc.open_url, "https://arcsuite.example.invalid/open?id=rep%3Amock%3AEXAMPLE_CABINET%3A1001");
});
