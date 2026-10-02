package biz.capricornus.arcsuite.mcp.adapter;

/** Finite process-local admission limits; operators size them against heap and load. */
record AdapterLimits(int httpWorkers, int httpQueue, int activeRequests, int parserWorkers) {
    AdapterLimits {
        if (httpWorkers < 2 || httpWorkers > 128 || httpQueue < 1 || httpQueue > 256
                || activeRequests < 1 || activeRequests >= httpWorkers
                || parserWorkers < 1 || parserWorkers > activeRequests) {
            throw new IllegalArgumentException("Invalid adapter capacity limits");
        }
    }

    static AdapterLimits defaults() { return new AdapterLimits(8, 16, 4, 2); }

    static AdapterLimits fromEnv() {
        return new AdapterLimits(value("ARCSUITE_HTTP_WORKERS", 8), value("ARCSUITE_HTTP_QUEUE", 16),
                value("ARCSUITE_ACTIVE_REQUESTS", 4), value("ARCSUITE_PARSER_WORKERS", 2));
    }

    private static int value(String name, int fallback) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) return fallback;
        try { return Integer.parseInt(value); }
        catch (NumberFormatException e) { throw new IllegalArgumentException(name + " must be an integer"); }
    }
}
