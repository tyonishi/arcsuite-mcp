const FORBIDDEN_KEYS = new Set([
  "password",
  "credential",
  "securitytoken",
  "sessionid",
  "rawsoap",
  "binary",
  "content",
  "query",
  "ref",
  "search_ref",
  "continuation_ref",
  "result_ref",
  "locator",
  "tag",
  "policyfingerprint",
  "tokenhash",
  "tokensha256",
  "cursor",
  "decodedhandlerecord"
]);

export function redactAuditValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAuditValue);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) continue;
    out[key] = redactAuditValue(item);
  }
  return out;
}
