/** Operator-configured bounds for a single-writer audit file set. */
export type AuditRetention = Readonly<{
  maxFileBytes: number;
  maxFiles: number;
  maxAgeSeconds: number;
  maxRecordBytes: number;
  maxPendingRecords: number;
}>;

export const AUDIT_LIMITS = Object.freeze({
  maxFileBytes: 100 * 1024 * 1024,
  maxFiles: 32,
  maxAgeSeconds: 365 * 24 * 60 * 60,
  maxRecordBytes: 64 * 1024,
  maxPendingRecords: 256
});

export const DEFAULT_AUDIT_RETENTION: AuditRetention = Object.freeze({
  maxFileBytes: 10 * 1024 * 1024,
  maxFiles: 5,
  maxAgeSeconds: 7 * 24 * 60 * 60,
  maxRecordBytes: 64 * 1024,
  maxPendingRecords: 128
});

export function validateAuditRetention(value: AuditRetention): AuditRetention {
  for (const key of Object.keys(AUDIT_LIMITS) as (keyof AuditRetention)[]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > AUDIT_LIMITS[key]) {
      throw new Error(`Invalid audit retention setting: ${key}`);
    }
  }
  if (value.maxRecordBytes > value.maxFileBytes) throw new Error("Audit record bound exceeds file bound");
  return Object.freeze({ ...value });
}

export function loadAuditRetention(env: NodeJS.ProcessEnv): AuditRetention {
  return validateAuditRetention({
    maxFileBytes: Number(env.MCP_AUDIT_MAX_FILE_BYTES ?? DEFAULT_AUDIT_RETENTION.maxFileBytes),
    maxFiles: Number(env.MCP_AUDIT_MAX_FILES ?? DEFAULT_AUDIT_RETENTION.maxFiles),
    maxAgeSeconds: Number(env.MCP_AUDIT_MAX_AGE_SECONDS ?? DEFAULT_AUDIT_RETENTION.maxAgeSeconds),
    maxRecordBytes: Number(env.MCP_AUDIT_MAX_RECORD_BYTES ?? DEFAULT_AUDIT_RETENTION.maxRecordBytes),
    maxPendingRecords: Number(env.MCP_AUDIT_MAX_PENDING_RECORDS ?? DEFAULT_AUDIT_RETENTION.maxPendingRecords)
  });
}
