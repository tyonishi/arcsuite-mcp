import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mapFilter } from "../../src/semantic/attributeMapper.ts";
import { normalizeDocument } from "../../src/semantic/responseNormalizer.ts";
import { ScopeRegistry } from "../../src/semantic/scopeRegistry.ts";

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
