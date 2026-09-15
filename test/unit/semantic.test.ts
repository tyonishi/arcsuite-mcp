import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mapFilter } from "../../src/semantic/attributeMapper.ts";
import { normalizeDocument } from "../../src/semantic/responseNormalizer.ts";
import { ScopeRegistry } from "../../src/semantic/scopeRegistry.ts";
import { toolInputSchemas } from "../../src/mcp/sdkSchemas.ts";

const DOCUMENT_NATIVE_CLASS = { ns: "rep", name: "system:document" };

test("scope YAML and semantic filters map without exposing physical fields", () => {
  const registry = ScopeRegistry.load(resolve("config/scopes.mock.yaml"));
  const scope = registry.get("example_documents");
  const exact = mapFilter(scope, "document_number", "DOC-000001");
  assert.equal(exact.operator, "EQUAL");
  assert.deepEqual(exact.attrId, { ns: "rep", name: "user:example_document_number" });
  const wildcard = mapFilter(scope, "name", "*.pdf");
  assert.equal(wildcard.operator, "LIKE");
  const after = mapFilter(scope, "modified_after", "2026-09-01T00:00:00Z");
  assert.equal(after.operator, "GREATER_EQUAL");
  assert.throws(() => mapFilter(scope, "not_configured", "value"), /Unsupported semantic filter/);

  const normalized = normalizeDocument({
    id: "rep:mock:EXAMPLE_CABINET:1001",
    objectClass: "document",
    nativeObjectClass: DOCUMENT_NATIVE_CLASS,
    attributes: {
      "rep:system:name": { type: "string", value: "DOC-000001_example.txt" },
      "rep:user:example_document_number": { type: "string", value: "DOC-000001" },
      "rep:system:contentlabellist": { type: "i18n[]", values: [{ ns: "rep", name: "system:primary" }] }
    }
  }, scope.semantic_attributes);
  assert.equal(normalized.semantic_attributes?.document_number, "DOC-000001");
  assert.equal("attributes" in normalized, false);
  assert.equal(["drawing", "number"].join("_") in normalized, false);

  const withConfiguredAliases = normalizeDocument({
    id: "rep:mock:EXAMPLE_CABINET:1001",
    objectClass: "document",
    nativeObjectClass: DOCUMENT_NATIVE_CLASS,
    attributes: {
      "rep:system:contentlabellist": {
        type: "i18n[]",
        values: [
          { ns: "rep", name: "system:primary" },
          { ns: "rep", name: "user:EXAMPLE_PREVIEW" },
          { ns: "other", name: "user:EXAMPLE_PREVIEW" }
        ]
      }
    }
  }, {}, registry.contentLabelAliases(scope));
  assert.deepEqual(withConfiguredAliases.content_labels, ["system:primary", "preview"]);
  assert.equal(JSON.stringify(withConfiguredAliases).includes("EXAMPLE_PREVIEW"), false);
});

