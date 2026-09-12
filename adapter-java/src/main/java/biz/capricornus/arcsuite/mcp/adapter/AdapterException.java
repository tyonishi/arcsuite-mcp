package biz.capricornus.arcsuite.mcp.adapter;

final class AdapterException extends RuntimeException {
    final String code;
    final boolean retryable;
    final String upstreamCode;

    AdapterException(String code, String message) {
        this(code, message, false, null, null);
    }

    AdapterException(String code, String message, boolean retryable, String upstreamCode) {
        this(code, message, retryable, upstreamCode, null);
    }

    AdapterException(String code, String message, boolean retryable, String upstreamCode, Throwable cause) {
        super(message, cause);
        this.code = code;
        this.retryable = retryable;
        this.upstreamCode = upstreamCode;
    }
}
