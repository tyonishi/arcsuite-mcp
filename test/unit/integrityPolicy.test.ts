import test from "node:test";
import assert from "node:assert/strict";
import { ScopeRegistry } from "../../src/semantic/scopeRegistry.ts";
import { toolInputSchemas } from "../../src/mcp/sdkSchemas.ts";

const baseScope = {
  description: "Synthetic integrity scope",
  enabled: true,
  arcsuite: {
    cabinet_alias: "INTEGRITY",
    cabinet_id: "rep:mock:INTEGRITY",
    root_object_id: null,
    resolve_references: true
  },
  allowed_object_types: ["document"],
  default_attr_ids: [{ ns: "rep", name: "system:name" }],
  semantic_attributes: {}
};

test("integrity scope defaults off and exposes only enabled semantic capabilities", () => {
  const omitted = new ScopeRegistry({ version: 1, scopes: { integrity: baseScope } });
  assert.equal(Object.hasOwn(omitted.describe(["integrity"])[0], "integrity"), false);

  const enabled = new ScopeRegistry({
    version: 1,
    scopes: {
      integrity: {
        ...baseScope,
        integrity: { enabled: true, allow_evidence: true }
      }
    }
  } as any);
  assert.deepEqual(enabled.describe(["integrity"])[0].integrity, { validation: true, evidence: true });

  const validationOnly = new ScopeRegistry({
    version: 1,
    scopes: {
      integrity: { ...baseScope, integrity: { enabled: true } }
    }
  } as any);
  assert.deepEqual(validationOnly.describe(["integrity"])[0].integrity, { validation: true, evidence: false });

  const disabled = new ScopeRegistry({
    version: 1,
    scopes: {
      integrity: { ...baseScope, integrity: { enabled: false, allow_evidence: false } }
    }
  } as any);
  assert.equal(Object.hasOwn(disabled.describe(["integrity"])[0], "integrity"), false);
});

test("integrity scope flags are strict and evidence cannot be enabled alone", () => {
  for (const integrity of [
    { enabled: "true" },
    { allow_evidence: 1 },
    { enabled: false, allow_evidence: true },
    { enabled: true, allow_evidence: false, arbitrary: true },
    []
  ]) {
    assert.throws(
      () => new ScopeRegistry({ version: 1, scopes: { integrity: { ...baseScope, integrity } } } as any),
      /integrity/i
    );
  }
});

test("integrity tool schema is single-document and rejects physical inputs", () => {
  const schema = toolInputSchemas.arcsuite_validate_document_integrity;
  assert.equal(schema.safeParse({ document_id: "rep:mock:INTEGRITY:1" }).success, true);
  assert.equal(schema.safeParse({ document_id: "rep:mock:INTEGRITY:1", include_evidence: true }).success, true);
  assert.equal(schema.safeParse({ include_evidence: false }).success, false);
  assert.equal(schema.safeParse({ document_id: "rep:mock:INTEGRITY:1", certificate_id: 1 }).success, false);
  assert.equal(schema.safeParse({ document_id: "rep:mock:INTEGRITY:1", cert_attribute: "x" }).success, false);
  assert.equal(schema.safeParse({ document_id: "rep:mock:INTEGRITY:1", options: ["unsafe"] }).success, false);
  assert.equal(schema.safeParse({ document_id: "rep:mock:INTEGRITY:1", document_ids: ["rep:mock:INTEGRITY:1"] }).success, false);
});