test("enum normalization returns configured aliases and rejects unknown physical values", () => {
  const enumAttributes = {
    lifecycle: {
      attr_id: { ns: "rep", name: "user:lifecycle" },
      type: "enum",
      operators: ["eq"],
      values: { active: { ns: "rep", name: "ACTIVE" } }
    }
  } as any;
  const base = {
    id: "rep:mock:EXAMPLE_CABINET:1001",
    objectClass: "document",
    nativeObjectClass: DOCUMENT_NATIVE_CLASS,
    attributes: {
      "rep:user:lifecycle": { type: "i18n", ns: "rep", name: "ACTIVE", label: "有効" } as const
    }
  };

  const normalized = normalizeDocument(base, enumAttributes);
  assert.equal(normalized.semantic_attributes?.lifecycle, "active");
  assert.equal(JSON.stringify(normalized).includes("EXAMPLE_PRIVATE_LITERAL"), false);
  assert.equal(JSON.stringify(normalized).includes("有効"), false);

  const statusNormalized = normalizeDocument({
    ...base,
    attributes: {
      ...base.attributes,
      "rep:system:status": { type: "i18n", ns: "rep", name: "ACTIVE", label: "有効" }
    }
  }, { lifecycle: { ...enumAttributes.lifecycle, attr_id: { ns: "rep", name: "system:status" } } });
  assert.equal(statusNormalized.status, "active");
  assert.equal(JSON.stringify(statusNormalized).includes("ACTIVE"), false);
  assert.equal(JSON.stringify(statusNormalized).includes("有効"), false);

  const stringEnumAttributes = {
    lifecycle: {
      attr_id: { ns: "rep", name: "user:lifecycle" },
      type: "enum",
      operators: ["eq"],
      values: { published: { value: "EXAMPLE_PRIVATE_LITERAL" } }
    }
  } as any;
  const stringNormalized = normalizeDocument({
    ...base,
    attributes: { "rep:user:lifecycle": { type: "string", value: "EXAMPLE_PRIVATE_LITERAL" } }
  }, stringEnumAttributes);
  assert.equal(stringNormalized.semantic_attributes?.lifecycle, "published");
  assert.equal(JSON.stringify(stringNormalized).includes("EXAMPLE_PRIVATE_LITERAL"), false);

  for (const value of [
    { type: "i18n", ns: "other", name: "ACTIVE", label: "active" },
    { type: "i18n", ns: "rep", name: "UNKNOWN", label: "有効" }
  ] as any[]) {
    assert.throws(() => normalizeDocument({ ...base, attributes: { "rep:user:lifecycle": value } }, enumAttributes),
      (error: any) => error?.stableCode === "ARCSUITE_UPSTREAM_ERROR" && error?.category === "semantic_enum_value_unmapped");
  }
  assert.throws(() => normalizeDocument({
    ...base,
    attributes: { "rep:user:lifecycle": { type: "string", value: "UNKNOWN_PRIVATE_LITERAL" } }
  }, stringEnumAttributes),
  (error: any) => error?.stableCode === "ARCSUITE_UPSTREAM_ERROR" && error?.category === "semantic_enum_value_unmapped");

  const wrongNamespaceStatus = normalizeDocument({
    ...base,
    attributes: { "rep:system:status": { type: "i18n", ns: "other", name: "ACTIVE", label: "有効" } as any }
  }, {});
  assert.equal(wrongNamespaceStatus.status, undefined);
});

test("configured semantic AttributeIds use exact namespace without name fallback", () => {
  const config = {
    state: { attr_id: { ns: "user", name: "state" }, type: "string", operators: ["eq"] }
  } as any;
  const wrongNamespace = normalizeDocument({
    id: "rep:mock:EXAMPLE_CABINET:1001",
    objectClass: "document",
    nativeObjectClass: DOCUMENT_NATIVE_CLASS,
    attributes: { "rep:state": { type: "string", value: "WRONG_NAMESPACE" } }
  }, config);
  assert.equal(wrongNamespace.semantic_attributes?.state, null);
  const exact = normalizeDocument({
    id: "rep:mock:EXAMPLE_CABINET:1001",
    objectClass: "document",
    nativeObjectClass: DOCUMENT_NATIVE_CLASS,
    attributes: {
      "rep:state": { type: "string", value: "WRONG_NAMESPACE" },
      "user:state": { type: "string", value: "EXACT_NAMESPACE" }
    }
  }, config);
  assert.equal(exact.semantic_attributes?.state, "EXACT_NAMESPACE");
});

