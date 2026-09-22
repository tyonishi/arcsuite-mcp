import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDocument } from "../../src/semantic/responseNormalizer.ts";
import { McpToolError } from "../../src/mcp/errors.ts";
import type { AdapterRepositoryObject } from "../../src/arcsuite/types.ts";

const config = {
  part_number: {
    attr_id: { ns: "rep", name: "user:example_multi_part_number" },
    type: "string",
    multi_valued: true,
    operators: ["eq", "like"],
    allow_wildcards: true,
    max_length: 30
  }
} as any;

function document(value: any): AdapterRepositoryObject {
  return {
    id: "rep:mock:MULTI_VALUE:document-001",
    objectClass: "document",
    nativeObjectClass: { ns: "rep", name: "system:document" },
    attributes: { "rep:user:example_multi_part_number": value }
  };
}

test("multi-valued semantic normalization preserves order and returns a defensive array", () => {
  const physical = { type: "string[]", values: ["A", "B"] } as const;
  const normalized = normalizeDocument(document(physical), config);
  const publicValue = normalized.semantic_attributes?.part_number;
  assert.deepEqual(publicValue, ["A", "B"]);
  assert.notStrictEqual(publicValue, physical.values);
  (publicValue as string[]).reverse();
  assert.deepEqual(physical.values, ["A", "B"]);
});

test("multi-valued normalization fails closed for scalar and malformed physical shapes", () => {
  for (const value of [
    { type: "string", value: "A" },
    { type: "string[]", values: ["A", 2] },
    (() => {
      const sparse: string[] = [];
      sparse[1] = "B";
      return { type: "string[]", values: sparse };
    })()
  ]) {
    assert.throws(
      () => normalizeDocument(document(value), config),
      (error) => error instanceof McpToolError
        && error.stableCode === "ARCSUITE_UPSTREAM_ERROR"
        && error.category === "semantic_attribute_shape"
    );
  }
});

test("scalar normalization remains scalar", () => {
  const normalized = normalizeDocument(document({ type: "string", value: "A" }), {
    part_number: { attr_id: { ns: "rep", name: "user:example_multi_part_number" }, type: "string", operators: ["eq", "like"] }
  } as any);
  assert.equal(normalized.semantic_attributes?.part_number, "A");
});
