import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRuntime } from "../../src/server.ts";
import type { AdapterRepositoryObject } from "../../src/arcsuite/types.ts";

const opaqueKeyring = JSON.stringify({
  active_kid: "test-active",
  keys: [{ kid: "test-active", secret_base64url: Buffer.alloc(32, 0x5a).toString("base64url") }]
});

async function runtime(enabled: boolean, overrides: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "arcsuite-mcp-opaque-refs-"));
  const rt = await buildRuntime({
    ...process.env,
    NODE_ENV: "test",
    ARCSUITE_ADAPTER_MODE: "mock",
    MCP_DEV_BEARER_TOKEN: "test-token",
    MCP_SCOPES_FILE: resolve("config/scopes.mock.yaml"),
    MCP_SHARED_TEMP_DIR: join(dir, "shared"),
    MCP_AUDIT_LOG_PATH: join(dir, "audit.jsonl"),
    MCP_CURSOR_HMAC_SECRET: "0123456789abcdef0123456789abcdef",
    MCP_VALIDATE_ON_STARTUP: "true",
    MCP_OPAQUE_REFS_ENABLED: String(enabled),
    ...(enabled ? { MCP_OPAQUE_REF_KEYS_JSON: opaqueKeyring } : {}),
    ...overrides
  });
  return { rt, auditPath: join(dir, "audit.jsonl") };
}

function profile() {
  return {
    tokenSha256: createHash("sha256").update("test-token").digest("hex"),
    clientProfileId: "dev-profile",
    allowedScopes: ["example_documents"],
    allowedTools: ["arcsuite_search_documents"],
    rateLimit: { requestsPerMinute: 120, burst: 30 }
  };
}

function document(id: string): AdapterRepositoryObject {
  return {
    id,
    objectClass: "document",
    nativeObjectClass: { ns: "rep", name: "system:document" },
    attributes: {
      "rep:system:name": { type: "string", value: "synthetic.pdf" },
      "rep:user:example_document_number": { type: "string", value: "DOC-000001" },
      "rep:system:modifiedon": { type: "datetime", value: "2026-09-01T03:00:00Z" },
      "rep:user:page_count": { type: "long", value: 10 },
      "rep:user:approved": { type: "boolean", value: true },
      "rep:user:quality_score": { type: "double", value: 0.95 },
      "rep:user:published_on": { type: "date", value: "2026-09-01" },
      "rep:system:status": { type: "i18n", ns: "rep", name: "ACTIVE" }
    }
  };
}

test("opaque feature is opt-in and legacy output stays exact when omitted or explicit", async () => {
  const { rt } = await runtime(false);
  const original = (rt.adapter as any).searchIds.bind(rt.adapter);
  let dispatches = 0;
  (rt.adapter as any).searchIds = async (...args: unknown[]) => { dispatches += 1; return original(...args); };
  try {
    for (const responseContract of [undefined, "legacy"] as const) {
      const args: Record<string, unknown> = { scope: "example_documents", filters: { document_number: "DOC-000001" } };
      if (responseContract) args.response_contract = responseContract;
      const data: any = (await rt.tools.call(profile(), "arcsuite_search_documents", args)).structuredContent;
      assert.deepEqual(Object.keys(data).sort(), ["applied_query", "count", "failures", "limit", "next_cursor", "results", "scope", "snapshot_limited", "truncated"]);
      assert.equal(data.results.some((item: any) => Object.hasOwn(item, "result_ref")), false);
      assert.equal(data.results[0].document_id, "rep:mock:EXAMPLE_CABINET:1001");
      assert.equal(data.applied_query.filters.predicates[0].name, "document_number");
    }
    await assert.rejects(
      () => rt.tools.call(profile(), "arcsuite_search_documents", { scope: "example_documents", query: "DOC", response_contract: "opaque_refs_v1" }),
      (error: any) => error?.stableCode === "ARCSUITE_NOT_AVAILABLE" && error?.category === "opaque_refs_unavailable"
    );
    assert.equal(dispatches, 2);
  } finally {
    rt.stopValidationRetry();
  }
});

test("invalid negotiation is rejected before provider dispatch", async () => {
  const { rt } = await runtime(true);
  let dispatches = 0;
  (rt.adapter as any).searchIds = async () => { dispatches += 1; return []; };
  try {
    await assert.rejects(
      () => rt.tools.call(profile(), "arcsuite_search_documents", { scope: "example_documents", query: "DOC", response_contract: "unknown" }),
      (error: any) => error?.stableCode === "ARCSUITE_INVALID_ARGUMENT"
    );
    await assert.rejects(
      () => rt.tools.call(profile(), "arcsuite_search_documents", { scope: "example_documents", cursor: "opaque", response_contract: "opaque_refs_v1" }),
      (error: any) => error?.stableCode === "ARCSUITE_INVALID_ARGUMENT"
    );
    assert.equal(dispatches, 0);
  } finally {
    rt.stopValidationRetry();
  }
});

