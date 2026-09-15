import test from "node:test";
import assert from "node:assert/strict";
import { V1_SOAP_OPERATION_ALLOWLIST, FORBIDDEN_SOAP_OPERATIONS, assertOperationAllowlistSafe } from "../../src/arcsuite/operationAllowlist.ts";
import { CursorManager } from "../../src/content/cursor.ts";
import { normalizeExtractedText } from "../../src/content/contentBridge.ts";

const forbidden = new Set(FORBIDDEN_SOAP_OPERATIONS);

test("v1 SOAP allowlist contains no forbidden operation", () => {
  assert.doesNotThrow(() => assertOperationAllowlistSafe());
  for (const op of V1_SOAP_OPERATION_ALLOWLIST) assert.equal(forbidden.has(op), false, op);
  assert.equal(V1_SOAP_OPERATION_ALLOWLIST.has("enableAdministratorMode"), false);
  assert.equal(V1_SOAP_OPERATION_ALLOWLIST.has("assertPrivilege"), false);
  assert.equal(V1_SOAP_OPERATION_ALLOWLIST.has("getRepositoryObjectContentForPrint"), false);
  assert.equal(V1_SOAP_OPERATION_ALLOWLIST.has("deleteRepositoryObject"), false);
  assert.equal(V1_SOAP_OPERATION_ALLOWLIST.has("changeRepositoryObjectAcl"), false);
  assert.equal(V1_SOAP_OPERATION_ALLOWLIST.has("listRepositoryObjectHardReferences"), true);
  assert.equal(V1_SOAP_OPERATION_ALLOWLIST.has("validateCertificate"), true);
  assert.equal(V1_SOAP_OPERATION_ALLOWLIST.has("getCertificateEvidence"), true);
  for (const operation of [
    "putHardReference", "putHardReferenceWithClass", "putReference", "putReferenceWithClass",
    "attachTimestamp", "attachTimestampWithOptions", "calculateCertificateEvidence"
  ]) {
    assert.equal(V1_SOAP_OPERATION_ALLOWLIST.has(operation), false, operation);
  }
  assert.equal(V1_SOAP_OPERATION_ALLOWLIST.size, 26);
});

test("signed cursor detects tampering", () => {
  const c = new CursorManager(Buffer.from("0123456789abcdef0123456789abcdef"), 600);
  const token = c.create({
    version: 2,
    trace_id: "t",
    document_id: "rep:x:y:1",
    content_hash: "sha256:x",
    offset: 10,
    extractor: "text",
    effective_identity_binding: "opaque-binding"
  });
  const parsed = c.parse(token);
  assert.equal(parsed.offset, 10);
  assert.throws(() => c.parse(token.slice(0, -1) + (token.endsWith("a") ? "b" : "a")));
});

test("extracted text normalization strips control characters", () => {
  assert.equal(normalizeExtractedText("a\r\nb\u0000\u0001\t c  \n"), "a\nb\t c");
});

test("text normalization handles large whitespace runs with linear scanner semantics", () => {
  const input = `${" ".repeat(20_000)}x${" ".repeat(20_000)}\r\n${"\t".repeat(20_000)}y`;
  const normalized = normalizeExtractedText(input);
  assert.equal(normalized[0], "x");
  assert.equal(normalized[1], "\n");
  assert.equal(normalized.includes(`${" ".repeat(20_000)}\n`), false);
  assert.equal(normalized.endsWith("y"), true);
  const scaled = normalizeExtractedText(`${" \t".repeat(40_000)}tail`);
  assert.equal(scaled, "tail");
});

test("text normalization enforces the extraction budget while scanning", () => {
  const normalized = normalizeExtractedText(`${"x".repeat(1_000_000)}\n${"y".repeat(1_000_000)}`, 128);
  assert.equal(normalized.length, 128);
  assert.equal(normalized, "x".repeat(128));
  assert.equal(normalizeExtractedText(`${" ".repeat(128)}x`, 128), "x");
});
