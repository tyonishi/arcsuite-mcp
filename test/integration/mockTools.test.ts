import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRuntime } from "../../src/server.ts";

async function runtime(scopeFile = resolve("config/scopes.mock.yaml")) {
  const dir = await mkdtemp(join(tmpdir(), "arcsuite-mcp-test-"));
  const rt = await buildRuntime({
    ...process.env,
    NODE_ENV: "test",
    ARCSUITE_ADAPTER_MODE: "mock",
    MCP_DEV_BEARER_TOKEN: "test-token",
    MCP_SCOPES_FILE: scopeFile,
    MCP_SHARED_TEMP_DIR: join(dir, "shared"),
    MCP_AUDIT_LOG_PATH: join(dir, "audit.jsonl"),
    MCP_CURSOR_HMAC_SECRET: "0123456789abcdef0123456789abcdef",
    MCP_VALIDATE_ON_STARTUP: "true"
  });
  return rt;
}

function profile() {
  return {
    clientProfileId: "dev-profile",
    allowedScopes: ["example_documents"],
    allowedTools: [
      "arcsuite_search_documents",
      "arcsuite_get_document",
      "arcsuite_list_folder",
      "arcsuite_list_document_revisions",
      "arcsuite_get_document_content_info",
      "arcsuite_read_document"
    ],
    rateLimit: { requestsPerMinute: 120, burst: 30 }
  } as any;
}

test("mock tool surface is exactly the six generic v1 read tools", async () => {
  const rt = await runtime();
  const names = rt.tools.list(profile()).map((tool) => tool.name);
  assert.deepEqual(names, [
    "arcsuite_search_documents",
    "arcsuite_get_document",
    "arcsuite_list_folder",
    "arcsuite_list_document_revisions",
    "arcsuite_get_document_content_info",
    "arcsuite_read_document"
  ]);
  assert.equal(names.some((name) => /drawing|delete|acl|admin|privilege/i.test(name)), false);
});

test("synthetic search, metadata, folder, revisions, content info and text read work", async () => {
  const rt = await runtime();
  const p = profile();
  const found = await rt.tools.call(p, "arcsuite_search_documents", { scope: "example_documents", filters: { document_number: "DOC-000001" } });
  const search: any = found.structuredContent;
  assert.equal(search.count, 1);
  const id = search.results[0].document_id;
  assert.equal(id, "rep:mock:EXAMPLE_CABINET:1001");

  const doc = await rt.tools.call(p, "arcsuite_get_document", { document_id: id });
  assert.equal((doc.structuredContent as any).semantic_attributes.document_number, "DOC-000001");
  assert.equal("attributes" in doc.structuredContent, false);

  const folder = await rt.tools.call(p, "arcsuite_list_folder", { scope: "example_documents" });
  assert.equal((folder.structuredContent as any).count, 2);
  const revisions = await rt.tools.call(p, "arcsuite_list_document_revisions", { document_id: id });
  assert.equal((revisions.structuredContent as any).count, 3);

  const info = await rt.tools.call(p, "arcsuite_get_document_content_info", { document_id: id });
  assert.equal((info.structuredContent as any).content_type, "text/plain");
  assert.equal((info.structuredContent as any).extractable, true);

  const read = await rt.tools.call(p, "arcsuite_read_document", { document_id: id, max_chars: 1000 });
  const result: any = read.structuredContent;
  assert.match(result.content, /Synthetic ArcSuite document/);
  assert.equal(result.truncated, false);
  assert.equal("base64" in result, false);
});

test("raw physical ArcSuite fields and non-generic semantic tool names are unreachable", async () => {
  const rt = await runtime();
  const p = profile();
  await assert.rejects(() => rt.tools.call(p, "arcsuite_search_documents", { scope: "example_documents", query: "x", cabinetId: "rep:other" }));
  await assert.rejects(() => rt.tools.call(p, "arcsuite_search_documents", { scope: "example_documents", filters: { attr_id: "system:name" } }));
  const nonGenericTool = ["arcsuite", "find", "drawing"].join("_");
  await assert.rejects(() => rt.tools.call(p, nonGenericTool, { document_number: "DOC-000001" }));
});

test("tool results cannot bypass the configured object-type allowlist", async () => {
  const rt = await runtime();
  const adapter = rt.adapter as any;
  adapter.search = async () => [{
    id: "rep:mock:EXAMPLE_CABINET:unexpected",
    objectClass: "cabinet",
    attributes: {}
  }];
  await assert.rejects(
    () => rt.tools.call(profile(), "arcsuite_search_documents", { scope: "example_documents", query: "synthetic" }),
    (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN" && error?.category === "object_type_not_allowed"
  );
});

test("tool results cannot bypass the configured cabinet scope", async () => {
  const outOfScope = {
    id: "rep:mock:OTHER_CABINET:leak",
    objectClass: "document",
    attributes: {}
  };

  {
    const rt = await runtime();
    (rt.adapter as any).search = async () => [outOfScope];
    await assert.rejects(
      () => rt.tools.call(profile(), "arcsuite_search_documents", { scope: "example_documents", query: "synthetic" }),
      (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN" && error?.category === "cabinet_scope"
    );
  }

  {
    const rt = await runtime();
    (rt.adapter as any).get = async () => outOfScope;
    await assert.rejects(
      () => rt.tools.call(profile(), "arcsuite_get_document", { document_id: "rep:mock:EXAMPLE_CABINET:1001" }),
      (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN" && error?.category === "cabinet_scope"
    );
  }

  {
    const rt = await runtime();
    (rt.adapter as any).list = async () => [outOfScope];
    await assert.rejects(
      () => rt.tools.call(profile(), "arcsuite_list_folder", { scope: "example_documents" }),
      (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN" && error?.category === "cabinet_scope"
    );
  }

  {
    const rt = await runtime();
    (rt.adapter as any).revisions = async () => [outOfScope];
    await assert.rejects(
      () => rt.tools.call(profile(), "arcsuite_list_document_revisions", { document_id: "rep:mock:EXAMPLE_CABINET:1001" }),
      (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN" && error?.category === "cabinet_scope"
    );
  }

  {
    const rt = await runtime();
    (rt.adapter as any).search = async () => [{
      id: "rep:mock:EXAMPLE_CABINET:1001",
      objectClass: "document",
      attributes: {},
      pathObjects: [{ id: "rep:mock:OTHER_CABINET:folder", objectClass: "folder" }]
    }];
    await assert.rejects(
      () => rt.tools.call(profile(), "arcsuite_search_documents", { scope: "example_documents", query: "synthetic" }),
      (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN" && error?.category === "cabinet_scope"
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

test("configured root scope is revalidated for returned search objects", async () => {
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
  (rt.adapter as any).search = async () => [{
    id: "rep:mock:EXAMPLE_CABINET:1002",
    objectClass: "document",
    attributes: {}
  }];
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