test("typed predicates use the verified schema value representation", () => {
  const registry = ScopeRegistry.load(resolve("config/scopes.mock.yaml"));
  const scope = registry.get("example_documents");
  const longSchema = { ns: "rep", name: "user:page_count", dataType: "LONG_TYPE", searchable: true, enumerated: false };
  const integer = mapFilter(scope, "page_count", { operator: "gte", value: 10 }, longSchema);
  assert.deepEqual(integer, {
    attrId: { ns: "rep", name: "user:page_count" },
    operator: "GREATER_EQUAL",
    value: { type: "long", value: 10 }
  });
  const intValue = mapFilter(scope, "page_count", { operator: "eq", value: 10 }, { ...longSchema, dataType: "INT_TYPE" });
  assert.deepEqual(intValue.value, { type: "int", value: 10 });
  assert.throws(() => mapFilter(scope, "page_count", 10), /validated schema metadata/);
  assert.throws(() => mapFilter(scope, "page_count", 10, { ...longSchema, dataType: "STRING_TYPE" }), /schema type/);
  assert.throws(() => mapFilter(scope, "page_count", Number.MIN_SAFE_INTEGER, { ...longSchema, maxIntegralValue: "-9007199254740992" }), /above the schema maximum/);
  assert.throws(() => mapFilter(scope, "page_count", 0, { ...longSchema, minIntegralValue: "0", minInclusive: false }), /below the schema minimum/);
  assert.throws(() => mapFilter(scope, "page_count", 0, { ...longSchema, maxIntegralValue: "0", maxInclusive: false }), /above the schema maximum/);
  const boolean = mapFilter(scope, "approved", true, { ns: "rep", name: "user:approved", dataType: "BOOLEAN_TYPE", searchable: true });
  assert.deepEqual(boolean.value, { type: "boolean", value: true });
  const date = mapFilter(scope, "published_on", { operator: "lte", value: "2026-09-01" }, { ns: "rep", name: "user:published_on", dataType: "DATE_TYPE", searchable: true });
  assert.deepEqual(date.value, { type: "date", value: "2026-09-01" });
  const dateTime = mapFilter(scope, "modified_after", { operator: "gte", value: "2026-09-01T00:00:00+09:00" }, { ns: "rep", name: "system:modifiedon", dataType: "DATE_TIME_TYPE", searchable: true });
  assert.deepEqual(dateTime.value, { type: "datetime", value: "2026-09-01T00:00:00+09:00" });
  const number = mapFilter({ ...scope, semantic_attributes: { ...scope.semantic_attributes, score: { attr_id: { ns: "rep", name: "user:score" }, type: "number", operators: ["gte"] } } }, "score", { operator: "gte", value: 0.5 }, { ns: "rep", name: "user:score", dataType: "DOUBLE_TYPE", searchable: true });
  assert.deepEqual(number.value, { type: "double", value: 0.5 });
  const enumValue = mapFilter(scope, "lifecycle", { operator: "eq", value: "active" }, {
    ns: "rep",
    name: "system:status",
    dataType: "I18N_STRING_TYPE",
    enumerated: true,
    searchable: true,
    enumLabels: [{ ns: "rep", name: "ACTIVE" }]
  });
  assert.deepEqual(enumValue.value, { type: "i18n", ns: "rep", name: "ACTIVE" });

  const stringEnumRegistry = new ScopeRegistry({
    version: 1,
    scopes: {
      string_enum: {
        description: "Synthetic string enum scope",
        enabled: true,
        arcsuite: { cabinet_alias: "STRING_ENUM", cabinet_id: "rep:mock:STRING_ENUM", root_object_id: null, resolve_references: true },
        allowed_object_types: ["document"],
        default_attr_ids: [{ ns: "rep", name: "system:name" }],
        semantic_attributes: {
          lifecycle: {
            attr_id: { ns: "rep", name: "user:lifecycle" },
            type: "enum",
            operators: ["eq"],
            values: { active: { value: "ACTIVE" }, retired: { value: "RETIRED" } }
          }
        }
      }
    }
  });
  const stringEnum = mapFilter(stringEnumRegistry.get("string_enum"), "lifecycle", "active", {
    ns: "rep",
    name: "user:lifecycle",
    dataType: "STRING_TYPE",
    enumerated: true,
    searchable: true
  });
  assert.deepEqual(stringEnum.value, { type: "string", value: "ACTIVE" });
  assert.throws(() => mapFilter(stringEnumRegistry.get("string_enum"), "lifecycle", "active", {
    ns: "rep",
    name: "user:lifecycle",
    dataType: "STRING_TYPE",
    enumerated: false,
    searchable: true
  }), /requires validated enum schema/);
  assert.deepEqual(stringEnumRegistry.describe(["string_enum"])[0].full_text_modes, ["none"]);
  assert.throws(() => mapFilter(stringEnumRegistry.get("string_enum"), "lifecycle", "active", {
    ns: "rep",
    name: "user:lifecycle",
    dataType: "I18N_STRING_TYPE",
    enumerated: true,
    searchable: true,
    enumLabels: [{ ns: "rep", name: "ACTIVE" }]
  }), /does not match/);
  assert.throws(() => mapFilter(scope, "page_count", { operator: "eq", value: Number.MAX_SAFE_INTEGER + 1 }, longSchema), /safe integer/);
  assert.throws(() => mapFilter(scope, "published_on", { operator: "gte", value: "2026-02-30" }, { ns: "rep", name: "user:published_on", dataType: "DATE_TYPE", searchable: true }), /calendar date/);
  assert.throws(() => mapFilter(scope, "modified_after", { operator: "gte", value: "2026-09-01T00:00:00" }, { ns: "rep", name: "system:modifiedon", dataType: "DATE_TIME_TYPE", searchable: true }), /RFC3339/);
  assert.throws(() => mapFilter(scope, "modified_after", { operator: "gte", value: "2026-09-01T00:00:00-00:00" }, { ns: "rep", name: "system:modifiedon", dataType: "DATE_TIME_TYPE", searchable: true }), /RFC3339/);
});

