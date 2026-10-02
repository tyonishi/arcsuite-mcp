import test from "node:test";
import { constants } from "node:fs";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger, type AuditRecord } from "../../src/audit/auditLogger.ts";
import { RotatingAuditFile } from "../../src/audit/rotatingAuditFile.ts";
import { DEFAULT_AUDIT_RETENTION, loadAuditRetention, type AuditRetention } from "../../src/audit/retention.ts";

const stamp = Date.now();
const record = (n: number, time = stamp) => JSON.stringify({ ts: new Date(time).toISOString(), n, label: "合成" }) + "\n";
const policy = (change: Partial<AuditRetention> = {}): AuditRetention => ({ ...DEFAULT_AUDIT_RETENTION, maxFileBytes: 200, maxFiles: 3, maxRecordBytes: 200, ...change });
const auditRecord: AuditRecord = { ts: new Date().toISOString(), trace_id: "test", client_profile_id: "test", tool_name: "test", soap_operations: [], object_ids: [], result_code: "OK", latency_ms: 1 };

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.mkdtemp(join(tmpdir(), "arcsuite-retention-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, "audit.jsonl") };
}

async function privateFile(path: string, data: string) { await fs.writeFile(path, data, { mode: 0o600 }); }

test("retention defaults and invalid settings are bounded", () => {
  assert.deepEqual(loadAuditRetention({}), DEFAULT_AUDIT_RETENTION);
  for (const env of [
    { MCP_AUDIT_MAX_FILES: "33" }, { MCP_AUDIT_MAX_FILES: "0" }, { MCP_AUDIT_MAX_FILE_BYTES: "NaN" },
    { MCP_AUDIT_MAX_PENDING_RECORDS: "257" }, { MCP_AUDIT_MAX_AGE_SECONDS: "0" },
    { MCP_AUDIT_MAX_RECORD_BYTES: "65537" }, { MCP_AUDIT_MAX_FILE_BYTES: "32" }
  ]) assert.throws(() => loadAuditRetention(env));
});

test("exact UTF-8 boundary and finite generations include active file", async (t) => {
  const { path, dir } = await fixture(t);
  const line = record(1);
  const bytes = Buffer.byteLength(line);
  const store = new RotatingAuditFile(path, policy({ maxFileBytes: bytes * 2, maxRecordBytes: bytes }));
  for (let i = 0; i < 9; i++) await store.append(line);
  const files = await fs.readdir(dir);
  assert.deepEqual(files.sort(), ["audit.jsonl", "audit.jsonl.1", "audit.jsonl.2"]);
  let total = 0;
  for (const name of files) {
    const body = await fs.readFile(join(dir, name), "utf8");
    assert.ok(Buffer.byteLength(body) <= bytes * 2);
    for (const item of body.trim().split("\n")) assert.deepEqual(JSON.parse(item), JSON.parse(line));
    total += Buffer.byteLength(body);
  }
  assert.ok(total <= bytes * 2 * 3);
});

test("single file rotates without creating an archive", async (t) => {
  const { path, dir } = await fixture(t);
  const bytes = Buffer.byteLength(record(1));
  const store = new RotatingAuditFile(path, policy({ maxFiles: 1, maxFileBytes: bytes, maxRecordBytes: bytes }));
  await store.append(record(1)); await store.append(record(2));
  assert.deepEqual(await fs.readdir(dir), ["audit.jsonl"]);
  assert.equal(JSON.parse(await fs.readFile(path, "utf8")).n, 2);
});

test("continuous appends and restart do not extend oldest-record age", async (t) => {
  const { path } = await fixture(t);
  let now = stamp;
  const p = policy({ maxAgeSeconds: 10, maxFileBytes: 2000 });
  await new RotatingAuditFile(path, p, fs, () => now).append(record(1));
  now += 9000;
  await new RotatingAuditFile(path, p, fs, () => now).append(record(2, now));
  now += 1000;
  await new RotatingAuditFile(path, p, fs, () => now).sweep();
  await assert.rejects(fs.stat(path), { code: "ENOENT" });
});

test("lower file-count cleanup touches only reserved slots", async (t) => {
  const { path } = await fixture(t);
  for (const suffix of ["", ".1", ".2", ".31", ".32", ".backup"]) await privateFile(path + suffix, record(1));
  await new RotatingAuditFile(path, policy({ maxFiles: 1 })).sweep();
  for (const suffix of [".1", ".2", ".31"]) await assert.rejects(fs.stat(path + suffix), { code: "ENOENT" });
  for (const suffix of ["", ".32", ".backup"]) assert.equal(await fs.readFile(path + suffix, "utf8"), record(1));
});

test("unsafe reserved names block mutation before expired-file removal", async (t) => {
  const { path, dir } = await fixture(t);
  await privateFile(path, record(1, stamp - 20_000));
  const outside = join(dir, "unrelated"); await privateFile(outside, "keep");
  await fs.symlink(outside, path + ".2");
  await assert.rejects(new RotatingAuditFile(path, policy({ maxAgeSeconds: 1 })).sweep());
  assert.equal(await fs.readFile(outside, "utf8"), "keep");
  assert.equal(await fs.readFile(path, "utf8"), record(1, stamp - 20_000));
});

for (const kind of ["directory", "hard-link", "public-file"] as const) {
  test(`refuses ${kind} without changing it`, async (t) => {
    const { path, dir } = await fixture(t);
    if (kind === "directory") await fs.mkdir(path);
    else {
      await privateFile(path, record(1));
      if (kind === "hard-link") await fs.link(path, join(dir, "unrelated"));
      else await fs.chmod(path, 0o644);
    }
    await assert.rejects(new RotatingAuditFile(path, policy()).append(record(2)));
    if (kind !== "directory") assert.equal(await fs.readFile(path, "utf8"), record(1));
  });
}

test("malformed first record and pre-existing oversize are held for operator repair", async (t) => {
  const { path } = await fixture(t);
  for (const content of ["partial", "{bad}\n", '{"ts":"invalid"}\n', record(1).repeat(20)]) {
    await privateFile(path, content);
    await assert.rejects(new RotatingAuditFile(path, policy()).append(record(2)));
    assert.equal(await fs.readFile(path, "utf8"), content);
  }
});

test("crash-partial final line is archived, never joined to next JSON record", async (t) => {
  const { path } = await fixture(t);
  const original = record(1) + '{"partial":';
  await privateFile(path, original);
  await new RotatingAuditFile(path, policy()).append(record(2));
  assert.equal(await fs.readFile(path + ".1", "utf8"), original);
  assert.equal(await fs.readFile(path, "utf8"), record(2));
});

for (const operation of ["unlink", "rename"] as const) {
  test(`${operation} failure stops append, then recovers without replay`, async (t) => {
    const { path } = await fixture(t);
    const line = record(1); const bytes = Buffer.byteLength(line);
    const p = policy({ maxFileBytes: bytes, maxRecordBytes: bytes });
    for (const suffix of ["", ".1", ".2"]) await privateFile(path + suffix, line);
    let fail = true;
    const fake = { ...fs, [operation]: async (...args: [string, string]) => {
      if (fail) throw Object.assign(new Error("private"), { code: "EIO" });
      return operation === "unlink" ? fs.unlink(args[0]) : fs.rename(args[0], args[1]);
    } };
    const store = new RotatingAuditFile(path, p, fake as typeof fs);
    await assert.rejects(store.append(record(2)));
    assert.equal(await fs.readFile(path, "utf8"), line);
    fail = false;
    await store.append(record(3));
    assert.equal(JSON.parse(await fs.readFile(path, "utf8")).n, 3);
  });
}

test("bounded admission serializes accepted records and counts excess without retry", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const lines: string[] = []; const warnings: unknown[] = [];
  let active = 0; let peak = 0;
  const logger = new AuditLogger("synthetic/audit", {
    ensureDirectory: async () => undefined,
    append: async (_path, line) => { peak = Math.max(peak, ++active); await gate; lines.push(line); active--; },
    warn: (value) => warnings.push(value)
  }, { ...DEFAULT_AUDIT_RETENTION, maxPendingRecords: 2 });
  const calls = Array.from({ length: 20 }, () => logger.write(auditRecord));
  await new Promise<void>((resolve) => setImmediate(resolve));
  release(); await Promise.all(calls);
  assert.equal(peak, 1); assert.equal(lines.length, 2);
  assert.deepEqual(warnings, [{ event: "audit_write_failed", dropped_records: 1 }]);
});

