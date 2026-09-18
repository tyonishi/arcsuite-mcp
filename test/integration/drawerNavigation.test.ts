import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRuntime } from "../../src/server.ts";
import type { AdapterRepositoryObject } from "../../src/arcsuite/types.ts";

const cabinetId = "rep:mock:EXAMPLE_CABINET";
const rootId = `${cabinetId}:root-001`;
const drawerAId = `${cabinetId}:nav-001`;
const drawerBId = `${cabinetId}:nav-002`;
const folderId = `${cabinetId}:folder-001`;
const documentId = `${cabinetId}:document-001`;
const referenceId = `${cabinetId}:reference-001`;

async function runtime(overrides: Record<string, string> = {}, scopeFile = resolve("config/scopes.mock.yaml")) {
  const dir = await mkdtemp(join(tmpdir(), "arcsuite-drawer-navigation-"));
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

async function rootScopedRuntime() {
  const dir = await mkdtemp(join(tmpdir(), "arcsuite-drawer-root-scope-"));
  const config = (await readFile(resolve("config/scopes.mock.yaml"), "utf8"))
    .replace("root_object_id: null", `root_object_id: "${rootId}"`);
  const scopeFile = join(dir, "scopes.yaml");
  await writeFile(scopeFile, config);
  return runtime({}, scopeFile);
}

async function folderPolicyDisabledRuntime() {
  const dir = await mkdtemp(join(tmpdir(), "arcsuite-drawer-policy-"));
  const source = await readFile(resolve("config/scopes.mock.yaml"), "utf8");
  const config = source.replace(/^      - folder\r?\n/m, "");
  assert.notEqual(config, source, "synthetic scope must remove the public folder policy");
  const scopeFile = join(dir, "scopes.yaml");
  await writeFile(scopeFile, config);
  return runtime({}, scopeFile);
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
      "arcsuite_list_folder"
    ],
    rateLimit: { requestsPerMinute: 120, burst: 30 }
  } as any;
}

function object(
  id: string,
  objectClass: string,
  nativeName: string,
  name: string,
  pathObjects: AdapterRepositoryObject["pathObjects"] = [
    { id: cabinetId, name: "Example cabinet", objectClass: "cabinet", nativeObjectClass: { ns: "rep", name: "system:cabinet" } }
  ]
): AdapterRepositoryObject {
  return {
    id,
    objectClass,
    nativeObjectClass: { ns: "rep", name: nativeName },
    attributes: { "rep:system:name": { type: "string", value: name } },
    pathObjects,
    fullPath: true
  };
}

function fixtures(): Map<string, AdapterRepositoryObject> {
  const drawerPath = [
    { id: drawerAId, name: "AE", objectClass: "drawer", nativeObjectClass: { ns: "rep", name: "system:drawer" } },
    { id: cabinetId, name: "Example cabinet", objectClass: "cabinet", nativeObjectClass: { ns: "rep", name: "system:cabinet" } }
  ];
  return new Map([
    [drawerAId, object(drawerAId, "drawer", "system:drawer", "AE")],
    [drawerBId, object(drawerBId, "drawer", "system:drawer", "CAP")],
    [folderId, object(folderId, "folder", "system:folder", "Ordinary folder")],
    [documentId, object(documentId, "document", "system:document", "Drawing 001", drawerPath)],
    [referenceId, object(referenceId, "reference", "system:reference", "Reference 001", drawerPath)]
  ]);
}

function installRepository(rt: Awaited<ReturnType<typeof runtime>>, rootIds = [drawerAId]) {
  const adapter: any = rt.adapter;
  const objects = fixtures();
  let listCalls = 0;
  adapter.listIds = async (request: { locationId: string }) => {
    listCalls += 1;
    if (request.locationId === cabinetId || request.locationId === rootId) return [...rootIds];
    if (request.locationId === drawerAId) return [documentId, referenceId];
    if (request.locationId === folderId) return [documentId];
    return [];
  };
  adapter.getMany = async (request: { ids: string[] }) => ({
    objects: request.ids.map((id) => {
      const found = objects.get(id);
      if (!found) throw new Error(`missing synthetic object: ${id}`);
      const copy = structuredClone(found);
      delete copy.pathObjects;
      return copy;
    }),
    failures: []
  });
  adapter.get = async (request: { id: string; includePath?: boolean }) => {
    const found = objects.get(request.id);
    if (!found) throw new Error(`missing synthetic object: ${request.id}`);
    const copy = structuredClone(found);
    if (!request.includePath) delete copy.pathObjects;
    return copy;
  };
  return { adapter, objects, listCalls: () => listCalls };
}