test("scope registry validates typed operator and enum configuration", () => {
  const base = {
    description: "Synthetic typed scope",
    enabled: true,
    arcsuite: { cabinet_alias: "TYPED", cabinet_id: "rep:mock:TYPED", root_object_id: null, resolve_references: true },
    allowed_object_types: ["document"],
    default_attr_ids: [{ ns: "rep", name: "system:name" }]
  };
  assert.throws(() => new ScopeRegistry({ version: 1, scopes: { typed: { ...base, semantic_attributes: { flag: { attr_id: { ns: "rep", name: "flag" }, type: "boolean", operators: ["like"] } } } } as any }), /Unsupported operator/);
  assert.throws(() => new ScopeRegistry({ version: 1, scopes: { typed: { ...base, semantic_attributes: { state: { attr_id: { ns: "rep", name: "state" }, type: "enum", operators: ["eq"], values: { active: { ns: "rep" } } } } } } as any }), /Enum mapping/);
  assert.throws(() => new ScopeRegistry({ version: 1, scopes: { typed: { ...base, semantic_attributes: { state: { attr_id: { ns: "rep", name: "state" }, type: "enum", operators: ["eq"], values: { active: { ns: "rep", name: "ACTIVE" }, current: { ns: "rep", name: "ACTIVE" } } } } } } as any }), /unique physical enum/i);
  assert.throws(() => new ScopeRegistry({ version: 1, scopes: { typed: { ...base, semantic_attributes: { state: { attr_id: { ns: "rep", name: "state" }, type: "enum", operators: ["eq"], values: { active: { value: "ACTIVE" }, current: { value: "ACTIVE" } } } } } } as any }), /unique physical enum/i);
  assert.doesNotThrow(() => new ScopeRegistry({ version: 1, scopes: { typed: { ...base, semantic_attributes: { state: { attr_id: { ns: "rep", name: "state" }, type: "enum", operators: ["eq"], values: { rep_active: { ns: "rep", name: "ACTIVE" }, user_active: { ns: "user", name: "ACTIVE" } } } } } } as any }));
  const registry = new ScopeRegistry({ version: 1, scopes: { typed: { ...base, search: { full_text_modes: ["none", "thesaurus"] }, semantic_attributes: { state: { attr_id: { ns: "rep", name: "state" }, type: "enum", operators: ["eq"], values: { active: { ns: "rep", name: "ACTIVE" } } } } } } as any });
  assert.deepEqual(registry.describe(["typed"])[0].full_text_modes, ["none", "thesaurus"]);
  assert.deepEqual(registry.describe(["typed"])[0].filters[0].values, ["active"]);
});