test("oversized and deep inputs fail open before reaching storage", async () => {
  let writes = 0; let warnings = 0;
  const logger = new AuditLogger("synthetic/audit", {
    ensureDirectory: async () => undefined, append: async () => { writes++; }, warn: () => { warnings++; }
  });
  await logger.write({ ...auditRecord, trace_id: "x".repeat(100_000) });
  const sparse: string[] = []; sparse.length = 10_000_000;
  await logger.write({ ...auditRecord, object_ids: sparse });
  const nestedSparse = Array.from({ length: 100 }, () => new Array(4096));
  await logger.write({ ...auditRecord, nested: nestedSparse } as AuditRecord);
  const hidden: string[] = [];
  Object.defineProperty(hidden, 0, { value: "x".repeat(100_000), enumerable: false });
  await logger.write({ ...auditRecord, object_ids: hidden });
  let getterCalls = 0;
  const accessor: string[] = [];
  Object.defineProperty(accessor, 0, { enumerable: true, get: () => { getterCalls++; return "value"; } });
  await logger.write({ ...auditRecord, object_ids: accessor });
  assert.equal(getterCalls, 0);
  let deep: unknown = "end"; for (let i = 0; i < 20; i++) deep = { nested: deep };
  await logger.write({ ...auditRecord, nested: deep } as AuditRecord);
  assert.equal(writes, 0); assert.equal(warnings, 1);
});

