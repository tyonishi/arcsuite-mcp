import test from "node:test";
import assert from "node:assert/strict";
import { AuditLogger, type AuditRecord } from "../../src/audit/auditLogger.ts";

const record: AuditRecord = {
  ts: "2026-01-01T00:00:00Z", trace_id: "synthetic-trace", client_profile_id: "synthetic-profile",
  tool_name: "arcsuite_get_document", soap_operations: [], object_ids: [], result_code: "OK", latency_ms: 1
};

test("audit success preserves metadata and redacts sensitive fields", async () => {
  const lines: string[] = [];
  let warningCount = 0;
  const logger = new AuditLogger("synthetic/audit.jsonl", {
    ensureDirectory: async (path) => assert.equal(path, "synthetic"),
    append: async (path, line) => { assert.equal(path, "synthetic/audit.jsonl"); lines.push(line); },
    warn: () => { warningCount++; }
  });
  await logger.write({ ...record, password: "TEST-redacted-value", content: "synthetic-private-content" } as AuditRecord);
  assert.deepEqual(JSON.parse(lines[0]!), record);
  assert.equal(warningCount, 0);
});

test("audit failures are sampled, sanitized, fail-open, and never retried", async () => {
  let now = 0;
  let calls = 0;
  let fail = true;
  const warnings: unknown[] = [];
  const logger = new AuditLogger("synthetic/private-path", {
    ensureDirectory: async () => undefined,
    append: async () => { calls++; if (fail) throw Object.assign(new Error("synthetic-private-value/path"), { code: "ENOSPC" }); },
    now: () => now,
    warn: (value) => warnings.push(value)
  });
  for (let i = 0; i < 5; i++) await logger.write(record);
  assert.equal(calls, 5);
  assert.deepEqual(warnings, [{ event: "audit_write_failed", dropped_records: 1 }]);
  now = 60_000;
  await logger.write(record);
  assert.deepEqual(warnings[1], { event: "audit_write_failed", dropped_records: 6 });
  assert.equal(JSON.stringify(warnings).includes("synthetic"), false);
  fail = false;
  await logger.write(record);
  assert.equal(calls, 7);
  assert.equal(warnings.length, 2);
});

for (const code of ["EACCES", "ENOSPC", "EIO"]) {
  test(`audit ${code} mkdir failure does not reach append or escape`, async () => {
    let warnings = 0;
    let appends = 0;
    const logger = new AuditLogger("synthetic/private", {
      ensureDirectory: async () => { throw Object.assign(new Error("private"), { code }); },
      append: async () => { appends++; },
      warn: () => { warnings++; throw new Error("diagnostic failure"); }
    });
    await assert.doesNotReject(logger.write(record));
    assert.equal(warnings, 1);
    assert.equal(appends, 0);
  });
}

test("async warning rejection and clock failure do not affect business callers", async () => {
  let calls = 0;
  const logger = new AuditLogger("synthetic/private", {
    ensureDirectory: async () => { throw new Error("private"); },
    now: () => { throw new Error("clock"); },
    warn: async () => { calls++; throw new Error("sink"); }
  });
  await logger.write(record);
  await logger.write(record);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
});

test("serialization failure is contained and warning clock can recover", async () => {
  let now = Number.NaN;
  const warnings: unknown[] = [];
  let appends = 0;
  const cyclic = { ...record } as AuditRecord & { nested?: unknown };
  cyclic.nested = cyclic;
  const logger = new AuditLogger("synthetic/private", {
    ensureDirectory: async () => undefined,
    append: async () => { appends++; },
    now: () => now,
    warn: (value) => warnings.push(value)
  });
  await logger.write(cyclic);
  now = 1;
  await logger.write(cyclic);
  now = 60_001;
  await logger.write(cyclic);
  assert.deepEqual(warnings, [{ event: "audit_write_failed", dropped_records: 1 }, { event: "audit_write_failed", dropped_records: 3 }]);
  assert.equal(appends, 0);
});
