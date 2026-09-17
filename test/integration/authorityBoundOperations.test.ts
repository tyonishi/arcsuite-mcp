import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRuntime } from "../../src/server.ts";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const P2_TOOLS = [
  "arcsuite_continue_search",
  "arcsuite_replay_search",
  "arcsuite_get_document_by_ref",
  "arcsuite_get_documents_by_ref",
  "arcsuite_list_document_revisions_by_ref",
  "arcsuite_get_document_content_info_by_ref",
  "arcsuite_read_document_by_ref"
] as const;

const RESULT_REF_TOOL_CASES = [
  {
    tool: "arcsuite_get_document_by_ref",
    args: (resultRef: string) => ({ result_ref: resultRef }),
    firstProviderOperation: "get"
  },
  {
    tool: "arcsuite_get_documents_by_ref",
    args: (resultRef: string) => ({ result_refs: [resultRef] }),
    firstProviderOperation: "getMany"
  },
  {
    tool: "arcsuite_list_document_revisions_by_ref",
    args: (resultRef: string) => ({ result_ref: resultRef, limit: 2 }),
    firstProviderOperation: "get",
    downstreamOperation: "revisions"
  },
  {
    tool: "arcsuite_get_document_content_info_by_ref",
    args: (resultRef: string) => ({ result_ref: resultRef }),
    firstProviderOperation: "get",
    downstreamOperation: "content"
  },
  {
    tool: "arcsuite_read_document_by_ref",
    args: (resultRef: string) => ({ result_ref: resultRef, max_chars: 1000 }),
    firstProviderOperation: "get",
    downstreamOperation: "content"
  }
] as const;

const OBSERVED_PROVIDER_METHODS = ["searchIds", "get", "getMany", "revisions", "content"] as const;

const opaqueKeyring = JSON.stringify({
  active_kid: "test-active",
  keys: [{ kid: "test-active", secret_base64url: Buffer.alloc(32, 0x6b).toString("base64url") }]
});

async function runtime(
  enabled = true,
  scopesFile = resolve("config/scopes.mock.yaml"),
  overrides: NodeJS.ProcessEnv = {}
) {
  const dir = await mkdtemp(join(tmpdir(), "arcsuite-mcp-p2-"));
  const rt = await buildRuntime({
    ...process.env,
    NODE_ENV: "test",
    ARCSUITE_ADAPTER_MODE: "mock",
    MCP_DEV_BEARER_TOKEN: "test-token",
    MCP_SCOPES_FILE: scopesFile,
    MCP_SHARED_TEMP_DIR: join(dir, "shared"),
    MCP_AUDIT_LOG_PATH: join(dir, "audit.jsonl"),
    MCP_CURSOR_HMAC_SECRET: "0123456789abcdef0123456789abcdef",
    MCP_VALIDATE_ON_STARTUP: "true",
    MCP_SEARCH_DEFAULT_LIMIT: "1",
    MCP_SEARCH_MAX_LIMIT: "3",
    MCP_OPAQUE_REFS_ENABLED: String(enabled),
    ...(enabled ? { MCP_OPAQUE_REF_KEYS_JSON: opaqueKeyring } : {}),
    ...overrides
  });
  return rt;
}

async function rootedRuntime() {
  const dir = await mkdtemp(join(tmpdir(), "arcsuite-mcp-p2-root-"));
  const registry = parseYaml(await readFile(resolve("config/scopes.mock.yaml"), "utf8")) as any;
  registry.scopes.example_documents.arcsuite.root_object_id = "rep:mock:EXAMPLE_CABINET:folder-a";
  const path = join(dir, "scopes.yaml");
  await writeFile(path, stringifyYaml(registry), "utf8");
  return runtime(true, path);
}

async function twoScopeRuntime() {
  const dir = await mkdtemp(join(tmpdir(), "arcsuite-mcp-p2-scopes-"));
  const registry = parseYaml(await readFile(resolve("config/scopes.mock.yaml"), "utf8")) as any;
  registry.scopes.other_documents = structuredClone(registry.scopes.example_documents);
  registry.scopes.other_documents.description = "Synthetic other documents";
  registry.scopes.other_documents.arcsuite.cabinet_alias = "OTHER_CABINET";
  registry.scopes.other_documents.arcsuite.cabinet_id = "rep:mock:OTHER_CABINET";
  delete registry.scopes.other_documents.semantic_attributes.page_count;
  const path = join(dir, "scopes.yaml");
  await writeFile(path, stringifyYaml(registry), "utf8");
  return runtime(true, path);
}

function profile(overrides: Record<string, unknown> = {}) {
  return {
    tokenSha256: createHash("sha256").update("test-token").digest("hex"),
    clientProfileId: "dev-profile",
    allowedScopes: ["example_documents"],
    allowedTools: ["arcsuite_describe_capabilities", "arcsuite_search_documents", ...P2_TOOLS],
    rateLimit: { requestsPerMinute: 120, burst: 30 },
    ...overrides
  } as any;
}

async function opaqueSearch(rt: Awaited<ReturnType<typeof runtime>>, limit = 1) {
  return (await rt.tools.call(profile(), "arcsuite_search_documents", {
    scope: "example_documents",
    query: "DOC",
    limit,
    response_contract: "opaque_refs_v1"
  })).structuredContent as any;
}

function observeProvider(rt: Awaited<ReturnType<typeof runtime>>) {
  const calls: string[] = [];
  for (const method of OBSERVED_PROVIDER_METHODS) {
    const original = (rt.adapter as any)[method].bind(rt.adapter);
    (rt.adapter as any)[method] = async (...args: unknown[]) => {
      calls.push(method);
      return original(...args);
    };
  }
  return {
    calls,
    reset: () => { calls.length = 0; }
  };
}

test("P2 tools are feature- and allowedTools-gated", async () => {
  const disabled = await runtime(false);
  const enabled = await runtime(true);
  try {
    assert.deepEqual(disabled.tools.list(profile()).map((tool) => tool.name).filter((name) => P2_TOOLS.includes(name as any)), []);
    assert.deepEqual(enabled.tools.list(profile({ allowedTools: ["arcsuite_search_documents"] })).map((tool) => tool.name).filter((name) => P2_TOOLS.includes(name as any)), []);
    assert.deepEqual(enabled.tools.list(profile()).map((tool) => tool.name).filter((name) => P2_TOOLS.includes(name as any)), [...P2_TOOLS]);
    const disabledCapabilities: any = (await disabled.tools.call(profile(), "arcsuite_describe_capabilities", {})).structuredContent;
    const enabledCapabilities: any = (await enabled.tools.call(profile(), "arcsuite_describe_capabilities", {})).structuredContent;
    assert.deepEqual(disabledCapabilities.allowed_tools.filter((name: string) => P2_TOOLS.includes(name as any)), []);
    assert.deepEqual(enabledCapabilities.allowed_tools.filter((name: string) => P2_TOOLS.includes(name as any)), [...P2_TOOLS]);
    await assert.rejects(
      () => disabled.tools.call(profile(), "arcsuite_continue_search", { continuation_ref: "opaque" }),
      (error: any) => error?.stableCode === "ARCSUITE_NOT_AVAILABLE"
    );
  } finally {
    disabled.stopValidationRetry();
    enabled.stopValidationRetry();
  }
});

