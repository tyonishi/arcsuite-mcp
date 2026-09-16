import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { canonicalizeFilter, verifySemanticPredicate, SemanticVerificationError } from "../../src/semantic/attributeMapper.ts";
import { ScopeRegistry } from "../../src/semantic/scopeRegistry.ts";
import type { AttributeValue } from "../../src/arcsuite/types.ts";

const registry = ScopeRegistry.load(resolve("config/scopes.mock.yaml"));
const scope = registry.get("example_documents");
const schemas: Record<string, any> = {
  document_number: { ns: "rep", name: "user:example_document_number", dataType: "STRING_TYPE", searchable: true },
  name: { ns: "rep", name: "system:name", dataType: "STRING_TYPE", searchable: true },
  page_count: { ns: "rep", name: "user:page_count", dataType: "LONG_TYPE", searchable: true },
  approved: { ns: "rep", name: "user:approved", dataType: "BOOLEAN_TYPE", searchable: true },
  quality_score: { ns: "rep", name: "user:quality_score", dataType: "DOUBLE_TYPE", searchable: true },
  modified_after: { ns: "rep", name: "system:modifiedon", dataType: "DATE_TIME_TYPE", searchable: true },
  modified_before: { ns: "rep", name: "system:modifiedon", dataType: "DATE_TIME_TYPE", searchable: true },
  published_on: { ns: "rep", name: "user:published_on", dataType: "DATE_TYPE", searchable: true },
  lifecycle: { ns: "rep", name: "system:status", dataType: "I18N_STRING_TYPE", searchable: true, enumerated: true, enumLabels: [{ ns: "rep", name: "ACTIVE" }] }
};
const schema = (name: string) => schemas[name];

function attr(predicate: ReturnType<typeof canonicalizeFilter>, value: AttributeValue): Record<string, AttributeValue> {
  return { [`${predicate.condition.attrId.ns}:${predicate.condition.attrId.name}`]: value };
}

test("scalar and explicit equality inputs share one canonical condition", () => {
  const scalar = canonicalizeFilter(scope, "document_number", "DOC-000001", schema("document_number"));
  const explicit = canonicalizeFilter(scope, "document_number", { operator: "eq", value: "DOC-000001" }, schema("document_number"));
  assert.deepEqual(scalar, explicit);
  assert.equal(scalar.semanticValue, "DOC-000001");
  assert.equal(scalar.verification, "deterministic");
});

test("explicit disallowed operators remain rejected", () => {
  assert.throws(
    () => canonicalizeFilter(scope, "approved", { operator: "gte", value: true }, schema("approved")),
    /approved does not allow gte/
  );
});

test("string equality mismatch fails closed", () => {
  const predicate = canonicalizeFilter(scope, "document_number", "DOC-000001", schema("document_number"));
  assert.throws(
    () => verifySemanticPredicate(predicate, attr(predicate, { type: "string", value: "DOC-OTHER" })),
    (error) => error instanceof SemanticVerificationError && error.reason === "predicate_mismatch"
  );
});

test("numeric and boolean equality require the authoritative type and value", () => {
  const numeric = canonicalizeFilter(scope, "page_count", { operator: "eq", value: 10 }, schema("page_count"));
  assert.equal(numeric.semanticValue, 10);
  assert.throws(() => verifySemanticPredicate(numeric, attr(numeric, { type: "long", value: 11 })), SemanticVerificationError);
  assert.throws(() => verifySemanticPredicate(numeric, attr(numeric, { type: "string", value: "10" })), SemanticVerificationError);

  const approved = canonicalizeFilter(scope, "approved", true, schema("approved"));
  assert.equal(approved.semanticValue, true);
  assert.throws(() => verifySemanticPredicate(approved, attr(approved, { type: "boolean", value: false })), SemanticVerificationError);
  assert.throws(() => verifySemanticPredicate(approved, attr(approved, { type: "string", value: "true" })), SemanticVerificationError);
});

test("authoritative INT values must remain within the ArcSuite 32-bit range", () => {
  const predicate = canonicalizeFilter(scope, "page_count", { operator: "gte", value: 10 }, {
    ...schema("page_count"),
    dataType: "INT_TYPE"
  });
  assert.doesNotThrow(() => verifySemanticPredicate(predicate, attr(predicate, { type: "int", value: 2_147_483_647 })));
  for (const value of [-2_147_483_649, 2_147_483_648]) {
    assert.throws(
      () => verifySemanticPredicate(predicate, attr(predicate, { type: "int", value })),
      (error) => error instanceof SemanticVerificationError && error.reason === "malformed_attribute"
    );
  }
});