test("scope registry validates additive content-label configuration and preserves primary", () => {
  const base = {
    description: "Synthetic content-label scope",
    enabled: true,
    arcsuite: { cabinet_alias: "LABELS", cabinet_id: "rep:mock:LABELS", root_object_id: null, resolve_references: true },
    allowed_object_types: ["document"],
    default_attr_ids: [{ ns: "rep", name: "system:name" }],
    semantic_attributes: {}
  };
  const registry = new ScopeRegistry({
    version: 1,
    scopes: {
      labels: {
        ...base,
        content_labels: { preview: { ns: "rep", name: "user:PREVIEW" } }
      }
    }
  });
  const scope = registry.get("labels");
  assert.deepEqual(registry.describe(["labels"])[0].content_labels, ["system:primary", "preview"]);
  assert.deepEqual(registry.resolveContentLabel(scope, "system:primary"), { ns: "rep", name: "system:primary" });
  assert.deepEqual(registry.resolveContentLabel(scope, "preview"), { ns: "rep", name: "user:PREVIEW" });
  assert.equal(registry.resolveContentLabel(scope, "unknown"), undefined);

  for (const contentLabels of [
    { "system:primary": { ns: "rep", name: "system:other" } },
    { preview: { ns: "rep", name: "system:primary" } },
    { preview: { ns: "rep", name: "user:SAME" }, other: { ns: "rep", name: "user:SAME" } },
    { "Bad-Alias": { ns: "rep", name: "user:PREVIEW" } },
    { preview: { ns: "rep other", name: "user:PREVIEW" } },
    { preview: { ns: "rep", name: "user:PREVIEW", extra: "nope" } }
  ]) {
    assert.throws(() => new ScopeRegistry({ version: 1, scopes: { labels: { ...base, content_labels: contentLabels } } } as any), /content label|content_labels|physical/i);
  }

  const noBlock = new ScopeRegistry({ version: 1, scopes: { labels: base } });
  assert.deepEqual(noBlock.describe(["labels"])[0].content_labels, ["system:primary"]);

  const readSchema = toolInputSchemas.arcsuite_read_document;
  assert.equal(readSchema.safeParse({ document_id: "rep:mock:LABELS:1", content_label: "not_configured" }).success, true);
  assert.equal(readSchema.safeParse({ document_id: "rep:mock:LABELS:1", content_label: { ns: "rep", name: "user:PREVIEW" } }).success, false);
});

test("scope registry defaults incoming hard-reference capability off and validates its strict flag", () => {
  const base = {
    description: "Synthetic relationship scope",
    enabled: true,
    arcsuite: { cabinet_alias: "RELATIONSHIPS", cabinet_id: "rep:mock:RELATIONSHIPS", root_object_id: null, resolve_references: true },
    allowed_object_types: ["document", "reference"],
    default_attr_ids: [{ ns: "rep", name: "system:name" }],
    semantic_attributes: {}
  };

  const disabled = new ScopeRegistry({ version: 1, scopes: { relationships: base } });
  assert.deepEqual(disabled.describe(["relationships"])[0].relationships, []);

  const enabled = new ScopeRegistry({
    version: 1,
    scopes: { relationships: { ...base, relationships: { hard_references: true } } }
  });
  assert.deepEqual(enabled.describe(["relationships"])[0].relationships, ["hard_reference_incoming"]);

  assert.throws(() => new ScopeRegistry({
    version: 1,
    scopes: { relationships: { ...base, relationships: { hard_references: "true" } } }
  } as any), /hard_references.*boolean/i);
  assert.throws(() => new ScopeRegistry({
    version: 1,
    scopes: { relationships: { ...base, relationships: { hard_references: true, arbitrary: true } } }
  } as any), /unknown.*relationship|relationship.*key/i);
});

test("hard-reference tool schema requires a target and rejects caller-controlled relationship parameters", () => {
  const schema = toolInputSchemas.arcsuite_list_hard_references;
  assert.equal(schema.safeParse({ document_id: "rep:mock:RELATIONSHIPS:1" }).success, true);
  assert.equal(schema.safeParse({ document_id: "rep:mock:RELATIONSHIPS:1", cursor: "opaque" }).success, true);
  assert.equal(schema.safeParse({ cursor: "opaque" }).success, false);
  assert.equal(schema.safeParse({ document_id: "rep:mock:RELATIONSHIPS:1", depth: 2 }).success, false);
  assert.equal(schema.safeParse({ document_id: "rep:mock:RELATIONSHIPS:1", relationship_type: "anything" }).success, false);
  assert.equal(schema.safeParse({ document_id: "rep:mock:RELATIONSHIPS:1", limit: 1, cursor: "opaque" }).success, false);
});

