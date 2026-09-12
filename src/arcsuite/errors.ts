export class ArcSuiteAdapterError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly upstreamCode?: string;

  constructor(code: string, message: string, options: { retryable?: boolean; upstreamCode?: string } = {}) {
    super(message);
    this.name = "ArcSuiteAdapterError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.upstreamCode = options.upstreamCode;
  }
}
