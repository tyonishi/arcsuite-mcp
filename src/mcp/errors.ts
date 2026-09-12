import { ArcSuiteAdapterError } from "../arcsuite/errors.ts";

export class McpToolError extends Error {
  readonly stableCode: string;
  readonly category: string;
  readonly retryable: boolean;
  constructor(stableCode: string, category: string, retryable: boolean, message = stableCode) {
    super(message);
    this.stableCode = stableCode;
    this.category = category;
    this.retryable = retryable;
  }
}

export function toMcpToolError(error: unknown): McpToolError {
  if (error instanceof McpToolError) return error;
  if (error instanceof ArcSuiteAdapterError) {
    const known = new Set([
      "ARCSUITE_NOT_AVAILABLE",
      "ARCSUITE_INVALID_ARGUMENT",
      "ARCSUITE_SESSION_EXPIRED",
      "ARCSUITE_FORBIDDEN",
      "ARCSUITE_LIMIT_EXCEEDED",
      "ARCSUITE_CONFLICT",
      "ARCSUITE_TIMEOUT",
      "ARCSUITE_UPSTREAM_ERROR"
    ]);
    const code = known.has(error.code) ? error.code : "ARCSUITE_UPSTREAM_ERROR";
    return new McpToolError(code, code.replace(/^ARCSUITE_/, "").toLowerCase(), error.retryable, code);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("UNSUPPORTED_CONTENT_TYPE")) return new McpToolError("UNSUPPORTED_CONTENT_TYPE", "unsupported_content_type", false);
  if (/CURSOR/.test(message)) return new McpToolError("ARCSUITE_INVALID_ARGUMENT", "invalid_cursor", false);
  if (error instanceof TypeError) return new McpToolError("ARCSUITE_INVALID_ARGUMENT", "invalid_argument", false);
  return new McpToolError("ARCSUITE_UPSTREAM_ERROR", "upstream_error", false);
}