test("continuation_ref is the only authority and is idempotent on the final page", async () => {
  const rt = await runtime();
  const ids = ["rep:mock:EXAMPLE_CABINET:1001", "rep:mock:EXAMPLE_CABINET:1002"];
  (rt.adapter as any).searchIds = async () => ids;
  let hydrationDispatches = 0;
  const originalGetMany = (rt.adapter as any).getMany.bind(rt.adapter);
  (rt.adapter as any).getMany = async (...args: unknown[]) => {
    hydrationDispatches += 1;
    return originalGetMany(...args);
  };
  try {
    const first = await opaqueSearch(rt, 1);
    assert.equal(typeof first.continuation_ref, "string");
    hydrationDispatches = 0;
    const one: any = (await rt.tools.call(profile(), "arcsuite_continue_search", {
      continuation_ref: first.continuation_ref
    })).structuredContent;
    const two: any = (await rt.tools.call(profile(), "arcsuite_continue_search", {
      continuation_ref: first.continuation_ref
    })).structuredContent;
    assert.equal(hydrationDispatches, 2, "each retry must freshly hydrate the logical page");
    assert.deepEqual(one.applied_query, first.applied_query);
    assert.deepEqual(two.applied_query, first.applied_query);
    assert.deepEqual(one.results.map((item: any) => item.name), two.results.map((item: any) => item.name));
    assert.equal(one.continuation_ref, null);
    assert.equal(two.continuation_ref, null);
    assert.equal(Object.hasOwn(one, "next_cursor"), false);
    assert.equal(one.results.every((item: any) => typeof item.result_ref === "string" && !Object.hasOwn(item, "document_id")), true);
    await assert.rejects(
      () => rt.tools.call(profile(), "arcsuite_continue_search", { continuation_ref: first.continuation_ref, scope: "example_documents" }),
      (error: any) => error?.stableCode === "ARCSUITE_INVALID_ARGUMENT"
    );
  } finally {
    rt.stopValidationRetry();
  }
});

test("another profile's opaque searches cannot evict a valid continuation authority", async () => {
  const rt = await runtime(true, resolve("config/scopes.mock.yaml"), {
    MCP_PAGING_SNAPSHOT_MAX_IDS: "3",
    MCP_PAGING_MAX_SNAPSHOTS: "4",
    MCP_PAGING_MAX_SNAPSHOTS_PER_CLIENT: "4",
    MCP_PAGING_MAX_TOTAL_IDS: "9",
    MCP_PAGING_MAX_TOTAL_IDS_PER_CLIENT: "6"
  });
  const ids = [
    "rep:mock:EXAMPLE_CABINET:1001",
    "rep:mock:EXAMPLE_CABINET:1002",
    "rep:mock:EXAMPLE_CABINET:1003"
  ];
  (rt.adapter as any).searchIds = async () => ids;
  const victim = profile({
    clientProfileId: "synthetic-profile-b",
    tokenSha256: createHash("sha256").update("synthetic-token-b").digest("hex")
  });
  const allocator = profile({
    clientProfileId: "synthetic-profile-a",
    tokenSha256: createHash("sha256").update("synthetic-token-a").digest("hex")
  });
  try {
    const victimSearch: any = (await rt.tools.call(victim, "arcsuite_search_documents", {
      scope: "example_documents",
      query: "DOC",
      limit: 1,
      response_contract: "opaque_refs_v1"
    })).structuredContent;
    assert.equal(typeof victimSearch.continuation_ref, "string");

    let rejectedAllocations = 0;
    for (let index = 0; index < 2; index += 1) {
      try {
        await rt.tools.call(allocator, "arcsuite_search_documents", {
          scope: "example_documents",
          query: "DOC",
          limit: 1,
          response_contract: "opaque_refs_v1"
        });
      } catch (error) {
        rejectedAllocations += 1;
        assert.equal((error as any)?.stableCode, "ARCSUITE_UPSTREAM_ERROR");
      }
    }
    assert.ok(rejectedAllocations >= 1, "unsafe global pressure must reject the allocating profile");

    const continued: any = (await rt.tools.call(victim, "arcsuite_continue_search", {
      continuation_ref: victimSearch.continuation_ref
    })).structuredContent;
    assert.equal(continued.results.length, 1);
    assert.equal(typeof continued.results[0].result_ref, "string");
  } finally {
    rt.stopValidationRetry();
  }
});

test("wrong-kind refs fail every result-ref public tool before provider dispatch", async () => {
  const rt = await runtime();
  const observed = observeProvider(rt);
  try {
    const first = await opaqueSearch(rt, 1);
    observed.reset();
    await assert.rejects(
      () => rt.tools.call(profile(), "arcsuite_continue_search", { continuation_ref: first.search_ref }),
      refUnavailable
    );
    await assert.rejects(
      () => rt.tools.call(profile(), "arcsuite_continue_search", { continuation_ref: first.results[0].result_ref }),
      refUnavailable
    );
    await assert.rejects(
      () => rt.tools.call(profile(), "arcsuite_replay_search", { search_ref: first.continuation_ref, target_scope: "example_documents" }),
      refUnavailable
    );
    await assert.rejects(
      () => rt.tools.call(profile(), "arcsuite_replay_search", { search_ref: first.results[0].result_ref, target_scope: "example_documents" }),
      refUnavailable
    );
    for (const { tool, args } of RESULT_REF_TOOL_CASES) {
      for (const wrongKindRef of [first.search_ref, first.continuation_ref]) {
        await assert.rejects(
          () => rt.tools.call(profile(), tool, args(wrongKindRef)),
          refUnavailable,
          `${tool} must reject a wrong-kind ref`
        );
      }
    }
    assert.deepEqual(observed.calls, [], "wrong-kind refs must not reach any provider operation");
  } finally {
    rt.stopValidationRetry();
  }
});

