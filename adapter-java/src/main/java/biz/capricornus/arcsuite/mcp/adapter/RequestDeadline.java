package biz.capricornus.arcsuite.mcp.adapter;

import java.time.Duration;
import java.util.function.LongSupplier;

/** A monotonic budget shared by one SOAP exchange and its response parsing. */
final class RequestDeadline {
    private final LongSupplier clock;
    private final long started;
    private final long budget;

    RequestDeadline(Duration timeout) { this(timeout, System::nanoTime); }

    RequestDeadline(Duration timeout, LongSupplier clock) {
        this.clock = clock;
        this.started = clock.getAsLong();
        this.budget = timeout.toNanos();
        if (budget <= 0) throw new IllegalArgumentException("Request timeout must be positive");
    }

    long remainingNanos() {
        checkInterrupted();
        long elapsed = clock.getAsLong() - started;
        if (elapsed < 0 || elapsed >= budget) throw timeout(null);
        return budget - elapsed;
    }

    void check() { remainingNanos(); }

    static AdapterException timeout(Throwable cause) {
        return new AdapterException("ARCSUITE_TIMEOUT", "ArcSuite request timed out", true, null, cause);
    }

    private static void checkInterrupted() {
        if (Thread.currentThread().isInterrupted()) {
            throw new AdapterException("ARCSUITE_UPSTREAM_ERROR", "ArcSuite request interrupted", false, null);
        }
    }
}
