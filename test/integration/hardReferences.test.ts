import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRuntime } from "../../src/server.ts";

const targetId = "rep:mock:EXAMPLE_CABINET:1001";
const otherTargetId = "rep:mock:EXAMPLE_CABINET:1002";
const referenceIds = [
  "rep:mock:EXAMPLE_CABINET:hardref-001",
  "rep:mock:EXAMPLE_CABINET:hardref-002"
];
const hiddenCandidateIds = [
  "rep:mock:OTHER_CABINET:hardref-003",
  "rep:mock:EXAMPLE_CABINET:hardref-outside-root",
  "rep:mock:EXAMPLE_CABINET:hardref-disallowed"
];

async function runtime(scopeFile = resolve("config/scopes.mock.yaml"), overrides: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "arcsuite-hard-references-"));
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

async function rootScopedConfig(relationshipsEnabled = true): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arcsuite-hard-reference-scope-"));
  const source = await readFile(resolve("config/scopes.mock.yaml"), "utf8");
  const configured = source
    .replace("root_object_id: null", 'root_object_id: "rep:mock:EXAMPLE_CABINET:folder-a"')
    .replace("hard_references: true", `hard_references: ${relationshipsEnabled}`);
  const path = join(dir, "scopes.yaml");
  await writeFile(path, configured);
  return path;
}

function profile(overrides: Record<string, unknown> = {}) {
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
      "arcsuite_read_document",
      "arcsuite_list_hard_references"
    ],
    rateLimit: { requestsPerMinute: 120, burst: 30 },
    ...overrides
  } as any;
}

function installCandidates(adapter: any, ids: string[]) {
  const requests: unknown[] = [];
  adapter.hardReferences = async (request: unknown) => {
    requests.push(request);
    return { ids: [...ids] };
  };
  return requests;
}

test("incoming hard-reference tool returns only safe semantic relationship metadata", async () => {
  const rt = await runtime();
  const p = profile();
  const result: any = await rt.tools.call(p, "arcsuite_list_hard_references", { document_id: targetId });
  const data = result.structuredContent;

  assert.equal(data.document_id, targetId);
  assert.equal(data.relationship, "hard_reference_incoming");
  assert.equal(data.count, 2);
  assert.equal(data.truncated, false);
  assert.equal(data.next_cursor, null);
  assert.deepEqual(data.results.map((item: any) => item.relationship), ["hard_reference_incoming", "hard_reference_incoming"]);
  assert.deepEqual(data.results.map((item: any) => item.name), ["Example incoming reference 001", "Example incoming reference 002"]);
  assert.ok(data.results[0].path.includes("Example folder"));
  assert.equal(data.results[0].object_class, "reference");

  const serialized = JSON.stringify(data);
  for (const privateValue of [...referenceIds, ...hiddenCandidateIds, "rep:mock:EXAMPLE_CABINET:folder-a", "referenceId", "editionKey", "pathObjects", "getRepositoryObjects.searchMode", "listRepositoryObjectHardReferences"]) {
    assert.equal(serialized.includes(privateValue), false, `${privateValue} must remain private`);
  }
  for (const entry of data.results) {
    for (const privateKey of ["id", "document_id", "hard_reference_id", "reference_id", "edition_key", "attributes", "open_url"]) {
      assert.equal(Object.hasOwn(entry, privateKey), false, `${privateKey} must not be exposed`);
    }
  }

  const audit = JSON.parse((await readFile(rt.config.auditLogPath, "utf8")).trim());
  assert.deepEqual(audit.object_ids, [targetId]);
  assert.equal(audit.result_count, 2);
  assert.ok(audit.soap_operations.includes("getRepositoryObject"));
  assert.ok(audit.soap_operations.includes("listRepositoryObjectHardReferences"));
  assert.equal(JSON.stringify(audit).includes("hardref-001"), false);
  assert.equal(JSON.stringify(audit).includes("hardref-003"), false);
  assert.equal(JSON.stringify(audit).includes("folder-a"), false);
});

test("an authorized target with no incoming Hard References returns an empty page", async () => {
  const rt = await runtime();
  const data: any = (await rt.tools.call(profile(), "arcsuite_list_hard_references", { document_id: otherTargetId })).structuredContent;
  assert.equal(data.document_id, otherTargetId);
  assert.equal(data.relationship, "hard_reference_incoming");
  assert.equal(data.count, 0);
  assert.deepEqual(data.results, []);
  assert.equal(data.next_cursor, null);
  assert.equal(data.truncated, false);
});