test("replay_search preserves canonical semantics and creates fresh target authority", async () => {
  const rt = await runtime();
  try {
    const original: any = (await rt.tools.call(profile(), "arcsuite_search_documents", {
      scope: "example_documents",
      filters: { page_count: { operator: "gte", value: 10 } },
      limit: 2,
      response_contract: "opaque_refs_v1"
    })).structuredContent;
    const replay: any = (await rt.tools.call(profile(), "arcsuite_replay_search", {
      search_ref: original.search_ref,
      target_scope: "example_documents"
    })).structuredContent;
    assert.notEqual(replay.search_ref, original.search_ref);
    assert.deepEqual(replay.applied_query, original.applied_query);
    assert.equal(replay.applied_query.filters.predicates[0].operator, "gte");
    assert.equal(replay.applied_query.filters.predicates[0].value, 10);
    assert.equal(Object.hasOwn(replay, "next_cursor"), false);
    assert.equal(replay.results.every((item: any) => typeof item.result_ref === "string" && !Object.hasOwn(item, "document_id")), true);
  } finally {
    rt.stopValidationRetry();
  }
});

test("replay zero results succeed and replay continuation remains ref-native", async () => {
  const rt = await runtime();
  try {
    const source = await opaqueSearch(rt, 1);
    const replay: any = (await rt.tools.call(profile(), "arcsuite_replay_search", {
      search_ref: source.search_ref,
      target_scope: "example_documents"
    })).structuredContent;
    assert.equal(typeof replay.continuation_ref, "string");
    const continued: any = (await rt.tools.call(profile(), "arcsuite_continue_search", {
      continuation_ref: replay.continuation_ref
    })).structuredContent;
    assert.equal(Object.hasOwn(continued, "next_cursor"), false);
    assert.equal(continued.results.every((item: any) => typeof item.result_ref === "string"), true);

    (rt.adapter as any).searchIds = async () => [];
    const zero: any = (await rt.tools.call(profile(), "arcsuite_replay_search", {
      search_ref: source.search_ref,
      target_scope: "example_documents"
    })).structuredContent;
    assert.equal(zero.count, 0);
    assert.deepEqual(zero.results, []);
    assert.equal(zero.continuation_ref, null);
    assert.equal(typeof zero.search_ref, "string");
    assert.doesNotThrow(() => rt.handles!.resolve(source.search_ref, "search", {
      profile: profile(), scopeId: "example_documents", scope: rt.scopes.get("example_documents")
    }));
  } finally {
    rt.stopValidationRetry();
  }
});

test("all result-ref operations use stored identity and return ref-native identities", async () => {
  const rt = await runtime();
  try {
    const search: any = (await rt.tools.call(profile(), "arcsuite_search_documents", {
      scope: "example_documents",
      filters: { document_number: "DOC-000001" },
      response_contract: "opaque_refs_v1"
    })).structuredContent;
    const resultRef = search.results[0].result_ref;

    const get: any = (await rt.tools.call(profile(), "arcsuite_get_document_by_ref", { result_ref: resultRef })).structuredContent;
    assert.equal(get.result_ref, resultRef);
    assert.equal(Object.hasOwn(get, "document_id"), false);

    const batch: any = (await rt.tools.call(profile(), "arcsuite_get_documents_by_ref", { result_refs: [resultRef] })).structuredContent;
    assert.equal(batch.results[0].result_ref, resultRef);
    assert.equal(Object.hasOwn(batch.results[0], "document_id"), false);

    const revisions: any = (await rt.tools.call(profile(), "arcsuite_list_document_revisions_by_ref", { result_ref: resultRef, limit: 2 })).structuredContent;
    assert.equal(revisions.result_ref, resultRef);
    assert.equal(Object.hasOwn(revisions, "document_id"), false);
    assert.equal(revisions.revisions.every((item: any) => !Object.hasOwn(item, "document_id")), true);

    const info: any = (await rt.tools.call(profile(), "arcsuite_get_document_content_info_by_ref", { result_ref: resultRef })).structuredContent;
    assert.equal(info.result_ref, resultRef);
    assert.equal(Object.hasOwn(info, "document_id"), false);

    const read: any = (await rt.tools.call(profile(), "arcsuite_read_document_by_ref", { result_ref: resultRef, max_chars: 1000 })).structuredContent;
    assert.equal(read.result_ref, resultRef);
    assert.equal(Object.hasOwn(read, "document_id"), false);
    assert.equal(typeof read.content, "string");
  } finally {
    rt.stopValidationRetry();
  }
});

test("legacy and ref-native revision lists request and verify explicit revision authority", async () => {
  const rt = await runtime();
  const adapter: any = rt.adapter;
  const originalRevisions = adapter.revisions.bind(adapter);
  const revisionRequests: any[] = [];
  const baseId = "rep:mock:EXAMPLE_CABINET:1001";
  try {
    const search: any = (await rt.tools.call(profile(), "arcsuite_search_documents", {
      scope: "example_documents",
      filters: { document_number: "DOC-000001" },
      response_contract: "opaque_refs_v1"
    })).structuredContent;
    const resultRef = search.results[0].result_ref;
    const scope = rt.scopes.get("example_documents");
    const defaultsBefore = structuredClone(scope.default_attr_ids);
    assert.equal(scope.default_attr_ids.some((attr) => attr.ns === "rep" && attr.name === "system:revisionnumber"), false);

    adapter.revisions = async (request: any) => {
      revisionRequests.push(structuredClone(request));
      const [item] = await originalRevisions(request);
      return [{
        ...item,
        id: `${request.id}:1`,
        attributes: {
          ...item.attributes,
          "rep:system:revisionnumber": { type: "int", value: 1 }
        }
      }];
    };
    const legacyProfile = profile({
      allowedTools: [...profile().allowedTools, "arcsuite_list_document_revisions"]
    });
    const legacy: any = (await rt.tools.call(legacyProfile, "arcsuite_list_document_revisions", {
      document_id: baseId,
      limit: 2
    })).structuredContent;
    const refNative: any = (await rt.tools.call(profile(), "arcsuite_list_document_revisions_by_ref", {
      result_ref: resultRef,
      limit: 2
    })).structuredContent;

    assert.equal(legacy.revisions[0].revision_number, 1);
    assert.equal(refNative.revisions[0].revision_number, 1);
    assert.equal(Object.hasOwn(refNative.revisions[0], "document_id"), false);
    assert.equal(revisionRequests.length, 2);
    for (const request of revisionRequests) {
      assert.equal(
        request.attrIds.filter((attr: any) => attr.ns === "rep" && attr.name === "system:revisionnumber").length,
        1,
        "revisionnumber must be requested exactly once independently of scope defaults"
      );
    }
    assert.deepEqual(scope.default_attr_ids, defaultsBefore, "revision-list request construction must not mutate scope defaults");
  } finally {
    rt.stopValidationRetry();
  }
});

