import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRuntime } from "../../src/server.ts";
import { ArcSuiteAdapterError } from "../../src/arcsuite/errors.ts";
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

test("applied query uses canonical values and the same terms and operators as the adapter request", async () => {
  const rt = await runtime();
  const id = "rep:mock:EXAMPLE_CABINET:synthetic-1";
  let searchRequest: any;
  rt.adapter.searchIds = async (request: any) => {
    searchRequest = structuredClone(request);
    return [id];
  };
  rt.adapter.getMany = async () => ({ objects: [document(id, baseAttributes)], failures: [] });
  const call = await rt.tools.call(profile(), "arcsuite_search_documents", {
    scope: "example_documents",
    query: " annual   report annual \"AND\" OR * ",
    query_mode: "or",
    text_search_mode: "stemming",
    filters: {
      document_number: "DOC-000001",
      name: "*.pdf",
      page_count: { operator: "gte", value: 10 },
      approved: true,
      quality_score: { operator: "gte", value: 0.9 },
      published_on: { operator: "gte", value: "2026-09-01" },
      modified_after: "2026-09-01T00:00:00+09:00",
      lifecycle: "active"
    }
  });
  const result: any = call.structuredContent;
  assert.deepEqual(result.applied_query, {
    operator: "and",
    filters: {
      operator: "and",
      predicates: [
        { name: "document_number", type: "string", operator: "eq", value: "DOC-000001" },
        { name: "name", type: "string", operator: "like", value: "*.pdf" },
        { name: "page_count", type: "integer", operator: "gte", value: 10 },
        { name: "approved", type: "boolean", operator: "eq", value: true },
        { name: "quality_score", type: "number", operator: "gte", value: 0.9 },
        { name: "published_on", type: "date", operator: "gte", value: "2026-09-01" },
        { name: "modified_after", type: "datetime", operator: "gte", value: "2026-08-31T15:00:00.000Z" },
        { name: "lifecycle", type: "enum", operator: "eq", value: "active" }
      ]
    },
    text: { terms: ["annual", "report", "annual", "\"AND\"", "OR", "*"], operator: "or", mode: "stemming" }
  });
  assert.deepEqual(searchRequest.text, { words: result.applied_query.text.terms, operator: "OR" });
  assert.equal(searchRequest.mode, "AND");
  assert.equal(searchRequest.textSearchMode, "STEMMING");
  assert.equal(searchRequest.attributeConditions.length, result.applied_query.filters.predicates.length);
  assert.deepEqual(searchRequest.attributeConditions.map((condition: any) => condition.operator), [
    "EQUAL", "LIKE", "GREATER_EQUAL", "EQUAL", "GREATER_EQUAL", "GREATER_EQUAL", "GREATER_EQUAL", "EQUAL"
  ]);
  assert.deepEqual(searchRequest.attributeConditions.map((condition: any) => "value" in condition.value
    ? condition.value.value
    : `${condition.value.ns}:${condition.value.name}`), [
    "DOC-000001", "*.pdf", 10, true, 0.9, "2026-09-01", "2026-08-31T15:00:00.000Z", "rep:ACTIVE"
  ]);
  assert.equal(JSON.stringify(result).includes("user:example_document_number"), false);
  assert.equal(JSON.stringify(result).includes("rep:ACTIVE"), false);
  assert.equal(call.content[0].text.includes(JSON.stringify(result)), true);
  rt.stopValidationRetry();
});