test("datetime and date comparisons include exact boundaries", () => {
  const after = canonicalizeFilter(scope, "modified_after", { operator: "gte", value: "2026-09-01T00:00:00.123Z" }, schema("modified_after"));
  assert.equal(after.semanticValue, "2026-09-01T00:00:00.123Z");
  assert.doesNotThrow(() => verifySemanticPredicate(after, attr(after, { type: "datetime", value: "2026-09-01T00:00:00.123Z" })));
  assert.throws(() => verifySemanticPredicate(after, attr(after, { type: "datetime", value: "2026-09-01T00:00:00.122Z" })), SemanticVerificationError);
  assert.throws(() => verifySemanticPredicate(after, attr(after, { type: "datetime", value: "not-a-date" })), SemanticVerificationError);

  const explicitOffset = canonicalizeFilter(scope, "modified_after", {
    operator: "gte",
    value: "2026-09-01T12:34:56.123456+09:00"
  }, schema("modified_after"));
  assert.equal(explicitOffset.semanticValue, "2026-09-01T12:34:56.123456+09:00");
  assert.equal((explicitOffset.condition.value as { type: "datetime"; value: string }).value, "2026-09-01T12:34:56.123456+09:00");

  const before = canonicalizeFilter(scope, "modified_before", { operator: "lte", value: "2026-09-01T00:00:00Z" }, schema("modified_before"));
  assert.doesNotThrow(() => verifySemanticPredicate(before, attr(before, { type: "datetime", value: "2026-08-31T23:59:59.999Z" })));
  assert.throws(() => verifySemanticPredicate(before, attr(before, { type: "datetime", value: "2026-09-01T00:00:00.001Z" })), SemanticVerificationError);

  const date = canonicalizeFilter(scope, "published_on", { operator: "lte", value: "2026-09-01" }, schema("published_on"));
  assert.equal(date.semanticValue, "2026-09-01");
  assert.doesNotThrow(() => verifySemanticPredicate(date, attr(date, { type: "date", value: "2026-09-01" })));
  assert.throws(() => verifySemanticPredicate(date, attr(date, { type: "date", value: "2026-09-02" })), SemanticVerificationError);
});

test("enum equality uses physical identity and LIKE remains provider authority", () => {
  const lifecycle = canonicalizeFilter(scope, "lifecycle", "active", schema("lifecycle"));
  assert.equal(lifecycle.semanticValue, "active");
  assert.doesNotThrow(() => verifySemanticPredicate(lifecycle, attr(lifecycle, { type: "i18n", ns: "rep", name: "ACTIVE" })));
  assert.throws(() => verifySemanticPredicate(lifecycle, attr(lifecycle, { type: "i18n", ns: "other", name: "ACTIVE" })), SemanticVerificationError);

  const like = canonicalizeFilter(scope, "name", "*.pdf", schema("name"));
  assert.equal(like.semanticValue, "*.pdf");
  assert.equal(like.verification, "provider");
  assert.doesNotThrow(() => verifySemanticPredicate(like, {}));
});

test("enum canonical values remain aliases for string-valued physical mappings", () => {
  const stringEnumScope = {
    ...scope,
    semantic_attributes: {
      ...scope.semantic_attributes,
      lifecycle_string: {
        attr_id: { ns: "rep", name: "user:lifecycle_string" },
        type: "enum",
        operators: ["eq"],
        values: { active: { value: "SYNTHETIC_STRING_ENUM_PHYSICAL_VALUE" } }
      }
    }
  } as any;
  const canonical = canonicalizeFilter(stringEnumScope, "lifecycle_string", "active", {
    ns: "rep",
    name: "user:lifecycle_string",
    dataType: "STRING_TYPE",
    searchable: true,
    enumerated: true
  });
  assert.equal(canonical.semanticValue, "active");
  assert.deepEqual(canonical.condition.value, { type: "string", value: "SYNTHETIC_STRING_ENUM_PHYSICAL_VALUE" });
  assert.equal(JSON.stringify(canonical).includes("SYNTHETIC_STRING_ENUM_PHYSICAL_VALUE"), true);
});

test("missing, malformed, and unknown values are not converted to zero results", () => {
  const predicate = canonicalizeFilter(scope, "page_count", { operator: "gte", value: 10 }, schema("page_count"));
  assert.throws(() => verifySemanticPredicate(predicate, {}), (error) => error instanceof SemanticVerificationError && error.reason === "attribute_missing");
  assert.throws(() => verifySemanticPredicate(predicate, attr(predicate, { type: "string", value: "10" })), (error) => error instanceof SemanticVerificationError && error.reason === "malformed_attribute");
  assert.throws(() => verifySemanticPredicate(predicate, attr(predicate, { type: "unknown", rawType: "synthetic" })), (error) => error instanceof SemanticVerificationError && error.reason === "malformed_attribute");
});
