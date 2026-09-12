const FORBIDDEN_KEYS = new Set([
  "password",
  "credential",
  "securityToken",
  "sessionId",
  "rawSoap",
  "binary",
  "content",
  "query"
]);

export function redactAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAuditValue);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    out[key] = redactAuditValue(item);
  }
  return out;
}
