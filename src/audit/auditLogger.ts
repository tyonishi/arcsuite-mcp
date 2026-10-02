import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { redactAuditValue } from "./redaction.ts";

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
}>;

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

  constructor(path: string, options: Partial<AuditLoggerOptions> = {}) {
    this.path = path;
    this.options = {
      ensureDirectory: (directory) => mkdir(directory, { recursive: true }),
      append: (destination, line) => appendFile(destination, line, { encoding: "utf8", mode: 0o600 }),
      now: () => performance.now(),
      warn: (diagnostic) => console.error(JSON.stringify(diagnostic)),
      ...options
    };
  }

  async write(record: AuditRecord): Promise<void> {
    try {
      await this.options.ensureDirectory(dirname(this.path));
      const safe = redactAuditValue(record);
      await this.options.append(this.path, JSON.stringify(safe) + "\n");
    } catch {
      // Audit storage failure must not change the business outcome or retain the record.
      this.reportFailure();
    }
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