test("ref-native revision lists fail closed on missing, mismatched, or wrong-class revision authority", async (t) => {
  const cases = [
    {
      name: "missing revision number",
      mutate: (item: any, baseId: string) => {
        const attributes = { ...item.attributes };
        delete attributes["rep:system:revisionnumber"];
        return { ...item, id: `${baseId}:1`, attributes };
      }
    },
    {
      name: "identity suffix mismatch",
      mutate: (item: any, baseId: string) => ({
        ...item,
        id: `${baseId}:2`,
        attributes: { ...item.attributes, "rep:system:revisionnumber": { type: "int", value: 1 } }
      })
    },
    {
      name: "object class mismatch",
      mutate: (item: any, baseId: string) => ({
        ...item,
        id: `${baseId}:1`,
        objectClass: "folder",
        nativeObjectClass: { ns: "rep", name: "system:folder" },
        attributes: { ...item.attributes, "rep:system:revisionnumber": { type: "int", value: 1 } }
      })
    }
  ] as const;

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const rt = await runtime();
      const adapter: any = rt.adapter;
      const originalRevisions = adapter.revisions.bind(adapter);
      try {
        const search = await opaqueSearch(rt, 1);
        const resultRef = search.results[0].result_ref;
        adapter.revisions = async (request: any) => {
          const [item] = await originalRevisions(request);
          return [scenario.mutate(item, request.id)];
        };
        await assert.rejects(
          () => rt.tools.call(profile(), "arcsuite_list_document_revisions_by_ref", { result_ref: resultRef, limit: 2 }),
          (error: any) => error?.stableCode === "ARCSUITE_UPSTREAM_ERROR"
            && error?.category === "revision_identity"
        );
      } finally {
        rt.stopValidationRetry();
      }
    });
  }
});

test("current content authority uses currentrevisionnumber for legacy and ref-native tools", async (t) => {
  for (const scenario of [
    { name: "live current object without revisionnumber", includeRevision: false },
    { name: "compatible current object with matching revisionnumber", includeRevision: true }
  ] as const) {
    await t.test(scenario.name, async () => {
      const rt = await runtime();
      const adapter: any = rt.adapter;
      const originalGet = adapter.get.bind(adapter);
      try {
        const search: any = (await rt.tools.call(profile(), "arcsuite_search_documents", {
          scope: "example_documents",
          filters: { document_number: "DOC-000001" },
          response_contract: "opaque_refs_v1"
        })).structuredContent;
        adapter.get = async (request: any) => {
          const object = await originalGet(request);
          if (request.revisionNumber !== undefined) return object;
          const attributes: Record<string, unknown> = {
            ...object.attributes,
            "rep:system:currentrevisionnumber": { type: "int", value: 3 }
          };
          if (scenario.includeRevision) {
            attributes["rep:system:revisionnumber"] = { type: "int", value: 3 };
          } else {
            delete attributes["rep:system:revisionnumber"];
          }
          return { ...object, attributes };
        };
        const legacyProfile = profile({
          allowedTools: [...profile().allowedTools, "arcsuite_get_document_content_info"]
        });
        const legacy: any = (await rt.tools.call(legacyProfile, "arcsuite_get_document_content_info", {
          document_id: "rep:mock:EXAMPLE_CABINET:1001"
        })).structuredContent;
        const refNative: any = (await rt.tools.call(profile(), "arcsuite_get_document_content_info_by_ref", {
          result_ref: search.results[0].result_ref
        })).structuredContent;
        assert.equal(legacy.extractable, true);
        assert.equal(refNative.extractable, true);
      } finally {
        rt.stopValidationRetry();
      }
    });
  }
});

test("current content authority fails closed when current revision evidence is missing or inconsistent", async (t) => {
  const scenarios = [
    {
      name: "current and historical attributes disagree",
      mutate: (attributes: Record<string, unknown>) => ({
        ...attributes,
        "rep:system:currentrevisionnumber": { type: "int", value: 3 },
        "rep:system:revisionnumber": { type: "int", value: 2 }
      }),
      category: "content_revision_mismatch"
    },
    {
      name: "current revision attribute is absent",
      mutate: (attributes: Record<string, unknown>) => {
        const changed: Record<string, unknown> = {
          ...attributes,
          "rep:system:revisionnumber": { type: "int", value: 3 }
        };
        delete changed["rep:system:currentrevisionnumber"];
        return changed;
      },
      category: "content_revision_missing"
    }
  ] as const;

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const rt = await runtime();
      const adapter: any = rt.adapter;
      const originalGet = adapter.get.bind(adapter);
      const originalContent = adapter.content.bind(adapter);
      let contentDispatches = 0;
      try {
        const search = await opaqueSearch(rt, 1);
        adapter.get = async (request: any) => {
          const object = await originalGet(request);
          if (request.revisionNumber !== undefined) return object;
          return { ...object, attributes: scenario.mutate(object.attributes) };
        };
        adapter.content = async (...args: unknown[]) => {
          contentDispatches += 1;
          return originalContent(...args);
        };
        await assert.rejects(
          () => rt.tools.call(profile(), "arcsuite_get_document_content_info_by_ref", {
            result_ref: search.results[0].result_ref
          }),
          (error: any) => error?.stableCode === "ARCSUITE_UPSTREAM_ERROR"
            && error?.category === scenario.category
        );
        assert.equal(contentDispatches, 0);
      } finally {
        rt.stopValidationRetry();
      }
    });
  }
});

test("historical content authority never falls back to currentrevisionnumber", async (t) => {
  const scenarios = [
    {
      name: "historical revisionnumber absent",
      mutate: (attributes: Record<string, unknown>) => {
        const changed: Record<string, unknown> = {
          ...attributes,
          "rep:system:currentrevisionnumber": { type: "int", value: 2 }
        };
        delete changed["rep:system:revisionnumber"];
        return changed;
      },
      category: "content_revision_missing"
    },
    {
      name: "historical revisionnumber mismatch",
      mutate: (attributes: Record<string, unknown>) => ({
        ...attributes,
        "rep:system:currentrevisionnumber": { type: "int", value: 2 },
        "rep:system:revisionnumber": { type: "int", value: 3 }
      }),
      category: "content_revision_mismatch"
    }
  ] as const;

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const rt = await runtime();
      const adapter: any = rt.adapter;
      const originalGet = adapter.get.bind(adapter);
      const originalContent = adapter.content.bind(adapter);
      let contentDispatches = 0;
      try {
        const search = await opaqueSearch(rt, 1);
        adapter.get = async (request: any) => {
          const object = await originalGet(request);
          if (request.revisionNumber !== 2) return object;
          return { ...object, attributes: scenario.mutate(object.attributes) };
        };
        adapter.content = async (...args: unknown[]) => {
          contentDispatches += 1;
          return originalContent(...args);
        };
        await assert.rejects(
          () => rt.tools.call(profile(), "arcsuite_get_document_content_info_by_ref", {
            result_ref: search.results[0].result_ref,
            revision_number: 2
          }),
          (error: any) => error?.stableCode === "ARCSUITE_UPSTREAM_ERROR"
            && error?.category === scenario.category
        );
        assert.equal(contentDispatches, 0);
      } finally {
        rt.stopValidationRetry();
      }
    });
  }
});

