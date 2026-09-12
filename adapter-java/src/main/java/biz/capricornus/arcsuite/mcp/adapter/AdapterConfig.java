package biz.capricornus.arcsuite.mcp.adapter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.time.Duration;
import java.util.Set;

record AdapterConfig(
        String endpoint,
        String username,
        String password,
        String internalToken,
        int port,
        String bindHost,
        Duration connectTimeout,
        Duration requestTimeout,
        int sessionIdleTtlSeconds,
        int sessionMaxAgeSeconds,
        int perSessionConcurrency,
        String locale,
        String requestVersion,
        Path sharedTempDir,
        long maxContentBytes
) {
    private static final long MAX_CONFIG_CONTENT_BYTES = 100L * 1024 * 1024;

    static AdapterConfig fromEnv() {
        String endpoint = required("ARCSUITE_SOAP_ENDPOINT");
        if (!endpoint.startsWith("https://") && !Boolean.parseBoolean(env("ARCSUITE_ALLOW_HTTP", "false"))) {
            throw new IllegalArgumentException("ARCSUITE_SOAP_ENDPOINT must use https:// unless ARCSUITE_ALLOW_HTTP=true");
        }
        String username = required("ARCSUITE_USERNAME");
        String passwordFile = required("ARCSUITE_PASSWORD_FILE");
        String password;
        try {
            password = Files.readString(Path.of(passwordFile), StandardCharsets.UTF_8).stripTrailing();
        } catch (IOException e) {
            throw new IllegalArgumentException("Cannot read ARCSUITE_PASSWORD_FILE", e);
        }
        if (password.isEmpty()) throw new IllegalArgumentException("ArcSuite password file is empty");
        String token = secret("ARCSUITE_ADAPTER_INTERNAL_TOKEN_FILE", "ARCSUITE_ADAPTER_INTERNAL_TOKEN");
        Path temp = Path.of(env("MCP_TEMP_DIR", "/tmp/arcsuite-mcp")).toAbsolutePath().normalize();
        try {
            Files.createDirectories(temp);
            Files.setPosixFilePermissions(temp, Set.of(
                    PosixFilePermission.OWNER_READ,
                    PosixFilePermission.OWNER_WRITE,
                    PosixFilePermission.OWNER_EXECUTE
            ));
        } catch (IOException | UnsupportedOperationException e) {
            throw new IllegalArgumentException("Cannot secure MCP_TEMP_DIR", e);
        }
        return new AdapterConfig(
                endpoint,
                username,
                password,
                token,
                integer("ARCSUITE_ADAPTER_PORT", 18080, 1, 65535),
                env("ARCSUITE_ADAPTER_BIND_HOST", "127.0.0.1"),
                Duration.ofMillis(integer("ARCSUITE_CONNECT_TIMEOUT_MS", 30_000, 1_000, 600_000)),
                Duration.ofMillis(integer("ARCSUITE_REQUEST_TIMEOUT_MS", 600_000, 1_000, 86_400_000)),
                integer("ARCSUITE_SESSION_IDLE_TTL_SECONDS", 1500, 30, 86400),
                integer("ARCSUITE_SESSION_MAX_AGE_SECONDS", 1700, 30, 86400),
                integer("ARCSUITE_PER_SESSION_CONCURRENCY", 4, 1, 100),
                env("ARCSUITE_LOCALE", "ja"),
                env("ARCSUITE_REQUEST_VERSION", "4.0.0.0"),
                temp,
                longInteger("ARCSUITE_MAX_CONTENT_BYTES", 50L * 1024 * 1024, 1, MAX_CONFIG_CONTENT_BYTES)
        );
    }

    private static String secret(String fileKey, String envKey) {
        String file = System.getenv(fileKey);
        if (file != null && !file.isBlank()) {
            try {
                String value = Files.readString(Path.of(file.trim()), StandardCharsets.UTF_8).stripTrailing();
                if (value.isEmpty()) throw new IllegalArgumentException(envKey + " file is empty");
                return value;
            } catch (IOException e) {
                throw new IllegalArgumentException("Cannot read " + fileKey, e);
            }
        }
        return required(envKey);
    }

    private static String required(String key) {
        String value = System.getenv(key);
        if (value == null || value.isBlank()) throw new IllegalArgumentException(key + " is required");
        return value.trim();
    }

    private static String env(String key, String fallback) {
        String value = System.getenv(key);
        return value == null || value.isBlank() ? fallback : value.trim();
    }

    private static int integer(String key, int fallback, int min, int max) {
        String value = System.getenv(key);
        int parsed = value == null || value.isBlank() ? fallback : Integer.parseInt(value);
        if (parsed < min || parsed > max) throw new IllegalArgumentException(key + " out of range");
        return parsed;
    }

    private static long longInteger(String key, long fallback, long min, long max) {
        String value = System.getenv(key);
        long parsed = value == null || value.isBlank() ? fallback : Long.parseLong(value);
        if (parsed < min || parsed > max) throw new IllegalArgumentException(key + " out of range");
        return parsed;
    }
}