test("scope registry rejects string enum literals outside adapter constraints", async () => {
  const base = {
    description: "Synthetic string enum scope",
    enabled: true,
    arcsuite: { cabinet_alias: "STRING_ENUM", cabinet_id: "rep:mock:STRING_ENUM", root_object_id: null, resolve_references: true },
    allowed_object_types: ["document"],
    default_attr_ids: [{ ns: "rep", name: "system:name" }]
  };
  const cases = [
    { values: { active: { value: "A" } }, schema: { minLength: 2 }, error: "enum_value_shorter_than_schema_minimum" },
    { values: { active: { value: "ACTIVE" } }, schema: { maxLength: 5 }, error: "enum_value_exceeds_schema_maximum" },
    { values: { active: { value: "ACTIVE" } }, schema: { pattern: "^Z$" }, error: "enum_value_does_not_match_schema_pattern" }
  ] as const;
  for (const item of cases) {
    const registry = new ScopeRegistry({
      version: 1,
      scopes: {
        string_enum: {
          ...base,
          semantic_attributes: {
            lifecycle: { attr_id: { ns: "rep", name: "user:lifecycle" }, type: "enum", operators: ["eq"], values: item.values }
          }
        }
      }
    });
    const adapter = {
      validateSchema: async (request: { attributes: Array<{ attrId: { ns: string; name: string } }> }) => ({
        ok: true,
        version: {},
        cabinet: {},
        errors: [],
        attributes: request.attributes.map(({ attrId }) => ({
          ...attrId,
          dataType: "STRING_TYPE",
          searchable: true,
          enumerated: attrId.name === "user:lifecycle",
          ...(attrId.name === "user:lifecycle" ? item.schema : {})
        }))
      })
    };
    await assert.rejects(() => registry.validateAgainstAdapter(adapter as any, "profile"), new RegExp(`lifecycle:${item.error}`));
  }
});

test("scope object-type allowlist rejects unexpected adapter classes", () => {
  const registry = ScopeRegistry.load(resolve("config/scopes.mock.yaml"));
  const scope = registry.get("example_documents");
  assert.equal(registry.isAllowedObjectType(scope, "document"), true);
  assert.equal(registry.isAllowedObjectType(scope, "folder"), true);
  assert.equal(registry.isAllowedObjectType(scope, "cabinet"), false);
  assert.equal(registry.isAllowedObjectType(scope, "unknown"), false);
  assert.equal(registry.isAllowedObjectType(scope, undefined), false);
});

test("scope registry rejects overlapping enabled cabinet mappings", () => {
  const scope = {
    description: "Synthetic scope",
    enabled: true,
    arcsuite: {
      cabinet_alias: "EXAMPLE_CABINET",
      cabinet_id: "rep:mock:EXAMPLE_CABINET",
      root_object_id: null,
      resolve_references: true
    },
    allowed_object_types: ["document"],
    default_attr_ids: [{ ns: "rep", name: "system:name" }],
    semantic_attributes: {}
  };
  assert.throws(() => new ScopeRegistry({
    version: 1,
    scopes: {
      first_scope: scope,
      second_scope: { ...scope, arcsuite: { ...scope.arcsuite, cabinet_alias: "EXAMPLE_CHILD", cabinet_id: "rep:mock:EXAMPLE_CABINET:child" } }
    }
  }), /overlapping cabinet mappings/);
});