test("each result-ref public tool requires current allowedTools before provider dispatch", async () => {
  const rt = await runtime();
  const observed = observeProvider(rt);
  try {
    const search = await opaqueSearch(rt, 1);
    const resultRef = search.results[0].result_ref;
    observed.reset();
    for (const { tool, args } of RESULT_REF_TOOL_CASES) {
      const denied = profile({
        allowedTools: profile().allowedTools.filter((allowed: string) => allowed !== tool)
      });
      await assert.rejects(
        () => rt.tools.call(denied, tool, args(resultRef)),
        (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN"
          && error?.category === "tool_not_allowed"
          && error?.retryable === false,
        `${tool} must require its current tool permission`
      );
      assert.deepEqual(observed.calls, [], `${tool} denial must precede provider dispatch`);
    }
  } finally {
    rt.stopValidationRetry();
  }
});

test("expired result refs collapse uniformly before every public result tool dispatch", async () => {
  const rt = await runtime(true, resolve("config/scopes.mock.yaml"), {
    MCP_OPAQUE_REF_TTL_SECONDS: "1"
  });
  const observed = observeProvider(rt);
  try {
    const search = await opaqueSearch(rt, 1);
    const resultRef = search.results[0].result_ref;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_100));
    observed.reset();
    for (const { tool, args } of RESULT_REF_TOOL_CASES) {
      await assert.rejects(
        () => rt.tools.call(profile(), tool, args(resultRef)),
        refUnavailable,
        `${tool} must collapse expiry to ref_unavailable`
      );
      assert.deepEqual(observed.calls, [], `${tool} must reject expiry before provider dispatch`);
    }

    const unavailableSearch = await opaqueSearch(rt, 1);
    const unavailableRef = unavailableSearch.results[0].result_ref;
    rt.handles!.delete(unavailableRef);
    observed.reset();
    for (const { tool, args } of RESULT_REF_TOOL_CASES) {
      await assert.rejects(
        () => rt.tools.call(profile(), tool, args(unavailableRef)),
        refUnavailable,
        `${tool} must collapse a missing store record to the same ref error`
      );
      assert.deepEqual(observed.calls, [], `${tool} must reject a missing record before provider dispatch`);
    }
  } finally {
    rt.stopValidationRetry();
  }
});

test("policy and source-scope mismatch fail every result-ref public tool before provider dispatch", async () => {
  const rt = await runtime();
  const observed = observeProvider(rt);
  try {
    const search = await opaqueSearch(rt, 1);
    const resultRef = search.results[0].result_ref;
    const revokedScope = profile({ allowedScopes: [] });
    observed.reset();
    for (const { tool, args } of RESULT_REF_TOOL_CASES) {
      await assert.rejects(
        () => rt.tools.call(revokedScope, tool, args(resultRef)),
        refUnavailable,
        `${tool} must reject the changed current policy binding`
      );
      assert.deepEqual(observed.calls, [], `${tool} policy mismatch must precede provider dispatch`);
    }
  } finally {
    rt.stopValidationRetry();
  }
});

test("each result-ref public tool performs fresh provider identity hydration", async () => {
  for (const toolCase of RESULT_REF_TOOL_CASES) {
    const rt = await runtime();
    const observed = observeProvider(rt);
    try {
      const search = await opaqueSearch(rt, 1);
      const resultRef = search.results[0].result_ref;
      observed.reset();
      await rt.tools.call(profile(), toolCase.tool, toolCase.args(resultRef));
      assert.equal(
        observed.calls[0],
        toolCase.firstProviderOperation,
        `${toolCase.tool} must begin with current identity hydration`
      );
      if ("downstreamOperation" in toolCase) {
        assert.ok(
          observed.calls.indexOf(toolCase.downstreamOperation) > 0,
          `${toolCase.tool} downstream work must follow identity hydration`
        );
      }
    } finally {
      rt.stopValidationRetry();
    }
  }
});

test("invalid and duplicate result refs keep batch dispatch atomic", async () => {
  const rt = await runtime();
  let batchDispatches = 0;
  const original = (rt.adapter as any).getMany.bind(rt.adapter);
  (rt.adapter as any).getMany = async (...args: unknown[]) => { batchDispatches += 1; return original(...args); };
  try {
    const search = await opaqueSearch(rt, 1);
    batchDispatches = 0;
    await assert.rejects(
      () => rt.tools.call(profile(), "arcsuite_get_documents_by_ref", {
        result_refs: [search.results[0].result_ref, "not-a-ref"]
      }),
      refUnavailable
    );
    assert.equal(batchDispatches, 0);

    await assert.rejects(
      () => rt.tools.call(profile(), "arcsuite_get_documents_by_ref", {
        result_refs: [search.results[0].result_ref, search.results[0].result_ref]
      }),
      (error: any) => error?.stableCode === "ARCSUITE_INVALID_ARGUMENT"
        && error?.category === "invalid_argument"
    );
    assert.equal(batchDispatches, 0);

    const repeatedSearch = await opaqueSearch(rt, 1);
    batchDispatches = 0;
    await assert.rejects(
      () => rt.tools.call(profile(), "arcsuite_get_documents_by_ref", {
        result_refs: [search.results[0].result_ref, repeatedSearch.results[0].result_ref]
      }),
      (error: any) => error?.stableCode === "ARCSUITE_INVALID_ARGUMENT"
        && error?.category === "duplicate_ref_identity"
    );
    assert.equal(batchDispatches, 0);
  } finally {
    rt.stopValidationRetry();
  }
});

