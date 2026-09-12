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
  latency_ms: number;
};

export class AuditLogger {
  private readonly path: string;
  constructor(path: string) { this.path = path; }
  async write(record: AuditRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const safe = redactAuditValue(record);
    await appendFile(this.path, JSON.stringify(safe) + "\n", { encoding: "utf8", mode: 0o600 });
  }
}
