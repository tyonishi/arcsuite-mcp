import test from "node:test";
import assert from "node:assert/strict";
import { buildAppliedQuery } from "../../src/mcp/appliedQuery.ts";
import type { CanonicalSemanticPredicate } from "../../src/semantic/attributeMapper.ts";

function predicate(
  semanticName: string,
  semanticType: CanonicalSemanticPredicate["semanticType"],
  operator: CanonicalSemanticPredicate["operator"],
  semanticValue: string | number | boolean
): CanonicalSemanticPredicate {
  return {
    semanticName,
    semanticType,
    operator,
    semanticValue,
    verification: "deterministic",
    condition: {
      attrId: { ns: "rep", name: "user:SYNTHETIC_PHYSICAL_ATTRIBUTE" },
      operator: "EQUAL",
      value: { type: "string", value: "SYNTHETIC_PHYSICAL_VALUE" }
    }
  };
}

test("applied query projects only canonical semantic values", () => {
  const applied = buildAppliedQuery(
    [predicate("lifecycle", "enum", "eq", "active")],
    ["annual", "report"],
    "or",
    "stemming"
  );

  assert.deepEqual(applied, {
    operator: "and",
    filters: {
      operator: "and",
      predicates: [{ name: "lifecycle", type: "enum", operator: "eq", value: "active" }]
    },
    text: { terms: ["annual", "report"], operator: "or", mode: "stemming" }
  });
  assert.equal(JSON.stringify(applied).includes("SYNTHETIC_PHYSICAL_"), false);
});

test("applied query keeps the established group combination semantics", () => {
  const filter = predicate("page_count", "integer", "gte", 10);
  assert.deepEqual(buildAppliedQuery([filter], [], "or", "none"), {
    operator: "or",
    filters: {
      operator: "and",
      predicates: [{ name: "page_count", type: "integer", operator: "gte", value: 10 }]
    },
    text: null
  });
  assert.deepEqual(buildAppliedQuery([], ["annual"], "or", "none"), {
    operator: "or",
    filters: { operator: "and", predicates: [] },
    text: { terms: ["annual"], operator: "or", mode: "none" }
  });
  assert.equal(buildAppliedQuery([filter], ["annual"], "or", "none").operator, "and");
  assert.deepEqual(buildAppliedQuery([], [], "and", "none"), {
    operator: "and",
    filters: { operator: "and", predicates: [] },
    text: null
  });
});
