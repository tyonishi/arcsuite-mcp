import test from "node:test";
import assert from "node:assert/strict";
import { toolInputSchemaForProfile, toolInputSchemas } from "../../src/mcp/sdkSchemas.ts";

test("P2 search-authority schemas accept only opaque refs and semantic target intent", () => {
  assert.equal(toolInputSchemas.arcsuite_continue_search.safeParse({ continuation_ref: "ref" }).success, true);
  for (const extra of ["scope", "cursor", "filters", "query", "limit", "response_contract"]) {
    assert.equal(toolInputSchemas.arcsuite_continue_search.safeParse({ continuation_ref: "ref", [extra]: "x" }).success, false);
  }
  assert.equal(toolInputSchemas.arcsuite_replay_search.safeParse({ search_ref: "ref", target_scope: "example_documents" }).success, true);
  assert.equal(toolInputSchemas.arcsuite_replay_search.safeParse({
    search_ref: "ref", target_scope: "example_documents", filters: { name: "x" }
  }).success, false);
});

test("P2 result schemas never accept document_id or caller-selected scope", () => {
  const valid: Record<string, Record<string, unknown>> = {
    arcsuite_get_document_by_ref: { result_ref: "ref" },
    arcsuite_get_documents_by_ref: { result_refs: ["ref"] },
    arcsuite_list_document_revisions_by_ref: { result_ref: "ref" },
    arcsuite_get_document_content_info_by_ref: { result_ref: "ref" },
    arcsuite_read_document_by_ref: { result_ref: "ref", max_chars: 1000 }
  };
  for (const [name, input] of Object.entries(valid)) {
    const schema = toolInputSchemas[name as keyof typeof toolInputSchemas];
    assert.equal(schema.safeParse(input).success, true, name);
    assert.equal(schema.safeParse({ ...input, document_id: "rep:synthetic" }).success, false, `${name}: document_id`);
    assert.equal(schema.safeParse({ ...input, scope: "example_documents" }).success, false, `${name}: scope`);
  }
});

test("P2 read-by-ref keeps bounded legacy content paging choices", () => {
  const schema = toolInputSchemas.arcsuite_read_document_by_ref;
  for (const input of [
    { result_ref: "ref" },
    { result_ref: "ref", max_chars: 1000 },
    { result_ref: "ref", start_page: 1 },
    { result_ref: "ref", start_page: 1, end_page: 2 },
    { result_ref: "ref", cursor: "cursor" }
  ]) {
    assert.equal(schema.safeParse(input).success, true, JSON.stringify(input));
  }
  assert.equal(schema.safeParse({ result_ref: "ref", start_page: 1, end_page: 2, max_chars: 1000 }).success, true);
  assert.equal(schema.safeParse({ result_ref: "ref", cursor: "cursor", max_chars: 1000 }).success, true);
  assert.equal(schema.safeParse({ result_ref: "ref", cursor: "cursor", start_page: 1 }).success, false);
  assert.equal(schema.safeParse({ result_ref: "ref", cursor: "cursor", end_page: 2 }).success, false);
  assert.equal(schema.safeParse({ result_ref: "ref", start_page: 5, end_page: 4 }).success, false);
  assert.equal(schema.safeParse({ result_ref: "ref", end_page: 2 }).success, false);
  assert.equal(schema.safeParse({ result_ref: "ref", unknown: true }).success, false);
  assert.equal(schema.safeParse({ result_ref: "x".repeat(1025) }).success, false);
  assert.equal(schema.safeParse({ result_ref: "ref", start_page: 1_000_001 }).success, false);
  assert.equal(schema.safeParse({ result_ref: "ref", cursor: "x".repeat(4097) }).success, false);
});

test("P2 read-by-ref preserves deployment-specific max_chars validation", () => {
  const schema = toolInputSchemaForProfile("arcsuite_read_document_by_ref", [], {
    searchMaxLimit: 5,
    batchMaxIds: 3,
    readMaxChars: 2000
  });
  assert.equal(schema.safeParse({ result_ref: "ref", max_chars: 2000 }).success, true);
  assert.equal(schema.safeParse({ result_ref: "ref", max_chars: 2001 }).success, false);
});