test("opaque zero-result search emits only a valid search ref", async () => {
  const { rt } = await runtime(true);
  (rt.adapter as any).searchIds = async () => [];
  try {
    const data: any = (await rt.tools.call(profile(), "arcsuite_search_documents", {
      scope: "example_documents",
      filters: { page_count: 10 },
      response_contract: "opaque_refs_v1"
    })).structuredContent;
    assert.equal(data.count, 0);
    assert.deepEqual(data.results, []);
    assert.equal(typeof data.search_ref, "string");
    assert.equal(data.continuation_ref, null);
    const record = rt.handles?.resolve(data.search_ref, "search", {
      profile: profile(), scopeId: "example_documents", scope: rt.scopes.get("example_documents")
    });
    assert.equal(record?.kind, "search");
    if (record?.kind === "search") {
      assert.equal(record.authority.scopeId, "example_documents");
      assert.equal(record.authority.appliedQuery.filters.predicates[0].value, 10);
      assert.equal(record.authority.pageSize, data.limit);
    }
  } finally {
    rt.stopValidationRetry();
  }
});

test("verified results receive distinct identity-bound refs and failures never do", async () => {
  const { rt } = await runtime(true);
  const ids = ["rep:mock:EXAMPLE_CABINET:opaque-1", "rep:mock:EXAMPLE_CABINET:opaque-2", "rep:mock:EXAMPLE_CABINET:opaque-failed"];
  (rt.adapter as any).searchIds = async () => ids;
  (rt.adapter as any).getMany = async () => ({
    objects: ids.slice(0, 2).map(document),
    failures: [{ index: 2, code: "ARCSUITE_NOT_AVAILABLE" }]
  });
  try {
    const data: any = (await rt.tools.call(profile(), "arcsuite_search_documents", {
      scope: "example_documents", query: "provider-term", response_contract: "opaque_refs_v1"
    })).structuredContent;
    assert.equal(data.results.length, 2);
    assert.equal(data.failures.length, 1);
    assert.equal(Object.hasOwn(data.failures[0], "result_ref"), false);
    assert.equal(new Set(data.results.map((item: any) => item.result_ref)).size, 2);
    for (const result of data.results) {
      const record = rt.handles?.resolve(result.result_ref, "result", {
        profile: profile(), scopeId: "example_documents", scope: rt.scopes.get("example_documents")
      });
      assert.equal(record?.kind, "result");
      if (record?.kind === "result") {
        assert.equal(record.documentId, result.document_id);
        assert.equal(record.objectClass, result.object_class);
      }
      for (const privateValue of [result.document_id, "provider-term", "dev-profile", "example_documents"]) {
        assert.equal(result.result_ref.includes(privateValue), false);
      }
    }
  } finally {
    rt.stopValidationRetry();
  }
});

test("global handle pressure rejects a search atomically without evicting another profile", async () => {
  const { rt } = await runtime(true, {
    MCP_SEARCH_DEFAULT_LIMIT: "2",
    MCP_SEARCH_MAX_LIMIT: "2",
    MCP_OPAQUE_REF_MAX_ENTRIES: "4",
    MCP_OPAQUE_REF_MAX_ENTRIES_PER_PROFILE: "4"
  });
  const victim = {
    ...profile(),
    clientProfileId: "synthetic-profile-b",
    tokenSha256: createHash("sha256").update("synthetic-token-b").digest("hex")
  };
  const authority = {
    scopeId: "example_documents",
    appliedQuery: { operator: "and" as const, filters: { operator: "and" as const, predicates: [] }, text: null },
    includePath: false,
    pageSize: 2
  };
  const victimRefs = Array.from({ length: 4 }, () => rt.handles!.issueSearch({
    profile: victim,
    scopeId: "example_documents",
    scope: rt.scopes.get("example_documents")
  }, authority));
  const ids = ["rep:mock:EXAMPLE_CABINET:opaque-1", "rep:mock:EXAMPLE_CABINET:opaque-2"];
  (rt.adapter as any).searchIds = async () => ids;
  (rt.adapter as any).getMany = async (request: any) => ({ objects: request.ids.map(document), failures: [] });
  try {
    await assert.rejects(
      () => rt.tools.call(profile(), "arcsuite_search_documents", {
        scope: "example_documents",
        query: "synthetic",
        limit: 2,
        response_contract: "opaque_refs_v1"
      }),
      (error: any) => error?.stableCode === "ARCSUITE_NOT_AVAILABLE" && error?.category === "opaque_ref_capacity"
    );
    for (const ref of victimRefs) {
      assert.equal(rt.handles!.resolve(ref, "search", {
        profile: victim,
        scopeId: "example_documents",
        scope: rt.scopes.get("example_documents")
      }).kind, "search");
    }
  } finally {
    rt.stopValidationRetry();
  }
});