test("string-valued and I18N enum aliases remain semantic in structured and text responses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arcsuite-mcp-enum-aliases-"));
  const scopeFile = join(dir, "scopes.yaml");
  await writeFile(scopeFile, `version: 1
scopes:
  example_documents:
    description: Synthetic enum alias scope
    enabled: true
    arcsuite:
      cabinet_alias: EXAMPLE_CABINET
      cabinet_id: rep:mock:EXAMPLE_CABINET
      root_object_id: null
      resolve_references: true
    allowed_object_types: [document]
    default_attr_ids:
      - {ns: rep, name: system:name}
    search:
      full_text_modes: [none]
    semantic_attributes:
      string_state:
        attr_id: {ns: rep, name: user:string_state}
        type: enum
        operators: [eq]
        values:
          open: {value: SYNTHETIC_STRING_STATE_OPEN}
      i18n_state:
        attr_id: {ns: rep, name: user:i18n_state}
        type: enum
        operators: [eq]
        values:
          active: {ns: rep, name: ACTIVE}
`);
  const rt = await runtime(scopeFile, { MCP_VALIDATE_ON_STARTUP: "false" });
  try {
    const adapter: any = rt.adapter;
    const schemaFor = (attrId: { ns: string; name: string }) => {
      const base = {
        ...attrId,
        searchable: true,
        sortable: true,
        modifiable: false,
        multiValued: false,
        required: false,
        minInclusive: true,
        maxInclusive: true
      };
      if (attrId.name === "user:string_state") {
        return { ...base, dataType: "STRING_TYPE", enumerated: true, minLength: 1, maxLength: 255 };
      }
      if (attrId.name === "user:i18n_state") {
        return { ...base, dataType: "I18N_STRING_TYPE", enumerated: true, enumLabels: [{ ns: "rep", name: "ACTIVE", label: "Synthetic active" }] };
      }
      return { ...base, dataType: "STRING_TYPE", minLength: 1, maxLength: 255 };
    };
    adapter.validateSchema = async (request: any) => ({
      ok: true,
      version: { minVersion: "4.0.0.0", curVersion: "4.0.0.0" },
      cabinet: { id: request.cabinetId, label: "Synthetic cabinet", hasRecycleBin: true },
      attributes: request.attributes.map(({ attrId }: any) => schemaFor(attrId)),
      errors: []
    });
    assert.equal(await rt.validate(), true);

    const id = "rep:mock:EXAMPLE_CABINET:synthetic-enum-1";
    let searchRequest: any;
    adapter.searchIds = async (request: any) => {
      searchRequest = structuredClone(request);
      return [id];
    };
    adapter.getMany = async () => ({
      objects: [document(id, {
        "rep:system:name": { type: "string", value: "synthetic-enum.pdf" },
        "rep:user:string_state": { type: "string", value: "SYNTHETIC_STRING_STATE_OPEN" },
        "rep:user:i18n_state": { type: "i18n", ns: "rep", name: "ACTIVE" }
      })],
      failures: []
    });

    const call = await rt.tools.call(profile(), "arcsuite_search_documents", {
      scope: "example_documents",
      query: "synthetic",
      filters: { string_state: "open", i18n_state: "active" }
    });
    const result: any = call.structuredContent;
    assert.deepEqual(result.results[0].semantic_attributes, { string_state: "open", i18n_state: "active" });
    assert.deepEqual(result.applied_query.filters.predicates, [
      { name: "string_state", type: "enum", operator: "eq", value: "open" },
      { name: "i18n_state", type: "enum", operator: "eq", value: "active" }
    ]);
    assert.deepEqual(searchRequest.attributeConditions.map((condition: any) => "value" in condition.value
      ? condition.value.value
      : `${condition.value.ns}:${condition.value.name}`), ["SYNTHETIC_STRING_STATE_OPEN", "rep:ACTIVE"]);
    const text = call.content.map((entry) => entry.text).join(" ");
    assert.equal(text.includes("\"string_state\":\"open\""), true);
    assert.equal(text.includes("\"i18n_state\":\"active\""), true);
    assert.equal(text.includes("SYNTHETIC_STRING_STATE_OPEN"), false);
    assert.equal(text.includes("rep:ACTIVE"), false);
    assert.equal(JSON.stringify(result).includes("SYNTHETIC_STRING_STATE_OPEN"), false);
    assert.equal(JSON.stringify(result).includes("rep:ACTIVE"), false);
  } finally {
    rt.stopValidationRetry();
  }
});

