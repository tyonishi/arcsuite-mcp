import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRuntime } from "../../src/server.ts";

const documentA = "rep:mock:EXAMPLE_CABINET:1001";
const documentB = "rep:mock:EXAMPLE_CABINET:1002";
const toolName = "arcsuite_validate_document_integrity";

async function runtime(scopeFile = resolve("config/scopes.mock.yaml")) {
  const dir = await mkdtemp(join(tmpdir(), "arcsuite-integrity-"));
  return buildRuntime({
    ...process.env,
    NODE_ENV: "test",
    ARCSUITE_ADAPTER_MODE: "mock",
    MCP_DEV_BEARER_TOKEN: "test-token",
    MCP_SCOPES_FILE: scopeFile,
    MCP_SHARED_TEMP_DIR: join(dir, "shared"),
    MCP_AUDIT_LOG_PATH: join(dir, "audit.jsonl"),
    MCP_CURSOR_HMAC_SECRET: "0123456789abcdef0123456789abcdef",
    MCP_VALIDATE_ON_STARTUP: "true"
  });
}

async function customizedScope(options: { enabled: boolean; allowEvidence: boolean; root?: string }) {
  const dir = await mkdtemp(join(tmpdir(), "arcsuite-integrity-scope-"));
  let source = await readFile(resolve("config/scopes.mock.yaml"), "utf8");
  const integrityBlock = `    integrity:\n      enabled: ${options.enabled}\n      allow_evidence: ${options.allowEvidence}`;
  if (source.includes("    integrity:\n")) {
    source = source.replace(/    integrity:\n(?:      .*\n)*/u, integrityBlock + "\n");
  } else {
    source = source.replace("    relationships:\n      hard_references: true", `    relationships:\n      hard_references: true\n\n${integrityBlock}`);
  }
  if (options.root) source = source.replace("root_object_id: null", `root_object_id: "${options.root}"`);
  const path = join(dir, "scopes.yaml");
  await writeFile(path, source);
  return path;
}

function profile(overrides: Record<string, unknown> = {}) {
  return {
    clientProfileId: "dev-profile",
    allowedScopes: ["example_documents"],
    allowedTools: [
      "arcsuite_describe_capabilities",
      "arcsuite_search_documents",
      "arcsuite_get_document",
      "arcsuite_get_documents",
      "arcsuite_list_folder",
      "arcsuite_list_document_revisions",
      "arcsuite_get_document_content_info",
      "arcsuite_read_document",
      "arcsuite_list_hard_references",
      toolName
    ],
    rateLimit: { requestsPerMinute: 120, burst: 30 },
    ...overrides
  } as any;
}

function installValidation(adapter: any, result: unknown) {
  const calls: unknown[] = [];
  adapter.validateIntegrity = async (request: unknown) => {
    calls.push(structuredClone(request));
    return structuredClone(result);
  };
  return calls;
}

function installEvidence(adapter: any, result: unknown) {
  const calls: unknown[] = [];
  adapter.certificateEvidence = async (request: unknown) => {
    calls.push(structuredClone(request));
    return structuredClone(result);
  };
  return calls;
}

const validValidation = {
  certificates: [
    { certId: 7_654_321, result: true, exceptionPresent: false },
    { certId: 7_654_322, result: true, exceptionPresent: false }
  ],
  failure: null
};

test("document integrity reports only normalized validation and correlated evidence", async () => {
  const rt = await runtime();
  const validationCalls = installValidation(rt.adapter as any, validValidation);
  const evidenceCalls = installEvidence(rt.adapter as any, { certIds: [7_654_321] });

  const result = await rt.tools.call(profile(), toolName, { document_id: documentA, include_evidence: true });
  const data: any = result.structuredContent;
  assert.deepEqual(data, {
    document_id: documentA,
    status: "valid",
    certificate_count: 2,
    warnings: [],
    evidence: [
      { cert_id: 7_654_321, evidence_available: true },
      { cert_id: 7_654_322, evidence_available: false }
    ]
  });
  assert.deepEqual(validationCalls, [{ clientProfileId: "dev-profile", id: documentA }]);
  assert.deepEqual(evidenceCalls, [{ clientProfileId: "dev-profile", id: documentA }]);
  for (const entry of data.evidence) assert.deepEqual(Object.keys(entry).sort(), ["cert_id", "evidence_available"]);

  const audit = JSON.parse((await readFile(rt.config.auditLogPath, "utf8")).trim());
  assert.deepEqual(audit.object_ids, [documentA]);
  assert.ok(audit.soap_operations.includes("validateCertificate"));
  assert.ok(audit.soap_operations.includes("getCertificateEvidence"));
  assert.equal(JSON.stringify(audit).includes("7654321"), false);
});

