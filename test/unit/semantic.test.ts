import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mapFilter } from "../../src/semantic/attributeMapper.ts";
import { normalizeDocument } from "../../src/semantic/responseNormalizer.ts";
import { ScopeRegistry } from "../../src/semantic/scopeRegistry.ts";
import { toolInputSchemas } from "../../src/mcp/sdkSchemas.ts";

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

test("scope registry rejects document ID placeholders in URL authorities", () => {
  const scope = {
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
  for (const template of ["https://{document_id}.example.invalid/open", "https://example.invalid:{document_id}/open"]) {
    assert.throws(() => new ScopeRegistry({ version: 1, scopes: { linked_scope: { ...scope, ui: { document_url_template: template } } } }), /document_url_template/);
  }
  const registry = new ScopeRegistry({ version: 1, scopes: { linked_scope: { ...scope, ui: { document_url_template: "https://example.invalid/open?id={document_id}" } } } });
  const invalidScope = { ...scope, ui: { document_url_template: "https://{document_id}.example.invalid/open" } };
  assert.equal(registry.documentUrl(invalidScope, "rep:mock:EXAMPLE_CABINET:1"), undefined);
});