test("result-ref batch normalizes provider order and rejects incomplete or ambiguous identity sets", async () => {
  const rt = await runtime();
  const original = (rt.adapter as any).getMany.bind(rt.adapter);
  try {
    const search = await opaqueSearch(rt, 2);
    const refs = search.results.map((item: any) => item.result_ref);
    const expectedNumbers = search.results.map((item: any) => item.semantic_attributes.document_number);
    assert.equal(refs.length, 2);

    (rt.adapter as any).getMany = async (...args: unknown[]) => {
      const batch = await original(...args);
      return { ...batch, objects: [...batch.objects].reverse() };
    };
    const reordered: any = (await rt.tools.call(profile(), "arcsuite_get_documents_by_ref", {
      result_refs: refs
    })).structuredContent;
    assert.deepEqual(reordered.results.map((item: any) => item.result_ref), refs);
    assert.deepEqual(reordered.results.map((item: any) => item.semantic_attributes.document_number), expectedNumbers);

    const invalidBatches = [
      { expected: ["ARCSUITE_UPSTREAM_ERROR", "batch_coverage"], make: (objects: any[]) => ({ objects: objects.slice(0, 1), failures: [] }) },
      { expected: ["ARCSUITE_UPSTREAM_ERROR", "batch_identity"], make: (objects: any[]) => ({ objects: [{ ...objects[0], id: "rep:mock:EXAMPLE_CABINET:unexpected" }, objects[1]], failures: [] }) },
      { expected: ["ARCSUITE_UPSTREAM_ERROR", "batch_identity"], make: (objects: any[]) => ({ objects: [objects[0], structuredClone(objects[0])], failures: [] }) },
      { expected: ["ARCSUITE_FORBIDDEN", "object_identity"], make: (objects: any[]) => ({ objects: [{ ...objects[0], objectClass: "folder", nativeObjectClass: { ns: "rep", name: "system:folder" } }, objects[1]], failures: [] }) }
    ];
    for (const { expected, make } of invalidBatches) {
      (rt.adapter as any).getMany = async (...args: unknown[]) => {
        const batch = await original(...args);
        return make(batch.objects);
      };
      await assert.rejects(
        () => rt.tools.call(profile(), "arcsuite_get_documents_by_ref", { result_refs: refs }),
        (error: any) => error?.stableCode === expected[0] && error?.category === expected[1]
      );
    }
  } finally {
    rt.stopValidationRetry();
  }
});

test("policy/profile changes and revoked source scope fail before any provider operation", async () => {
  const rt = await runtime();
  let dispatches = 0;
  const originalSearch = (rt.adapter as any).searchIds.bind(rt.adapter);
  const originalGet = (rt.adapter as any).get.bind(rt.adapter);
  const originalGetMany = (rt.adapter as any).getMany.bind(rt.adapter);
  (rt.adapter as any).searchIds = async (...args: unknown[]) => { dispatches += 1; return originalSearch(...args); };
  (rt.adapter as any).get = async (...args: unknown[]) => { dispatches += 1; return originalGet(...args); };
  (rt.adapter as any).getMany = async (...args: unknown[]) => { dispatches += 1; return originalGetMany(...args); };
  try {
    const search = await opaqueSearch(rt, 1);
    dispatches = 0;
    for (const changed of [
      profile({ clientProfileId: "other-profile" }),
      profile({ allowedScopes: [] }),
      profile({ allowedTools: ["arcsuite_search_documents", "arcsuite_continue_search"] })
    ]) {
      await assert.rejects(
        () => rt.tools.call(changed, "arcsuite_continue_search", { continuation_ref: search.continuation_ref }),
        refUnavailable
      );
    }
    assert.equal(dispatches, 0);
  } finally {
    rt.stopValidationRetry();
  }
});