test("false validation remains invalid_or_unverifiable even when evidence exists", async () => {
  const rt = await runtime();
  installValidation(rt.adapter as any, {
    certificates: [{ certId: 73, result: false, exceptionPresent: false }],
    failure: null
  });
  installEvidence(rt.adapter as any, { certIds: [73] });

  const result = await rt.tools.call(profile(), toolName, { document_id: documentB, include_evidence: true });
  const data: any = result.structuredContent;
  assert.equal(data.status, "invalid_or_unverifiable");
  assert.equal(data.certificate_count, 1);
  assert.deepEqual(data.warnings, ["VALIDATION_NOT_PROVEN"]);
  assert.deepEqual(data.evidence, [{ cert_id: 73, evidence_available: true }]);
  const output = `${JSON.stringify(data)} ${result.content.map((entry) => entry.text).join(" ")}`;
  assert.doesNotMatch(output, /tampered|altered|forged|invalid signature|corruption detected/i);
});

test("missing evidence is reported as unavailable without changing validation status", async () => {
  const rt = await runtime();
  installValidation(rt.adapter as any, validValidation);
  const evidenceCalls = installEvidence(rt.adapter as any, { certIds: [] });
  const data: any = (await rt.tools.call(profile(), toolName, { document_id: documentA, include_evidence: true })).structuredContent;
  assert.equal(data.status, "valid");
  assert.deepEqual(data.evidence, [
    { cert_id: 7_654_321, evidence_available: false },
    { cert_id: 7_654_322, evidence_available: false }
  ]);
  assert.equal(evidenceCalls.length, 1);
});

test("empty validation elements and exception presence stay conservative", async () => {
  const rt = await runtime();
  const adapter: any = rt.adapter;
  const calls = installValidation(adapter, { certificates: [], failure: null });
  const empty: any = (await rt.tools.call(profile(), toolName, { document_id: documentA })).structuredContent;
  assert.equal(empty.status, "invalid_or_unverifiable");
  assert.equal(empty.certificate_count, 0);
  assert.deepEqual(empty.warnings, ["NO_VALIDATION_ELEMENTS"]);
  assert.equal(Object.hasOwn(empty, "evidence"), false);

  adapter.validateIntegrity = async () => ({
    certificates: [{ certId: 80, result: true, exceptionPresent: true }],
    failure: null
  });
  const exceptional: any = (await rt.tools.call(profile(), toolName, { document_id: documentA })).structuredContent;
  assert.equal(exceptional.status, "invalid_or_unverifiable");
  assert.deepEqual(exceptional.warnings, ["VALIDATION_ELEMENT_EXCEPTION"]);
  assert.equal(JSON.stringify(exceptional).includes("ProcessingException"), false);
  assert.equal(JSON.stringify(exceptional).includes("7654321"), false);
  assert.equal(calls.length, 1);
});

test("per-ID failure is a semantic state and skips evidence", async () => {
  const rt = await runtime();
  installValidation(rt.adapter as any, { certificates: [], failure: "per_id" });
  const evidenceCalls = installEvidence(rt.adapter as any, { certIds: [73] });
  const data: any = (await rt.tools.call(profile(), toolName, { document_id: documentA, include_evidence: true })).structuredContent;
  assert.equal(data.status, "validation_failed");
  assert.equal(data.certificate_count, 0);
  assert.deepEqual(data.warnings, []);
  assert.deepEqual(data.evidence, []);
  assert.equal(evidenceCalls.length, 0);
});