test("hard-reference target authorization precedes relationship dispatch", async () => {
  const rt = await runtime();
  const adapter: any = rt.adapter;
  let dispatched = false;
  adapter.hardReferences = async () => { dispatched = true; return { ids: referenceIds }; };

  await assert.rejects(
    () => rt.tools.call(profile(), "arcsuite_list_hard_references", { document_id: "rep:mock:EXAMPLE_CABINET:missing" }),
    (error: any) => error?.stableCode === "ARCSUITE_NOT_AVAILABLE"
  );
  assert.equal(dispatched, false);

  await assert.rejects(
    () => rt.tools.call(profile(), "arcsuite_list_hard_references", { document_id: "rep:mock:OTHER_CABINET:1001" }),
    (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN"
  );
  assert.equal(dispatched, false);
});

test("profile and scope must both enable hard-reference reads", async () => {
  const rt = await runtime();
  const adapter: any = rt.adapter;
  let dispatched = false;
  adapter.hardReferences = async () => { dispatched = true; return { ids: referenceIds }; };

  await assert.rejects(
    () => rt.tools.call(profile({ allowedTools: ["arcsuite_describe_capabilities"] }), "arcsuite_list_hard_references", { document_id: targetId }),
    (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN"
  );
  assert.equal(dispatched, false);

  const disabled = await runtime(await rootScopedConfig(false));
  const disabledAdapter: any = disabled.adapter;
  disabledAdapter.hardReferences = async () => { dispatched = true; return { ids: referenceIds }; };
  const targetLookups: string[] = [];
  const originalGet = disabledAdapter.get.bind(disabledAdapter);
  disabledAdapter.get = async (request: { id: string }) => {
    targetLookups.push(request.id);
    return originalGet(request);
  };
  for (const documentId of [targetId, "rep:mock:EXAMPLE_CABINET:missing"]) {
    await assert.rejects(
      () => disabled.tools.call(profile(), "arcsuite_list_hard_references", { document_id: documentId }),
      (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN" && error?.category === "relationship_not_allowed"
    );
  }
  assert.deepEqual(targetLookups, []);
  assert.equal(dispatched, false);
});

test("cabinet, root, and object-type filtering happens before paging without hidden counts", async () => {
  const rt = await runtime(await rootScopedConfig());
  const adapter: any = rt.adapter;
  installCandidates(adapter, [...referenceIds, ...hiddenCandidateIds]);
  const data: any = (await rt.tools.call(profile(), "arcsuite_list_hard_references", { document_id: targetId })).structuredContent;

  assert.equal(data.count, 2);
  assert.equal(data.truncated, false);
  assert.equal(data.results.length, 2);
  const serialized = JSON.stringify(data);
  for (const privateId of hiddenCandidateIds) assert.equal(serialized.includes(privateId), false);
  assert.equal(serialized.includes("candidate_count"), false);
});

test("Hard Reference metadata and path hydration never resolve the reference", async () => {
  const rt = await runtime(await rootScopedConfig());
  const adapter: any = rt.adapter;
  const getRequests: any[] = [];
  const getManyRequests: any[] = [];
  const originalGet = adapter.get.bind(adapter);
  const originalGetMany = adapter.getMany.bind(adapter);
  adapter.get = async (request: any) => { getRequests.push(request); return originalGet(request); };
  adapter.getMany = async (request: any) => { getManyRequests.push(request); return originalGetMany(request); };
  installCandidates(adapter, [...referenceIds, ...hiddenCandidateIds]);

  await rt.tools.call(profile(), "arcsuite_list_hard_references", { document_id: targetId });
  assert.ok(getRequests.length >= 3);
  assert.ok(getRequests.every((request) => request.resolveRef === false));
  assert.ok(getManyRequests.length >= 1);
  assert.ok(getManyRequests.every((request) => request.resolveRef === false));
});

test("not-available and forbidden Hard Reference hydration failures are silently excluded", async () => {
  const rt = await runtime();
  const adapter: any = rt.adapter;
  const originalGetMany = adapter.getMany.bind(adapter);
  adapter.getMany = async (request: any) => {
    const result = await originalGetMany(request);
    const index = request.ids.indexOf(referenceIds[0]);
    if (index >= 0) {
      result.objects = result.objects.filter((item: any) => item.id !== referenceIds[0]);
      result.failures.push({ index, code: "ARCSUITE_FORBIDDEN" });
    }
    return result;
  };

  const data: any = (await rt.tools.call(profile(), "arcsuite_list_hard_references", { document_id: targetId })).structuredContent;
  assert.equal(data.count, 1);
  assert.deepEqual(data.results.map((item: any) => item.name), ["Example incoming reference 002"]);
  assert.equal("failures" in data, false);
});

test("malformed batch accounting fails the whole relationship call", async () => {
  const rt = await runtime();
  const adapter: any = rt.adapter;
  adapter.getMany = async () => ({ objects: [], failures: [] });
  await assert.rejects(
    () => rt.tools.call(profile(), "arcsuite_list_hard_references", { document_id: targetId }),
    (error: any) => error?.stableCode === "ARCSUITE_UPSTREAM_ERROR"
  );
});

test("malformed and duplicate candidate IDs fail closed before hydration", async () => {
  const rt = await runtime();
  const adapter: any = rt.adapter;
  for (const ids of [["not-a-repository-id"], [referenceIds[0], referenceIds[0]]]) {
    installCandidates(adapter, ids);
    await assert.rejects(
      () => rt.tools.call(profile(), "arcsuite_list_hard_references", { document_id: targetId }),
      (error: any) => error?.stableCode === "ARCSUITE_UPSTREAM_ERROR"
    );
  }
});

test("candidate overflow fails without creating a partial public page", async () => {
  const rt = await runtime(undefined, { MCP_HARD_REFERENCE_MAX_CANDIDATES: "2" });
  const adapter: any = rt.adapter;
  let hydrated = false;
  installCandidates(adapter, [...referenceIds, hiddenCandidateIds[0]]);
  const originalGetMany = adapter.getMany.bind(adapter);
  adapter.getMany = async (request: unknown) => { hydrated = true; return originalGetMany(request); };

  await assert.rejects(
    () => rt.tools.call(profile(), "arcsuite_list_hard_references", { document_id: targetId }),
    (error: any) => error?.stableCode === "ARCSUITE_LIMIT_EXCEEDED"
  );
  assert.equal(hydrated, false);
});

test("hard-reference pages are stable and cursors bind profile, scope, and target", async () => {
  const rt = await runtime(undefined, { MCP_SEARCH_DEFAULT_LIMIT: "1", MCP_SEARCH_MAX_LIMIT: "2" });
  const adapter: any = rt.adapter;
  let dispatches = 0;
  adapter.hardReferences = async () => { dispatches += 1; return { ids: [...referenceIds] }; };
  const first: any = (await rt.tools.call(profile(), "arcsuite_list_hard_references", { document_id: targetId, limit: 1 })).structuredContent;
  assert.equal(first.count, 1);
  assert.equal(first.truncated, true);
  assert.equal(typeof first.next_cursor, "string");

  const second: any = (await rt.tools.call(profile(), "arcsuite_list_hard_references", { document_id: targetId, cursor: first.next_cursor })).structuredContent;
  assert.equal(second.count, 1);
  assert.equal(second.truncated, false);
  assert.equal(second.next_cursor, null);
  assert.equal(dispatches, 1, "continuation must use the authorized server-side snapshot");

  const reusable = (await rt.tools.call(profile(), "arcsuite_list_hard_references", { document_id: targetId, limit: 1 })).structuredContent as any;
  await assert.rejects(
    () => rt.tools.call(profile(), "arcsuite_list_hard_references", { document_id: otherTargetId, cursor: reusable.next_cursor }),
    (error: any) => error?.stableCode === "ARCSUITE_INVALID_ARGUMENT"
  );
  await assert.rejects(
    () => rt.tools.call(profile({ clientProfileId: "other-client" }), "arcsuite_list_hard_references", { document_id: targetId, cursor: reusable.next_cursor }),
    (error: any) => error?.stableCode === "ARCSUITE_INVALID_ARGUMENT"
  );
  await assert.rejects(
    () => rt.tools.call(profile(), "arcsuite_list_hard_references", { document_id: targetId, limit: 1, cursor: reusable.next_cursor }),
    (error: any) => error?.stableCode === "ARCSUITE_INVALID_ARGUMENT"
  );
  await assert.rejects(
    () => rt.tools.call(profile(), "arcsuite_list_hard_references", { document_id: targetId, limit: 1, cursor: "" }),
    (error: any) => error?.stableCode === "ARCSUITE_INVALID_ARGUMENT"
  );
});