test("cursor continuation inherits opaque contract without changing the legacy cursor", async () => {
  const { rt } = await runtime(true, { MCP_SEARCH_DEFAULT_LIMIT: "1", MCP_SEARCH_MAX_LIMIT: "2" });
  const ids = ["rep:mock:EXAMPLE_CABINET:opaque-1", "rep:mock:EXAMPLE_CABINET:opaque-2"];
  let searchDispatches = 0;
  (rt.adapter as any).searchIds = async () => { searchDispatches += 1; return ids; };
  (rt.adapter as any).getMany = async (request: any) => ({ objects: request.ids.map(document), failures: [] });
  try {
    const first: any = (await rt.tools.call(profile(), "arcsuite_search_documents", {
      scope: "example_documents", query: "provider-term", limit: 1, response_contract: "opaque_refs_v1"
    })).structuredContent;
    assert.equal(typeof first.next_cursor, "string");
    assert.equal(typeof first.continuation_ref, "string");
    const continuation = rt.handles?.resolve(first.continuation_ref, "continuation", {
      profile: profile(), scopeId: "example_documents", scope: rt.scopes.get("example_documents")
    });
    assert.equal(continuation?.kind, "continuation");
    if (continuation?.kind === "continuation") assert.equal(continuation.cursor, first.next_cursor);

    const second: any = (await rt.tools.call(profile(), "arcsuite_search_documents", {
      scope: "example_documents", cursor: first.next_cursor
    })).structuredContent;
    assert.equal(typeof second.search_ref, "string");
    assert.equal(typeof second.results[0].result_ref, "string");
    assert.equal(second.continuation_ref, null);
    assert.equal(second.next_cursor, null);
    assert.equal(searchDispatches, 1);
    const firstSearchRecord = rt.handles?.resolve(first.search_ref, "search", {
      profile: profile(), scopeId: "example_documents", scope: rt.scopes.get("example_documents")
    });
    const secondSearchRecord = rt.handles?.resolve(second.search_ref, "search", {
      profile: profile(), scopeId: "example_documents", scope: rt.scopes.get("example_documents")
    });
    assert.equal(firstSearchRecord?.kind, "search");
    assert.equal(secondSearchRecord?.kind, "search");
    if (firstSearchRecord?.kind === "search" && secondSearchRecord?.kind === "search") {
      assert.deepEqual(secondSearchRecord.authority, firstSearchRecord.authority);
    }

    const legacyFirst: any = (await rt.tools.call(profile(), "arcsuite_search_documents", {
      scope: "example_documents", query: "provider-term", limit: 1
    })).structuredContent;
    const legacySecond: any = (await rt.tools.call(profile(), "arcsuite_search_documents", {
      scope: "example_documents", cursor: legacyFirst.next_cursor
    })).structuredContent;
    assert.equal(Object.hasOwn(legacyFirst, "search_ref"), false);
    assert.equal(Object.hasOwn(legacySecond, "search_ref"), false);
    assert.equal(Object.hasOwn(legacySecond.results[0], "result_ref"), false);
  } finally {
    rt.stopValidationRetry();
  }
});

test("audit output does not contain refs, locators, decoded records, queries, keys, or fingerprints", async () => {
  const { rt, auditPath } = await runtime(true);
  (rt.adapter as any).searchIds = async () => [];
  try {
    const query = "private-synthetic-query";
    const data: any = (await rt.tools.call(profile(), "arcsuite_search_documents", {
      scope: "example_documents", query, response_contract: "opaque_refs_v1"
    })).structuredContent;
    const locator = JSON.parse(Buffer.from(data.search_ref.split(".")[1], "base64url").toString("utf8")).loc;
    const audit = await readFile(auditPath, "utf8");
    for (const forbidden of [data.search_ref, locator, query, "test-active", "policyFingerprint", "canonicalAuthority"]) {
      assert.equal(audit.includes(forbidden), false);
    }
  } finally {
    rt.stopValidationRetry();
  }
});