test("evidence defaults off and a profile must allow the semantic tool", async () => {
  const rt = await runtime();
  installValidation(rt.adapter as any, validValidation);
  const evidenceCalls = installEvidence(rt.adapter as any, { certIds: [] });
  const data: any = (await rt.tools.call(profile(), toolName, { document_id: documentA })).structuredContent;
  assert.equal(Object.hasOwn(data, "evidence"), false);
  assert.equal(evidenceCalls.length, 0);

  const deniedCalls = installValidation(rt.adapter as any, validValidation);
  await assert.rejects(
    () => rt.tools.call(profile({ allowedTools: ["arcsuite_describe_capabilities"] }), toolName, { document_id: documentA }),
    (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN"
  );
  assert.equal(deniedCalls.length, 0);
});

test("scope and evidence opt-ins fail closed before integrity dispatch", async () => {
  const disabled = await runtime(await customizedScope({ enabled: false, allowEvidence: false }));
  let calls = installValidation(disabled.adapter as any, validValidation);
  await assert.rejects(
    () => disabled.tools.call(profile(), toolName, { document_id: documentA }),
    (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN"
  );
  assert.equal(calls.length, 0);

  const noEvidence = await runtime(await customizedScope({ enabled: true, allowEvidence: false }));
  calls = installValidation(noEvidence.adapter as any, validValidation);
  const evidenceCalls = installEvidence(noEvidence.adapter as any, { certIds: [7_654_321] });
  await assert.rejects(
    () => noEvidence.tools.call(profile(), toolName, { document_id: documentA, include_evidence: true }),
    (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN"
  );
  assert.equal(calls.length, 0);
  assert.equal(evidenceCalls.length, 0);
});

test("cabinet, root, identity, and document-type checks precede validation", async () => {
  const rt = await runtime(await customizedScope({
    enabled: true,
    allowEvidence: true,
    root: "rep:mock:EXAMPLE_CABINET:folder-a"
  }));
  const adapter: any = rt.adapter;
  const validations = installValidation(adapter, validValidation);
  const gets: unknown[] = [];
  const originalGet = adapter.get.bind(adapter);
  adapter.get = async (request: unknown) => {
    gets.push(structuredClone(request));
    return originalGet(request);
  };

  await assert.rejects(
    () => rt.tools.call(profile(), toolName, { document_id: "rep:mock:OTHER_CABINET:1001" }),
    (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN"
  );
  assert.equal(gets.length, 0, "an outside-cabinet ID must be rejected before object lookup");
  await assert.rejects(
    () => rt.tools.call(profile(), toolName, { document_id: documentB }),
    (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN"
  );
  assert.equal(gets.length, 1, "the in-cabinet outside-root ID is checked against its path");

  adapter.get = async (request: any) => {
    gets.push(structuredClone(request));
    return { ...(await originalGet(request)), objectClass: "folder" };
  };
  await assert.rejects(
    () => rt.tools.call(profile(), toolName, { document_id: documentA }),
    (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN"
  );

  adapter.get = async (request: any) => {
    gets.push(structuredClone(request));
    return { ...(await originalGet(request)), id: documentB };
  };
  await assert.rejects(
    () => rt.tools.call(profile(), toolName, { document_id: documentA }),
    (error: any) => error?.stableCode === "ARCSUITE_FORBIDDEN"
  );

  assert.equal(validations.length, 0);
  assert.equal(gets.length, 3);
  assert.equal((gets[0] as any).resolveRef, false);
  assert.equal((gets[0] as any).includePath, true);
});

test("malformed or excessive adapter integrity results fail closed", async () => {
  const rt = await runtime();
  const adapter: any = rt.adapter;
  adapter.validateIntegrity = async () => ({
    certificates: [{ certId: 73, result: true, exceptionPresent: false, exception: "private upstream text" }],
    failure: null
  });
  await assert.rejects(
    () => rt.tools.call(profile(), toolName, { document_id: documentA }),
    (error: any) => error?.stableCode === "ARCSUITE_UPSTREAM_ERROR"
  );

  adapter.validateIntegrity = async () => ({
    certificates: [{ certId: 73, result: true, exceptionPresent: false }],
    failure: "per_id"
  });
  await assert.rejects(
    () => rt.tools.call(profile(), toolName, { document_id: documentA }),
    (error: any) => error?.stableCode === "ARCSUITE_UPSTREAM_ERROR"
  );

  adapter.validateIntegrity = async () => ({
    certificates: Array.from({ length: 65 }, (_, index) => ({ certId: index + 1, result: true, exceptionPresent: false })),
    failure: null
  });
  await assert.rejects(
    () => rt.tools.call(profile(), toolName, { document_id: documentA }),
    (error: any) => error?.stableCode === "ARCSUITE_LIMIT_EXCEEDED"
  );
});

test("unexpected evidence IDs fail closed", async () => {
  const rt = await runtime();
  installValidation(rt.adapter as any, validValidation);
  installEvidence(rt.adapter as any, { certIds: [7_654_321, 999_999] });
  await assert.rejects(
    () => rt.tools.call(profile(), toolName, { document_id: documentA, include_evidence: true }),
    (error: any) => error?.stableCode === "ARCSUITE_UPSTREAM_ERROR"
  );
});

test("capability discovery reports integrity policy without SOAP details", async () => {
  const rt = await runtime();
  const data: any = (await rt.tools.call(profile(), "arcsuite_describe_capabilities", {})).structuredContent;
  assert.deepEqual(data.scopes[0].integrity, { validation: true, evidence: true });
  assert.equal(data.version, "1.2");
  const serialized = JSON.stringify(data);
  assert.equal(serialized.includes("validateCertificate"), false);
  assert.equal(serialized.includes("getCertificateEvidence"), false);
  assert.equal(serialized.includes("CertificateValidateElement"), false);

  const disabled = await runtime(await customizedScope({ enabled: false, allowEvidence: false }));
  const disabledData: any = (await disabled.tools.call(profile(), "arcsuite_describe_capabilities", {})).structuredContent;
  assert.equal(Object.hasOwn(disabledData.scopes[0], "integrity"), false);
});