test("scope registry validates safe UI deep-link templates and placeholder semantics", () => {
  const baseScope = {
    description: "Synthetic linked scope",
    enabled: true,
    arcsuite: {
      cabinet_alias: "EXAMPLE_CABINET",
      cabinet_id: "rep:mock:EXAMPLE_CABINET",
      root_object_id: null,
      resolve_references: true
    },
    allowed_object_types: ["document"],
    default_attr_ids: [{ ns: "rep", name: "system:name" }],
    semantic_attributes: {}
  };

  const registryFor = (ui: unknown) => new ScopeRegistry({
    version: 1,
    scopes: { linked_scope: { ...baseScope, ...(ui === undefined ? {} : { ui }) } }
  } as any);
  const documentId = "rep:ExampleRepo:EXAMPLE_CABINET:12345";

  const legacyRegistry = registryFor({ document_url_template: "https://arcsuite.example.invalid/open?id={document_id}" });
  const legacyScope = legacyRegistry.get("linked_scope");
  assert.equal(
    legacyRegistry.documentUrl(legacyScope, documentId),
    "https://arcsuite.example.invalid/open?id=rep%3AExampleRepo%3AEXAMPLE_CABINET%3A12345"
  );

  const nativeRegistry = registryFor({ document_url_template: "https://arcsuite.example.invalid/open?id={arcsuite_object_id}" });
  const nativeScope = nativeRegistry.get("linked_scope");
  const nativeUrl = nativeRegistry.documentUrl(nativeScope, documentId);
  assert.equal(nativeUrl, "https://arcsuite.example.invalid/open?id=ExampleRepo%3AEXAMPLE_CABINET%3A12345");
  assert.equal(nativeUrl?.includes("rep%3A"), false);
  assert.equal(nativeRegistry.documentUrl(nativeScope, "ExampleRepo:EXAMPLE_CABINET:12345"), undefined);
  assert.equal(nativeRegistry.documentUrl(nativeScope, "rep:"), undefined);
  assert.equal(nativeRegistry.describe(["linked_scope"])[0].ui_deep_link, true);
  assert.equal(JSON.stringify(nativeRegistry.describe(["linked_scope"])).includes("document_url_template"), false);
  assert.equal(JSON.stringify(nativeRegistry.describe(["linked_scope"])).includes("arcsuite.example.invalid"), false);

  const httpNativeRegistry = registryFor({
    allow_http: true,
    document_url_template: "http://arcsuite-internal.example.invalid/ArcSuite/docspace/sdk/open.do?id={arcsuite_object_id}&enc=UTF-8"
  });
  const httpNativeUrl = httpNativeRegistry.documentUrl(httpNativeRegistry.get("linked_scope"), documentId);
  assert.equal(httpNativeUrl, "http://arcsuite-internal.example.invalid/ArcSuite/docspace/sdk/open.do?id=ExampleRepo%3AEXAMPLE_CABINET%3A12345&enc=UTF-8");

  const httpLegacyRegistry = registryFor({ allow_http: true, document_url_template: "http://arcsuite-internal.example.invalid/open?id={document_id}" });
  assert.equal(
    httpLegacyRegistry.documentUrl(httpLegacyRegistry.get("linked_scope"), documentId),
    "http://arcsuite-internal.example.invalid/open?id=rep%3AExampleRepo%3AEXAMPLE_CABINET%3A12345"
  );

  for (const allowHttp of [undefined, false]) {
    assert.throws(() => registryFor({ allow_http: allowHttp, document_url_template: "http://arcsuite.example.invalid/open?id={document_id}" }), /must use https/i);
  }
  assert.doesNotThrow(() => registryFor({ allow_http: false, document_url_template: "https://arcsuite.example.invalid/open?id={document_id}" }));
  assert.throws(() => registryFor({ allow_http: "true", document_url_template: "https://arcsuite.example.invalid/open?id={document_id}" }), /allow_http.*boolean/i);
  assert.throws(() => registryFor({ allow_http: true, document_url_template: "ftp://arcsuite.example.invalid/open?id={document_id}" }), /http or https/i);

  for (const template of [
    "https://arcsuite.example.invalid/open",
    "https://arcsuite.example.invalid/open?id={document_id}{document_id}",
    "https://arcsuite.example.invalid/open?id={arcsuite_object_id}{arcsuite_object_id}",
    "https://arcsuite.example.invalid/open?id={document_id}&native={arcsuite_object_id}",
    "https://arcsuite.example.invalid/open?id={unknown_placeholder}"
  ]) {
    assert.throws(() => registryFor({ document_url_template: template }), /document_url_template/);
  }

  for (const placeholder of ["document_id", "arcsuite_object_id"]) {
    for (const template of [
      `https://{${placeholder}}.example.invalid/open`,
      `https://arcsuite.example.invalid:{${placeholder}}/open`
    ]) {
      assert.throws(() => registryFor({ document_url_template: template }), /document_url_template/);
    }
  }

  for (const template of [
    "https://user:password@arcsuite.example.invalid/open?id={document_id}",
    "https://arcsuite.example.invalid/open?id={document_id}#fragment",
    "/open?id={document_id}",
    "not-a-url?id={document_id}"
  ]) {
    assert.throws(() => registryFor({ document_url_template: template }), /document_url_template/);
  }

  const pathRegistry = registryFor({ document_url_template: "https://arcsuite.example.invalid/ArcSuite/open/{document_id}?fixed=1" });
  const pathUrl = pathRegistry.documentUrl(pathRegistry.get("linked_scope"), "rep:ExampleRepo:EXAMPLE_CABINET:/?");
  assert.equal(new URL(pathUrl as string).origin, "https://arcsuite.example.invalid");
  assert.equal(pathUrl?.includes("rep%3AExampleRepo%3AEXAMPLE_CABINET%3A%2F%3F"), true);

  const invalidScope = { ...baseScope, ui: { document_url_template: "https://{document_id}.example.invalid/open" } } as any;
  assert.equal(legacyRegistry.documentUrl(invalidScope, documentId), undefined);
});