test("cabinet drawers are public folders and their identities navigate to document/reference children", async () => {
  const rt = await runtime();
  const repository = installRepository(rt);

  const root: any = (await rt.tools.call(profile(), "arcsuite_list_folder", {
    scope: "example_documents",
    include_path: true
  })).structuredContent;
  assert.equal(root.count, 1);
  assert.equal(root.results[0].document_id, drawerAId);
  assert.equal(root.results[0].object_class, "folder");
  assert.deepEqual(root.results[0].path, ["Example cabinet"]);
  assert.equal(JSON.stringify(root).includes('"object_class":"drawer"'), false);
  assert.equal(JSON.stringify(root).includes("rep:system:drawer"), false);

  const children: any = (await rt.tools.call(profile(), "arcsuite_list_folder", {
    scope: "example_documents",
    folder_id: root.results[0].document_id
  })).structuredContent;
  assert.deepEqual(children.results.map((item: any) => [item.document_id, item.object_class]), [
    [documentId, "document"],
    [referenceId, "reference"]
  ]);
  assert.equal(repository.listCalls(), 2);
});

test("drawer include_path remains bound to the configured root", async () => {
  const rt = await rootScopedRuntime();
  const repository = installRepository(rt);
  const drawer = repository.objects.get(drawerAId)!;
  drawer.pathObjects = [
    { id: rootId, name: "Authorized root", objectClass: "folder", nativeObjectClass: { ns: "rep", name: "system:folder" } },
    { id: cabinetId, name: "Example cabinet", objectClass: "cabinet", nativeObjectClass: { ns: "rep", name: "system:cabinet" } }
  ];
  const data: any = (await rt.tools.call(profile(), "arcsuite_list_folder", {
    scope: "example_documents",
    include_path: true
  })).structuredContent;
  assert.equal(data.results[0].object_class, "folder");
  assert.deepEqual(data.results[0].path, ["Example cabinet", "Authorized root"]);

  drawer.pathObjects = [
    { id: cabinetId, name: "Example cabinet", objectClass: "cabinet", nativeObjectClass: { ns: "rep", name: "system:cabinet" } }
  ];
  await assert.rejects(
    () => rt.tools.call(profile(), "arcsuite_list_folder", { scope: "example_documents", include_path: true }),
    (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN" && error?.category === "root_scope"
  );
});

test("an explicit drawer requires public folder policy before child-list dispatch", async () => {
  const rt = await folderPolicyDisabledRuntime();
  const repository = installRepository(rt);
  await assert.rejects(
    () => rt.tools.call(profile(), "arcsuite_list_folder", { scope: "example_documents", folder_id: drawerAId }),
    (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN"
      && error?.category === "object_type_not_allowed"
      && error?.retryable === false
  );
  assert.equal(repository.listCalls(), 0);
});

test("a root-returned drawer requires public folder policy", async () => {
  const rt = await folderPolicyDisabledRuntime();
  installRepository(rt);
  let rejected: any;
  try {
    await rt.tools.call(profile(), "arcsuite_list_folder", { scope: "example_documents" });
  } catch (error) {
    rejected = error;
  }
  assert.equal(rejected?.stableCode, "ARCSUITE_FORBIDDEN");
  assert.equal(rejected?.category, "object_type_not_allowed");
  assert.equal(rejected?.retryable, false);
  assert.equal(JSON.stringify(rejected).includes(drawerAId), false);
});

test("drawer path proof audit records both repository-object operations", async () => {
  const rt = await runtime();
  installRepository(rt);
  await rt.tools.call(profile(), "arcsuite_list_folder", {
    scope: "example_documents",
    include_path: true
  });
  const auditLines = (await readFile(rt.config.auditLogPath, "utf8")).trim().split("\n");
  const audit = JSON.parse(auditLines.at(-1)!);
  assert.ok(audit.soap_operations.includes("listRepositoryObjectIds"));
  assert.ok(audit.soap_operations.includes("getRepositoryObjects"));
  assert.ok(audit.soap_operations.includes("getRepositoryObject"));
  assert.ok(audit.soap_operations.includes("getRepositoryObjectPath"));
});

test("an explicit ordinary folder remains a valid navigation target", async () => {
  const rt = await runtime();
  const repository = installRepository(rt);
  const data: any = (await rt.tools.call(profile(), "arcsuite_list_folder", {
    scope: "example_documents",
    folder_id: folderId
  })).structuredContent;
  assert.equal(data.count, 1);
  assert.equal(data.results[0].document_id, documentId);
  assert.equal(repository.listCalls(), 1);
});

test("a nested exact drawer remains a public folder navigation result", async () => {
  const rt = await runtime();
  const repository = installRepository(rt);
  repository.adapter.listIds = async (request: { locationId: string }) => {
    if (request.locationId === drawerAId) return [drawerBId];
    return [];
  };
  const data: any = (await rt.tools.call(profile(), "arcsuite_list_folder", {
    scope: "example_documents",
    folder_id: drawerAId
  })).structuredContent;
  assert.equal(data.count, 1);
  assert.equal(data.results[0].document_id, drawerBId);
  assert.equal(data.results[0].object_class, "folder");
  assert.equal(JSON.stringify(data).includes('"object_class":"drawer"'), false);
  assert.equal(JSON.stringify(data).includes("rep:system:drawer"), false);
});

test("document and reference folder_id values are rejected before child-list dispatch", async () => {
  for (const id of [documentId, referenceId]) {
    const rt = await runtime();
    const repository = installRepository(rt);
    await assert.rejects(
      () => rt.tools.call(profile(), "arcsuite_list_folder", { scope: "example_documents", folder_id: id }),
      (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN"
        && error?.category === "object_type_not_allowed"
        && error?.retryable === false
    );
    assert.equal(repository.listCalls(), 0);
  }
});

test("drawer navigation requires exact semantic/native class agreement", async () => {
  const cases = [
    { objectClass: "drawer", nativeName: "system:folder", category: "repository_object_shape" },
    { objectClass: "folder", nativeName: "system:drawer", category: "repository_object_shape" },
    { objectClass: "unknown", nativeName: "system:DRAWER", category: "object_type_not_allowed" }
  ];
  for (const current of cases) {
    const rt = await runtime();
    const repository = installRepository(rt);
    repository.objects.set(drawerAId, object(drawerAId, current.objectClass, current.nativeName, "Synthetic container"));
    await assert.rejects(
      () => rt.tools.call(profile(), "arcsuite_list_folder", { scope: "example_documents", folder_id: drawerAId }),
      (error: any) => error?.category === current.category
    );
    assert.equal(repository.listCalls(), 0);
  }
});

test("explicit folder navigation binds the provider proof to the requested identity", async () => {
  const rt = await runtime();
  const repository = installRepository(rt);
  repository.adapter.get = async () => structuredClone(repository.objects.get(drawerBId));
  await assert.rejects(
    () => rt.tools.call(profile(), "arcsuite_list_folder", { scope: "example_documents", folder_id: drawerAId }),
    (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN" && error?.category === "object_identity"
  );
  assert.equal(repository.listCalls(), 0);
});

test("drawer pages reuse one bounded list snapshot and preserve the folder alias", async () => {
  const rt = await runtime({ MCP_SEARCH_DEFAULT_LIMIT: "1", MCP_SEARCH_MAX_LIMIT: "2" });
  const repository = installRepository(rt, [drawerAId, drawerBId]);
  const first: any = (await rt.tools.call(profile(), "arcsuite_list_folder", {
    scope: "example_documents",
    limit: 1
  })).structuredContent;
  assert.equal(first.results[0].object_class, "folder");
  assert.equal(typeof first.next_cursor, "string");

  const second: any = (await rt.tools.call(profile(), "arcsuite_list_folder", {
    scope: "example_documents",
    cursor: first.next_cursor
  })).structuredContent;
  assert.equal(second.results[0].object_class, "folder");
  assert.equal(second.next_cursor, null);
  assert.equal(repository.listCalls(), 1);
});

test("drawer navigation alias does not widen search or strict get authority", async () => {
  const rt = await runtime();
  const repository = installRepository(rt);
  repository.adapter.searchIds = async () => [drawerAId];

  for (const [tool, args] of [
    ["arcsuite_search_documents", { scope: "example_documents", query: "AE" }],
    ["arcsuite_get_document", { document_id: drawerAId }],
    ["arcsuite_get_documents", { scope: "example_documents", document_ids: [drawerAId] }]
  ] as const) {
    await assert.rejects(
      () => rt.tools.call(profile(), tool, args),
      (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN" && error?.category === "object_type_not_allowed"
    );
  }
});

test("drawer remains absent from capabilities and the list-folder input schema", async () => {
  const rt = await runtime();
  const capabilities: any = (await rt.tools.call(profile(), "arcsuite_describe_capabilities", {})).structuredContent;
  assert.deepEqual(capabilities.scopes[0].object_types, ["document", "folder", "reference"]);

  const tool: any = rt.tools.list(profile()).find((item) => item.name === "arcsuite_list_folder");
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ["cursor", "folder_id", "include_path", "limit", "scope"]);
  assert.equal(JSON.stringify(tool.inputSchema).includes("drawer"), false);
});