test("resolved composition drives adapter requests for filter-only, text-only, mixed, and empty text", async () => {
  const cases: Array<{ name: string; args: Record<string, unknown>; applied: any }> = [
    {
      name: "filter-only OR",
      args: { scope: "example_documents", query_mode: "or", filters: { page_count: 10 } },
      applied: {
        operator: "or",
        filters: { operator: "and", predicates: [{ name: "page_count", type: "integer", operator: "eq", value: 10 }] },
        text: null
      }
    },
    {
      name: "text-only AND",
      args: { scope: "example_documents", query: "annual report", query_mode: "and" },
      applied: {
        operator: "and",
        filters: { operator: "and", predicates: [] },
        text: { terms: ["annual", "report"], operator: "and", mode: "none" }
      }
    },
    {
      name: "text-only OR",
      args: { scope: "example_documents", query: "annual report", query_mode: "or" },
      applied: {
        operator: "or",
        filters: { operator: "and", predicates: [] },
        text: { terms: ["annual", "report"], operator: "or", mode: "none" }
      }
    },
    {
      name: "mixed",
      args: {
        scope: "example_documents",
        query: "annual report",
        query_mode: "or",
        text_search_mode: "stemming",
        filters: { page_count: { operator: "gte", value: 10 } }
      },
      applied: {
        operator: "and",
        filters: { operator: "and", predicates: [{ name: "page_count", type: "integer", operator: "gte", value: 10 }] },
        text: { terms: ["annual", "report"], operator: "or", mode: "stemming" }
      }
    },
    {
      name: "whitespace text",
      args: { scope: "example_documents", query: " \t\n ", query_mode: "or", filters: { page_count: 10 } },
      applied: {
        operator: "or",
        filters: { operator: "and", predicates: [{ name: "page_count", type: "integer", operator: "eq", value: 10 }] },
        text: null
      }
    }
  ];

  for (const current of cases) {
    const rt = await runtime();
    try {
      let searchRequest: any;
      rt.adapter.searchIds = async (request: any) => {
        searchRequest = structuredClone(request);
        return [];
      };
      const result: any = (await rt.tools.call(profile(), "arcsuite_search_documents", current.args)).structuredContent;
      assert.deepEqual(result.applied_query, current.applied, current.name);
      assert.deepEqual(searchRequest.text, current.applied.text
        ? { words: current.applied.text.terms, operator: current.applied.text.operator.toUpperCase() }
        : undefined, current.name);
      assert.equal(searchRequest.mode, String(current.applied.operator).toUpperCase(), current.name);
      assert.equal(searchRequest.textSearchMode, String(current.applied.text?.mode ?? "none").toUpperCase(), current.name);
      assert.equal(searchRequest.attributeConditions.length, current.applied.filters.predicates.length, current.name);
    } finally {
      rt.stopValidationRetry();
    }
  }
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

test("malformed batch failure codes fail closed before public output", async () => {
  const id = "rep:mock:EXAMPLE_CABINET:synthetic-2";
  for (const failure of [
    { index: 0 },
    { index: 0, code: undefined },
    { index: 0, code: "" },
    { index: 0, code: " \t" },
    { index: 0, code: 0 }
  ] as any[]) {
    const rt = await runtime();
    try {
      installSearch(rt.adapter, [id], [], [failure]);
      await assert.rejects(
        () => rt.tools.call(profile(), "arcsuite_search_documents", { scope: "example_documents", query: "provider-indexed-term" }),
        (error: any) => error?.stableCode === "ARCSUITE_UPSTREAM_ERROR" && error?.category === "batch_failure_code"
      );
    } finally {
      rt.stopValidationRetry();
    }
  }
});

test("provider failures remain distinct from successful zero results", async () => {
  const rt = await runtime();
  rt.adapter.searchIds = async () => { throw new Error("synthetic provider fault"); };
  await assert.rejects(() => rt.tools.call(profile(), "arcsuite_search_documents", { scope: "example_documents", query: "provider-term" }), /ARCSUITE_UPSTREAM_ERROR/);
  const audit = JSON.parse((await readFile(rt.config.auditLogPath, "utf8")).trim().split("\n").at(-1)!);
  assert.equal(audit.search_outcome, "provider_failure");
  rt.stopValidationRetry();
});

test("search errors expose no query and do not log an applied query", async () => {
  const rt = await runtime();
  const privateQuery = "SYNTHETIC_PRIVATE_SEARCH_QUERY";
  rt.adapter.searchIds = async () => {
    throw new ArcSuiteAdapterError("ARCSUITE_UPSTREAM_ERROR", privateQuery);
  };
  try {
    let mappedError: any;
    await assert.rejects(
      () => rt.tools.call(profile(), "arcsuite_search_documents", { scope: "example_documents", query: privateQuery }),
      (error: any) => {
        mappedError = error;
        return error?.stableCode === "ARCSUITE_UPSTREAM_ERROR";
      }
    );
    assert.equal(mappedError.message, "ARCSUITE_UPSTREAM_ERROR");
    assert.equal(mappedError.message.includes(privateQuery), false);
    const audit = await readFile(rt.config.auditLogPath, "utf8");
    assert.equal(audit.includes(privateQuery), false);
    assert.equal(audit.includes("applied_query"), false);
  } finally {
    rt.stopValidationRetry();
  }
});

test("malformed provider ID results fail closed instead of becoming zero results", async () => {
  for (const value of ["", null, {}, [42]]) {
    const rt = await runtime();
    try {
      rt.adapter.searchIds = async () => value as any;
      await assert.rejects(
        () => rt.tools.call(profile(), "arcsuite_search_documents", { scope: "example_documents", query: "provider-term" }),
        (error: any) => error?.stableCode === "ARCSUITE_UPSTREAM_ERROR" && error?.category === "search_ids_shape"
      );
      const audit = JSON.parse((await readFile(rt.config.auditLogPath, "utf8")).trim().split("\n").at(-1)!);
      assert.equal(audit.search_outcome, "provider_failure");
    } finally {
      rt.stopValidationRetry();
    }
  }
});

test("provider-originated forbidden search failures are audited as provider failures", async () => {
  const rt = await runtime();
  try {
    rt.adapter.searchIds = async () => {
      throw new ArcSuiteAdapterError("ARCSUITE_FORBIDDEN", "synthetic provider refusal");
    };
    await assert.rejects(
      () => rt.tools.call(profile(), "arcsuite_search_documents", { scope: "example_documents", query: "provider-term" }),
      (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN"
    );
    const audit = JSON.parse((await readFile(rt.config.auditLogPath, "utf8")).trim().split("\n").at(-1)!);
    assert.equal(audit.search_outcome, "provider_failure");
  } finally {
    rt.stopValidationRetry();
  }
});

test("caller-side forbidden search scope has no provider outcome", async () => {
  const rt = await runtime();
  try {
    await assert.rejects(
      () => rt.tools.call({ ...profile(), allowedScopes: [] }, "arcsuite_search_documents", { scope: "example_documents", query: "provider-term" }),
      (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN"
    );
    const audit = JSON.parse((await readFile(rt.config.auditLogPath, "utf8")).trim().split("\n").at(-1)!);
    assert.equal(Object.hasOwn(audit, "search_outcome"), false);
    assert.deepEqual(audit.soap_operations, []);
  } finally {
    rt.stopValidationRetry();
  }
});

test("LIKE-only searches retain per-ID hydration failures", async () => {
  const rt = await runtime();
  const id = "rep:mock:EXAMPLE_CABINET:synthetic-1";
  const failedId = "rep:mock:EXAMPLE_CABINET:synthetic-2";
  installSearch(rt.adapter, [id, failedId], [document(id, baseAttributes)], [{ index: 1, code: "ARCSUITE_NOT_AVAILABLE" }]);
  const result: any = (await rt.tools.call(profile(), "arcsuite_search_documents", { scope: "example_documents", filters: { name: "*.pdf" } })).structuredContent;
  assert.equal(result.count, 1);
  assert.deepEqual(result.applied_query, {
    operator: "and",
    filters: { operator: "and", predicates: [{ name: "name", type: "string", operator: "like", value: "*.pdf" }] },
    text: null
  });
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
  assert.deepEqual(result.applied_query, {
    operator: "and",
    filters: { operator: "and", predicates: [] },
    text: { terms: ["provider-indexed-term"], operator: "and", mode: "stemming" }
  });
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
  assert.deepEqual(result.applied_query, {
    operator: "and",
    filters: { operator: "and", predicates: [] },
    text: { terms: ["provider-indexed-term"], operator: "and", mode: "stemming" }
  });
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
  assert.deepEqual(result.applied_query, {
    operator: "and",
    filters: { operator: "and", predicates: [{ name: "page_count", type: "integer", operator: "eq", value: 10 }] },
    text: null
  });
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.failures, []);
  assert.equal(hydrated, false);
  const audit = JSON.parse((await readFile(rt.config.auditLogPath, "utf8")).trim().split("\n").at(-1)!);
  assert.equal(audit.search_outcome, "zero");
  rt.stopValidationRetry();
});

test("search response keeps the public top-level shape with applied query", async () => {
  const rt = await runtime();
  const id = "rep:mock:EXAMPLE_CABINET:synthetic-1";
  installSearch(rt.adapter, [id], [document(id, baseAttributes)]);
  const result: any = (await rt.tools.call(profile(), "arcsuite_search_documents", { scope: "example_documents", query: "provider-term" })).structuredContent;
  assert.deepEqual(Object.keys(result).sort(), ["applied_query", "count", "failures", "limit", "next_cursor", "results", "scope", "snapshot_limited", "truncated"]);
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

test("mixed continuation preserves the full applied query without rerunning search", async () => {
  const rt = await runtime(undefined, { MCP_SEARCH_DEFAULT_LIMIT: "1", MCP_SEARCH_MAX_LIMIT: "2" });
  const firstId = "rep:mock:EXAMPLE_CABINET:synthetic-1";
  const secondId = "rep:mock:EXAMPLE_CABINET:synthetic-2";
  const expectedApplied = {
    operator: "and",
    filters: { operator: "and", predicates: [{ name: "page_count", type: "integer", operator: "gte", value: 4 }] },
    text: { terms: ["annual", "report"], operator: "or", mode: "stemming" }
  };
  let searchCalls = 0;
  let searchRequest: any;
  rt.adapter.searchIds = async (request: any) => {
    searchCalls += 1;
    searchRequest = structuredClone(request);
    return [firstId, secondId];
  };
  rt.adapter.getMany = async (request: any) => ({
    objects: request.ids.map((id: string) => document(id, baseAttributes)),
    failures: []
  });

  try {
    const firstPage: any = (await rt.tools.call(profile(), "arcsuite_search_documents", {
      scope: "example_documents",
      query: "annual report",
      query_mode: "or",
      text_search_mode: "stemming",
      filters: { page_count: { operator: "gte", value: 4 } },
      limit: 1
    })).structuredContent;
    assert.deepEqual(firstPage.applied_query, expectedApplied);
    assert.deepEqual(searchRequest.text, { words: ["annual", "report"], operator: "OR" });
    assert.equal(searchRequest.mode, "AND");
    assert.equal(searchRequest.textSearchMode, "STEMMING");
    assert.deepEqual(searchRequest.attributeConditions[0].value, { type: "long", value: 4 });
    assert.equal(typeof firstPage.next_cursor, "string");

    const secondPage: any = (await rt.tools.call(profile(), "arcsuite_search_documents", {
      scope: "example_documents",
      cursor: firstPage.next_cursor
    })).structuredContent;
    assert.deepEqual(secondPage.applied_query, expectedApplied);
    assert.equal(secondPage.results[0].document_id, secondId);
    assert.equal(secondPage.next_cursor, null);
    assert.equal(searchCalls, 1);
  } finally {
    rt.stopValidationRetry();
  }
});

test("accepted ten-term and maximum-length queries are projected, while an eleventh term is rejected", async () => {
  const rt = await runtime();
  const searchRequests: any[] = [];
  rt.adapter.searchIds = async (request: any) => {
    searchRequests.push(structuredClone(request));
    return [];
  };
  const tenTerms = Array.from({ length: 10 }, (_, index) => `term${index}`).join(" ");
  const tenTermResult: any = (await rt.tools.call(profile(), "arcsuite_search_documents", {
    scope: "example_documents",
    query: tenTerms
  })).structuredContent;
  assert.deepEqual(tenTermResult.applied_query.text.terms, tenTerms.split(" "));
  assert.deepEqual(searchRequests[0].text, { words: tenTerms.split(" "), operator: "AND" });
  const maximumLengthQuery = "x".repeat(200);
  const maximumLengthResult: any = (await rt.tools.call(profile(), "arcsuite_search_documents", {
    scope: "example_documents",
    query: maximumLengthQuery
  })).structuredContent;
  assert.deepEqual(maximumLengthResult.applied_query.text.terms, [maximumLengthQuery]);
  assert.equal(maximumLengthResult.applied_query.text.mode, "none");
  assert.deepEqual(searchRequests[1].text, { words: [maximumLengthQuery], operator: "AND" });
  const maximumFilter = "f".repeat(255);
  const maximumFilterResult: any = (await rt.tools.call(profile(), "arcsuite_search_documents", {
    scope: "example_documents",
    filters: { name: maximumFilter }
  })).structuredContent;
  assert.equal(maximumFilterResult.applied_query.filters.predicates[0].value.length, 255);
  assert.deepEqual(searchRequests[2].attributeConditions[0].value, { type: "string", value: maximumFilter });
  const whitespaceQueryResult: any = (await rt.tools.call(profile(), "arcsuite_search_documents", {
    scope: "example_documents",
    query: " \t\n ",
    filters: { page_count: 10 }
  })).structuredContent;
  assert.equal(whitespaceQueryResult.applied_query.text, null);
  assert.equal(searchRequests[3].text, undefined);
  assert.equal(searchRequests[3].textSearchMode, "NONE");
  await assert.rejects(() => rt.tools.call(profile(), "arcsuite_search_documents", {
    scope: "example_documents",
    query: Array.from({ length: 11 }, (_, index) => `term${index}`).join(" ")
  }), (error: any) => error?.stableCode === "ARCSUITE_INVALID_ARGUMENT");
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
