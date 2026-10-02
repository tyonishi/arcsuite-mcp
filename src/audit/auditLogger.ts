import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { redactAuditValue } from "./redaction.ts";
import { DEFAULT_AUDIT_RETENTION, validateAuditRetention, type AuditRetention } from "./retention.ts";
import { RotatingAuditFile } from "./rotatingAuditFile.ts";

export type AuditRecord = {
  ts: string;
  trace_id: string;
  client_profile_id: string;
  tool_name: string;
  scope?: string;
  soap_operations: string[];
  object_ids: string[];
  result_code: string;
  result_count?: number;
  search_outcome?: "zero" | "matches" | "provider_failure" | "hydration_failure" | "metadata_unverifiable" | "predicate_mismatch";
  latency_ms: number;
};

export type AuditDiagnostic = Readonly<{
  event: "audit_write_failed";
  dropped_records: number;
}> | Readonly<{ event: "audit_maintenance_failed"; failed_maintenance: number }>;

type AuditLoggerOptions = {
  ensureDirectory: (path: string) => Promise<unknown>;
  append: (path: string, line: string) => Promise<unknown>;
  now: () => number;
  warn: (diagnostic: AuditDiagnostic) => unknown;
};

const WARNING_INTERVAL_MS = 60_000;

export class AuditLogger {
  private readonly path: string;
  private readonly options: AuditLoggerOptions;
  private droppedRecords = 0;
  private lastWarningAt: number | undefined;
  private warned = false;
  private readonly policy: AuditRetention;
  private readonly storage: RotatingAuditFile;
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private maintenancePending = false;
  private maintenanceFailures = 0;
  private lastMaintenanceWarning: number | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(path: string, options: Partial<AuditLoggerOptions> = {}, policy: AuditRetention = DEFAULT_AUDIT_RETENTION) {
    this.path = path;
    this.policy = validateAuditRetention(policy);
    this.storage = new RotatingAuditFile(path, this.policy);
    this.options = {
      ensureDirectory: (directory) => mkdir(directory, { recursive: true, mode: 0o700 }),
      append: (_destination, line) => this.storage.append(line),
      now: () => performance.now(),
      warn: (diagnostic) => console.error(JSON.stringify(diagnostic)),
      ...options
    };
  }

  async write(record: AuditRecord): Promise<void> {
    if (this.pending >= this.policy.maxPendingRecords) { this.reportFailure(); return; }
    let line: string;
    try {
      this.checkInputBound(record);
      if (typeof record.ts !== "string" || !Number.isFinite(Date.parse(record.ts)) || Date.parse(record.ts) < 0) {
        throw new Error("Invalid audit timestamp");
      }
      line = JSON.stringify(redactAuditValue(record)) + "\n";
      if (Buffer.byteLength(line, "utf8") > this.policy.maxRecordBytes) throw new Error("Audit record too large");
    } catch { this.reportFailure(); return; }
    await this.enqueue(async () => {
      try {
        await this.options.ensureDirectory(dirname(this.path));
        await this.options.append(this.path, line);
      } catch {
        // Storage failure must not change the business result or retry the record.
        this.reportFailure();
      }
    });
  }

  /** Starts one non-overlapping, unreferenced cleanup timer; no queued timer backlog. */
  startMaintenance(): void {
    if (this.timer) return;
    void this.maintain();
    this.timer = setInterval(() => { void this.maintain(); }, Math.min(60_000, this.policy.maxAgeSeconds * 1000));
    this.timer.unref();
  }

  stopMaintenance(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async maintain(): Promise<void> {
    if (this.maintenancePending || this.pending >= this.policy.maxPendingRecords) return;
    this.maintenancePending = true;
    try {
      await this.enqueue(async () => {
        try { await this.storage.sweep(); }
        catch { this.reportMaintenanceFailure(); }
      });
    } finally { this.maintenancePending = false; }
  }

  private async enqueue(work: () => Promise<void>): Promise<void> {
    this.pending++;
    const next = this.tail.then(work);
    this.tail = next.catch(() => undefined);
    try { await next; }
    finally { this.pending--; }
  }

  /** Bound traversal before recursive redaction and JSON materialization. */
  private checkInputBound(value: unknown): void {
    const seen = new Set<object>();
    let remaining = this.policy.maxRecordBytes;
    let nodes = 4096;
    const visit = (item: unknown, depth: number): void => {
      if (--nodes < 0 || depth > 16) throw new Error("Audit structure too large");
      if (typeof item === "string") remaining -= Buffer.byteLength(item, "utf8");
      else if (item && typeof item === "object") {
        if (Array.isArray(item)) {
          if (item.length > 4096) throw new Error("Audit array too large");
          for (let i = 0; i < item.length; i++) {
            const descriptor = Object.getOwnPropertyDescriptor(item, i);
            if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("Invalid audit array slot");
          }
        }
        const prototype = Object.getPrototypeOf(item);
        if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) throw new Error("Invalid audit value");
        if (seen.has(item)) throw new Error("Cyclic audit record");
        seen.add(item);
        for (const key in item) {
          if (!Object.hasOwn(item, key)) continue;
          remaining -= Buffer.byteLength(key, "utf8");
          if (remaining < 0) throw new Error("Audit record too large");
          const descriptor = Object.getOwnPropertyDescriptor(item, key);
          if (!descriptor || !("value" in descriptor)) throw new Error("Audit accessor is not supported");
          visit(descriptor.value, depth + 1);
        }
        seen.delete(item);
      }
      else if (typeof item === "function" || typeof item === "bigint" || typeof item === "symbol") throw new Error("Invalid audit value");
      if (remaining < 0) throw new Error("Audit record too large");
    };
    visit(value, 0);
  }

  private reportMaintenanceFailure(): void {
    this.maintenanceFailures = Math.min(Number.MAX_SAFE_INTEGER, this.maintenanceFailures + 1);
    try {
      let now = Number.NaN;
      try { now = this.options.now(); } catch { /* Still report the first failure. */ }
      if (this.lastMaintenanceWarning !== undefined && (!Number.isFinite(now) || now - this.lastMaintenanceWarning < WARNING_INTERVAL_MS)) return;
      this.lastMaintenanceWarning = Number.isFinite(now) ? now : 0;
      const result = this.options.warn(Object.freeze({ event: "audit_maintenance_failed", failed_maintenance: this.maintenanceFailures }));
      void Promise.resolve(result).catch(() => undefined);
    } catch { /* Diagnostics never recurse or affect business operations. */ }
  }

  private reportFailure(): void {
    this.droppedRecords = Math.min(Number.MAX_SAFE_INTEGER, this.droppedRecords + 1);
    try {
      let now = Number.NaN;
      try { now = this.options.now(); } catch { /* Clock failure must not hide the first warning. */ }
      const validTime = Number.isFinite(now) && now >= 0;
      if (this.warned) {
        if (!validTime) return;
        if (this.lastWarningAt === undefined) { this.lastWarningAt = now; return; }
        if (now - this.lastWarningAt < WARNING_INTERVAL_MS) return;
      }
      this.warned = true;
      this.lastWarningAt = validTime ? now : undefined;
      const diagnostic: AuditDiagnostic = Object.freeze({ event: "audit_write_failed", dropped_records: this.droppedRecords });
      // A failing or asynchronous diagnostic sink must not create another failure path.
      const result = this.options.warn(diagnostic);
      void Promise.resolve(result).catch(() => undefined);
    } catch {
      // Diagnostics are best-effort and never recursively log their own failure.
    }
  }
}