test("replay rejects unauthorized or incompatible targets before search dispatch", async () => {
  const rt = await twoScopeRuntime();
  const both = profile({ allowedScopes: ["example_documents", "other_documents"] });
  let searchDispatches = 0;
  const originalSearch = (rt.adapter as any).searchIds.bind(rt.adapter);
  (rt.adapter as any).searchIds = async (...args: unknown[]) => { searchDispatches += 1; return originalSearch(...args); };
  try {
    const source: any = (await rt.tools.call(both, "arcsuite_search_documents", {
      scope: "example_documents",
      filters: { page_count: { operator: "gte", value: 10 } },
      response_contract: "opaque_refs_v1"
    })).structuredContent;
    searchDispatches = 0;
    await assert.rejects(
      () => rt.tools.call(both, "arcsuite_replay_search", { search_ref: source.search_ref, target_scope: "other_documents" }),
      (error: any) => error?.stableCode === "ARCSUITE_INVALID_ARGUMENT"
        && error?.category === "invalid_argument"
        && error?.recovery === "replay_query_incompatible"
    );
    assert.equal(searchDispatches, 0);

    const sourceOnly = profile();
    const sourceOnlySearch = await rt.tools.call(sourceOnly, "arcsuite_search_documents", {
      scope: "example_documents",
      query: "DOC",
      response_contract: "opaque_refs_v1"
    });
    searchDispatches = 0;
    await assert.rejects(
      () => rt.tools.call(sourceOnly, "arcsuite_replay_search", {
        search_ref: (sourceOnlySearch.structuredContent as any).search_ref,
        target_scope: "other_documents"
      }),
      (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN"
    );
    assert.equal(searchDispatches, 0);
  } finally {
    rt.stopValidationRetry();
  }
});

test("mixed-scope result batches are rejected before batch hydration", async () => {
  const rt = await twoScopeRuntime();
  const both = profile({ allowedScopes: ["example_documents", "other_documents"] });
  let batchDispatches = 0;
  const original = (rt.adapter as any).getMany.bind(rt.adapter);
  (rt.adapter as any).getMany = async (...args: unknown[]) => { batchDispatches += 1; return original(...args); };
  try {
    const first = rt.handles!.issueResult({
      profile: both,
      scopeId: "example_documents",
      scope: rt.scopes.get("example_documents")
    }, {
      documentId: "rep:mock:EXAMPLE_CABINET:1001",
      objectClass: "document",
      verificationPlan: []
    });
    const second = rt.handles!.issueResult({
      profile: both,
      scopeId: "other_documents",
      scope: rt.scopes.get("other_documents")
    }, {
      documentId: "rep:mock:OTHER_CABINET:2001",
      objectClass: "document",
      verificationPlan: []
    });
    await assert.rejects(
      () => rt.tools.call(both, "arcsuite_get_documents_by_ref", { result_refs: [first, second] }),
      (error: any) => error?.stableCode === "ARCSUITE_INVALID_ARGUMENT" && error?.category === "mixed_ref_scopes"
    );
    assert.equal(batchDispatches, 0);
  } finally {
    rt.stopValidationRetry();
  }
});

test("result identity and object class are freshly revalidated", async () => {
  const rt = await runtime();
  try {
    const search = await opaqueSearch(rt, 1);
    const original = (rt.adapter as any).get.bind(rt.adapter);
    (rt.adapter as any).get = async (...args: unknown[]) => ({
      ...(await original(...args)),
      id: "rep:mock:EXAMPLE_CABINET:other"
    });
    await assert.rejects(
      () => rt.tools.call(profile(), "arcsuite_get_document_by_ref", { result_ref: search.results[0].result_ref }),
      (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN" && error?.category === "object_identity"
    );
    (rt.adapter as any).get = async (...args: unknown[]) => ({
      ...(await original(...args)),
      objectClass: "folder",
      nativeObjectClass: { ns: "rep", name: "system:folder" }
    });
    await assert.rejects(
      () => rt.tools.call(profile(), "arcsuite_get_document_by_ref", { result_ref: search.results[0].result_ref }),
      (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN" && error?.category === "object_identity"
    );
  } finally {
    rt.stopValidationRetry();
  }
});

test("root mismatch stops a ref-native revision request after base hydration", async () => {
  const rt = await rootedRuntime();
  let revisionDispatches = 0;
  try {
    const search = await opaqueSearch(rt, 1);
    const originalGet = (rt.adapter as any).get.bind(rt.adapter);
    const originalRevisions = (rt.adapter as any).revisions.bind(rt.adapter);
    (rt.adapter as any).get = async (...args: unknown[]) => ({
      ...(await originalGet(...args)),
      pathObjects: [
        { id: "rep:mock:EXAMPLE_CABINET:outside-root", objectClass: "folder", nativeObjectClass: { ns: "rep", name: "system:folder" } },
        { id: "rep:mock:EXAMPLE_CABINET", objectClass: "cabinet", nativeObjectClass: { ns: "rep", name: "system:cabinet" } }
      ],
      fullPath: true
    });
    (rt.adapter as any).revisions = async (...args: unknown[]) => {
      revisionDispatches += 1;
      return originalRevisions(...args);
    };
    await assert.rejects(
      () => rt.tools.call(profile(), "arcsuite_list_document_revisions_by_ref", {
        result_ref: search.results[0].result_ref,
        limit: 2
      }),
      (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN" && error?.category === "root_scope"
    );
    assert.equal(revisionDispatches, 0, "revision history must not run after current root verification fails");
  } finally {
    rt.stopValidationRetry();
  }
});

test("predicate mismatch stops ref-native content work after base hydration", async () => {
  const rt = await runtime();
  let contentDispatches = 0;
  try {
    const search: any = (await rt.tools.call(profile(), "arcsuite_search_documents", {
      scope: "example_documents",
      filters: { document_number: "DOC-000001" },
      response_contract: "opaque_refs_v1"
    })).structuredContent;
    const originalGet = (rt.adapter as any).get.bind(rt.adapter);
    const originalContent = (rt.adapter as any).content.bind(rt.adapter);
    (rt.adapter as any).get = async (...args: unknown[]) => {
      const current = await originalGet(...args);
      return {
        ...current,
        attributes: {
          ...current.attributes,
          "rep:user:example_document_number": { type: "string", value: "DOC-CHANGED" }
        }
      };
    };
    (rt.adapter as any).content = async (...args: unknown[]) => {
      contentDispatches += 1;
      return originalContent(...args);
    };
    await assert.rejects(
      () => rt.tools.call(profile(), "arcsuite_get_document_content_info_by_ref", {
        result_ref: search.results[0].result_ref
      }),
      (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN" && error?.category === "scope_predicate"
    );
    assert.equal(contentDispatches, 0, "content work must not run after current predicate verification fails");
  } finally {
    rt.stopValidationRetry();
  }
});

test("requested historical revisions revalidate stored predicates before metadata or content dispatch", async (t) => {
  const cases = [
    {
      tool: "arcsuite_get_document_by_ref",
      args: (resultRef: string) => ({ result_ref: resultRef, revision_number: 2 }),
      protectsContent: false
    },
    {
      tool: "arcsuite_get_document_content_info_by_ref",
      args: (resultRef: string) => ({ result_ref: resultRef, revision_number: 2 }),
      protectsContent: true
    },
    {
      tool: "arcsuite_read_document_by_ref",
      args: (resultRef: string) => ({ result_ref: resultRef, revision_number: 2, max_chars: 1000 }),
      protectsContent: true
    }
  ] as const;

  for (const toolCase of cases) {
    await t.test(toolCase.tool, async () => {
      const rt = await runtime();
      let contentDispatches = 0;
      const hydratedRevisions: Array<number | undefined> = [];
      try {
        const search: any = (await rt.tools.call(profile(), "arcsuite_search_documents", {
          scope: "example_documents",
          filters: { approved: true },
          response_contract: "opaque_refs_v1"
        })).structuredContent;
        assert.equal(search.results.length, 1);
        const resultRef = search.results[0].result_ref;
        const originalGet = (rt.adapter as any).get.bind(rt.adapter);
        const originalContent = (rt.adapter as any).content.bind(rt.adapter);
        (rt.adapter as any).get = async (request: any) => {
          hydratedRevisions.push(request.revisionNumber);
          const object = await originalGet(request);
          if (request.revisionNumber !== 2) return object;
          return {
            ...object,
            attributes: {
              ...object.attributes,
              "rep:user:approved": { type: "boolean", value: false }
            }
          };
        };
        (rt.adapter as any).content = async (...args: unknown[]) => {
          contentDispatches += 1;
          return originalContent(...args);
        };

        await assert.rejects(
          () => rt.tools.call(profile(), toolCase.tool, toolCase.args(resultRef)),
          (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN"
            && error?.category === "scope_predicate",
          `${toolCase.tool} must apply the stored predicate to the exact requested revision`
        );
        assert.equal(
          hydratedRevisions.includes(2),
          true,
          `${toolCase.tool} must provider-hydrate the exact requested revision`
        );
        if (toolCase.protectsContent) {
          assert.equal(contentDispatches, 0, `${toolCase.tool} must not dispatch content after revision predicate failure`);
        }
      } finally {
        rt.stopValidationRetry();
      }
    });
  }
});

test("matching historical revisions remain available through ref-native metadata and content tools", async () => {
  for (const { tool, args } of [
    {
      tool: "arcsuite_get_document_by_ref",
      args: (resultRef: string) => ({ result_ref: resultRef, revision_number: 2 })
    },
    {
      tool: "arcsuite_get_document_content_info_by_ref",
      args: (resultRef: string) => ({ result_ref: resultRef, revision_number: 2 })
    },
    {
      tool: "arcsuite_read_document_by_ref",
      args: (resultRef: string) => ({ result_ref: resultRef, revision_number: 2, max_chars: 1000 })
    }
  ] as const) {
    const rt = await runtime();
    try {
      const search: any = (await rt.tools.call(profile(), "arcsuite_search_documents", {
        scope: "example_documents",
        filters: { approved: true },
        response_contract: "opaque_refs_v1"
      })).structuredContent;
      const resultRef = search.results[0].result_ref;
      const response: any = (await rt.tools.call(profile(), tool, args(resultRef))).structuredContent;
      assert.equal(response.result_ref, resultRef);
      assert.equal(response.revision_number, 2);
    } finally {
      rt.stopValidationRetry();
    }
  }
});

test("continuation children do not extend expiry and legacy final-page consumption remains destructive", async () => {
  const rt = await runtime();
  const ids = [
    "rep:mock:EXAMPLE_CABINET:1001",
    "rep:mock:EXAMPLE_CABINET:1002",
    "rep:mock:EXAMPLE_CABINET:1003"
  ];
  (rt.adapter as any).searchIds = async () => ids;
  try {
    const first = await opaqueSearch(rt, 1);
    const next: any = (await rt.tools.call(profile(), "arcsuite_continue_search", {
      continuation_ref: first.continuation_ref
    })).structuredContent;
    const context = { profile: profile(), scopeId: "example_documents", scope: rt.scopes.get("example_documents") };
    const parent = rt.handles!.resolve(first.continuation_ref, "continuation", context);
    const child = rt.handles!.resolve(next.continuation_ref, "continuation", context);
    assert.ok(child.expiresAt <= parent.expiresAt);

    const legacy: any = (await rt.tools.call(profile(), "arcsuite_search_documents", {
      scope: "example_documents", query: "DOC", limit: 2
    })).structuredContent;
    await rt.tools.call(profile(), "arcsuite_search_documents", { scope: "example_documents", cursor: legacy.next_cursor });
    await assert.rejects(
      () => rt.tools.call(profile(), "arcsuite_search_documents", { scope: "example_documents", cursor: legacy.next_cursor }),
      (error: any) => error?.stableCode === "ARCSUITE_UPSTREAM_ERROR"
    );
  } finally {
    rt.stopValidationRetry();
  }
});

test("every invalid ref-native operation has zero provider dispatch", async () => {
  const rt = await runtime();
  let dispatches = 0;
  for (const method of ["searchIds", "get", "getMany", "revisions", "content"] as const) {
    const original = (rt.adapter as any)[method].bind(rt.adapter);
    (rt.adapter as any)[method] = async (...args: unknown[]) => { dispatches += 1; return original(...args); };
  }
  const calls: Array<[string, Record<string, unknown>]> = [
    ["arcsuite_continue_search", { continuation_ref: "invalid" }],
    ["arcsuite_replay_search", { search_ref: "invalid", target_scope: "example_documents" }],
    ["arcsuite_get_document_by_ref", { result_ref: "invalid" }],
    ["arcsuite_get_documents_by_ref", { result_refs: ["invalid"] }],
    ["arcsuite_list_document_revisions_by_ref", { result_ref: "invalid" }],
    ["arcsuite_get_document_content_info_by_ref", { result_ref: "invalid" }],
    ["arcsuite_read_document_by_ref", { result_ref: "invalid" }]
  ];
  try {
    for (const [tool, input] of calls) {
      await assert.rejects(() => rt.tools.call(profile(), tool, input), refUnavailable);
    }
    assert.equal(dispatches, 0);
  } finally {
    rt.stopValidationRetry();
  }
});

test("read_document_by_ref rejects a valid cursor bound to another result document", async () => {
  const rt = await runtime();
  let contentDispatches = 0;
  try {
    const search = await opaqueSearch(rt, 2);
    const documentA = search.results.find((item: any) => item.semantic_attributes?.document_number === "DOC-000001");
    const documentB = search.results.find((item: any) => item.semantic_attributes?.document_number === "DOC-000002");
    assert.equal(typeof documentA?.result_ref, "string");
    assert.equal(typeof documentB?.result_ref, "string");

    const originalContent = (rt.adapter as any).content.bind(rt.adapter);
    (rt.adapter as any).content = async (...args: unknown[]) => {
      contentDispatches += 1;
      const content = await originalContent(...args);
      const request = args[0] as { requestedId?: string };
      if (request.requestedId === "rep:mock:EXAMPLE_CABINET:1002") {
        const text = `${"Synthetic document B content.\n".repeat(160)}`;
        await writeFile(content.filePath, text, "utf8");
        return { ...content, sizeBytes: Buffer.byteLength(text) };
      }
      return content;
    };

    const readB: any = (await rt.tools.call(profile(), "arcsuite_read_document_by_ref", {
      result_ref: documentB.result_ref,
      max_chars: 1000
    })).structuredContent;
    assert.equal(typeof readB.next_cursor, "string", "document B must produce a valid bounded content cursor");

    contentDispatches = 0;
    let failure: any;
    try {
      await rt.tools.call(profile(), "arcsuite_read_document_by_ref", {
        result_ref: documentA.result_ref,
        cursor: readB.next_cursor,
        max_chars: 1000
      });
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.stableCode, "ARCSUITE_INVALID_ARGUMENT");
    assert.equal(failure?.category, "invalid_cursor");
    assert.equal(failure?.retryable, false);
    assert.equal(contentDispatches, 0, "cross-document cursor rejection must precede content dispatch");
    const publicError = JSON.stringify({
      code: failure?.stableCode,
      category: failure?.category,
      retryable: failure?.retryable,
      recovery: failure?.recovery,
      message: failure?.message
    });
    for (const authority of [documentA.result_ref, readB.next_cursor, "rep:mock:EXAMPLE_CABINET:1001", "rep:mock:EXAMPLE_CABINET:1002"]) {
      assert.equal(publicError.includes(authority), false, "public cursor failure must not expose internal authority");
    }
    const readAuditRecords = (await readFile(rt.config.auditLogPath, "utf8"))
      .trim()
      .split("\n")
      .filter((line) => JSON.parse(line).tool_name === "arcsuite_read_document_by_ref");
    const failureAudit = readAuditRecords.at(-1) ?? "";
    for (const authority of [documentA.result_ref, readB.next_cursor, "rep:mock:EXAMPLE_CABINET:1001", "rep:mock:EXAMPLE_CABINET:1002"]) {
      assert.equal(failureAudit.includes(authority), false, "audit must not expose cross-document authority");
    }
  } finally {
    rt.stopValidationRetry();
  }
});

test("P2 audit records contain no raw refs or newly logged document identities", async () => {
  const rt = await runtime();
  try {
    const search = await opaqueSearch(rt, 1);
    const resultRef = search.results[0].result_ref;
    await rt.tools.call(profile(), "arcsuite_get_document_by_ref", { result_ref: resultRef });
    let audit = "";
    for (const line of (await readFile(rt.config.auditLogPath, "utf8")).trim().split("\n")) {
      if (JSON.parse(line).tool_name === "arcsuite_get_document_by_ref") audit = line;
    }
    assert.equal(audit.includes(resultRef), false);
    assert.equal(audit.includes("rep:mock:EXAMPLE_CABINET:1001"), false);
    assert.equal(audit.includes("documentId"), false);
    assert.equal(audit.includes("policyFingerprint"), false);
  } finally {
    rt.stopValidationRetry();
  }
});

function refUnavailable(error: unknown): boolean {
  const value = error as { stableCode?: string; category?: string; retryable?: boolean; recovery?: string };
  return value?.stableCode === "ARCSUITE_REF_UNAVAILABLE"
    && value.category === "ref_unavailable"
    && value.retryable === false
    && value.recovery === "search_again";
}