test("idle sweeper expires records and stops on shutdown", async (t) => {
  const { path } = await fixture(t);
  await privateFile(path, record(1, Date.now() - 2000));
  const logger = new AuditLogger(path, {}, policy({ maxAgeSeconds: 1 }));
  logger.startMaintenance(); t.after(async () => logger.stopMaintenance());
  await logger.maintain();
  // The startup pass shares the queue; wait for its asynchronous filesystem work.
  for (let i = 0; i < 100; i++) {
    try { await fs.stat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("expired audit segment remained");
});

test("partial append failure rolls back its bytes and does not replay", async (t) => {
  const { path } = await fixture(t);
  await privateFile(path, record(1));
  let fail = true;
  const fake = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    if (typeof args[1] === "number" && (args[1] & constants.O_APPEND) !== 0 && fail) {
      const write = handle.write.bind(handle);
      handle.write = (async (data: Buffer, offset: number) => {
        await write(data, offset, 3);
        throw Object.assign(new Error("synthetic private failure"), { code: "ENOSPC" });
      }) as unknown as typeof handle.write;
    }
    return handle;
  } };
  const store = new RotatingAuditFile(path, policy({ maxFileBytes: 1000 }), fake);
  await assert.rejects(store.append(record(2)));
  assert.equal(await fs.readFile(path, "utf8"), record(1));
  fail = false; await store.append(record(3));
  assert.equal(await fs.readFile(path, "utf8"), record(1) + record(3));
});

test("backward event timestamps start a separate segment", async (t) => {
  const { path } = await fixture(t);
  const store = new RotatingAuditFile(path, policy({ maxFileBytes: 1000 }));
  await store.append(record(1));
  await store.append(record(2, stamp - 1000));
  assert.equal(await fs.readFile(path + ".1", "utf8"), record(1));
  assert.equal(await fs.readFile(path, "utf8"), record(2, stamp - 1000));
});

test("idle maintenance errors are sanitized and separate from rejected records", async (t) => {
  const { path } = await fixture(t);
  await privateFile(path, "synthetic-private-bad-data");
  const warnings: unknown[] = [];
  const logger = new AuditLogger(path, { warn: (value) => warnings.push(value) });
  await logger.maintain(); await logger.maintain(); await logger.write(auditRecord);
  assert.deepEqual(warnings, [
    { event: "audit_maintenance_failed", failed_maintenance: 1 },
    { event: "audit_write_failed", dropped_records: 1 }
  ]);
});

test("actual logger serializes concurrent writes into complete bounded files", async (t) => {
  const { path, dir } = await fixture(t);
  const p = { ...DEFAULT_AUDIT_RETENTION, maxFileBytes: 1000, maxRecordBytes: 1000, maxFiles: 4 };
  const logger = new AuditLogger(path, {}, p);
  await Promise.all(Array.from({ length: 40 }, (_, n) => logger.write({ ...auditRecord, trace_id: `test-${n}` })));
  const names = await fs.readdir(dir); assert.ok(names.length <= 4);
  let total = 0; const found = new Set<string>();
  for (const name of names) {
    const body = await fs.readFile(join(dir, name), "utf8");
    assert.ok(Buffer.byteLength(body) <= 1000); total += Buffer.byteLength(body);
    for (const line of body.trim().split("\n")) {
      const value = JSON.parse(line); assert.equal(value.result_code, "OK");
      assert.equal(found.has(value.trace_id), false); found.add(value.trace_id);
    }
  }
  assert.ok(total <= 4000); assert.ok(found.has("test-39"));
});

test("idle interval removes newly aged data and stop prevents subsequent sweeps", async (t) => {
  const { path } = await fixture(t);
  await privateFile(path, record(1, Date.now()));
  const logger = new AuditLogger(path, {}, policy({ maxAgeSeconds: 1 }));
  t.after(async () => logger.stopMaintenance());
  logger.startMaintenance();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(await fs.stat(path));
  await new Promise((resolve) => setTimeout(resolve, 1300));
  await assert.rejects(fs.stat(path), { code: "ENOENT" });
  logger.stopMaintenance();
  await privateFile(path, record(2, Date.now() - 2000));
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(JSON.parse(await fs.readFile(path, "utf8")).n, 2);
});


test("empty active file does not evict real archives on an earlier queued timestamp", async (t) => {
  const { path } = await fixture(t);
  await privateFile(path, "");
  await fs.utimes(path, new Date(stamp + 1000), new Date(stamp + 1000));
  await privateFile(path + ".1", record(1));
  await privateFile(path + ".2", record(2));
  await new RotatingAuditFile(path, policy()).append(record(3));
  assert.equal(await fs.readFile(path, "utf8"), record(3));
  assert.equal(await fs.readFile(path + ".1", "utf8"), record(1));
  assert.equal(await fs.readFile(path + ".2", "utf8"), record(2));
});
