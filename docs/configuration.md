# Configuration

Configuration is split between environment/secret files and the semantic
scope registry. Tool callers cannot override these values.

## Important environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `ARCSUITE_ADAPTER_MODE` | `http` | `mock` for synthetic local tests, `http` for the private adapter |
| `ARCSUITE_MCP_BIND_HOST` | `127.0.0.1` | Listener address; use a controlled container address only behind a boundary |
| `ARCSUITE_MCP_PORT` | `8080` | MCP HTTP port |
| `ARCSUITE_ADAPTER_BASE_URL` | `http://127.0.0.1:18080` | Private adapter URL; never an MCP argument |
| `ARCSUITE_ADAPTER_INTERNAL_TOKEN_FILE` | none | Secret for gateway-to-adapter HTTP |
| `ARCSUITE_ADAPTER_INTERNAL_TOKEN` | none | Controlled local-development fallback for the adapter token |
| `MCP_SCOPES_FILE` | mode-dependent | YAML semantic scope registry |
| `ARCSUITE_MCP_CLIENT_TOKENS_JSON_FILE` | none | Hashed bearer-token profiles |
| `MCP_DEV_BEARER_TOKEN` | none | Development-only single profile |
| `MCP_CURSOR_HMAC_SECRET_FILE` | none | HMAC key for read cursors; required in production |
| `MCP_CURSOR_HMAC_SECRET` | none | Controlled local-development fallback for cursor HMAC |
| `MCP_VALIDATE_ON_STARTUP` | `true` | Validate adapter health and configured schema before readiness |
| `MCP_ALLOWED_HOSTNAMES` | `localhost,127.0.0.1` | Host/DNS-rebinding allowlist |
| `MCP_ALLOWED_ORIGIN_HOSTNAMES` | `localhost,127.0.0.1` | Browser Origin allowlist |
| `MCP_SEARCH_DEFAULT_LIMIT` | `20` | Default search/list result count |
| `MCP_SEARCH_MAX_LIMIT` | `50` | Hard search/list limit |
| `MCP_MAX_REQUEST_BYTES` | `1048576` | Maximum JSON MCP request body |
| `MCP_READ_DEFAULT_MAX_CHARS` | `20000` | Default extracted text chunk |
| `MCP_READ_MAX_CHARS` | `50000` | Hard per-response text limit |
| `MCP_MAX_CONTENT_BYTES` | `52428800` | Maximum adapter content file size |
| `MCP_MAX_EXTRACTED_CHARS` | `200000` | Maximum extractor output retained for cursoring |
| `MCP_SHARED_TEMP_DIR` | `/tmp/arcsuite-mcp-shared` | Private adapter/content exchange directory |
| `MCP_AUDIT_LOG_PATH` | `/tmp/arcsuite-mcp-audit.jsonl` | Metadata-only audit log |
| `MCP_CURSOR_TTL_SECONDS` | `600` | Signed cursor validity period |
| `ARCSUITE_MAX_CONTENT_BYTES` | `52428800` | Java adapter response/content bound |
| `ARCSUITE_SOAP_ENDPOINT` | none | Java adapter ArcSuite SOAP endpoint; operator configuration only |
| `ARCSUITE_USERNAME` | none | Java adapter ArcSuite service account; operator configuration only |
| `ARCSUITE_PASSWORD_FILE` | none | File containing the Java adapter ArcSuite password |
| `ARCSUITE_ALLOW_HTTP` | `false` | Explicitly allow a non-TLS SOAP endpoint for controlled local testing |
| `ARCSUITE_ADAPTER_BIND_HOST` | `127.0.0.1` | Java adapter listener; container example overrides to `0.0.0.0` on a private network |
| `ARCSUITE_ADAPTER_PORT` | `18080` | Java adapter internal listener port |
| `ARCSUITE_CONNECT_TIMEOUT_MS` | `30000` | Java adapter ArcSuite connection timeout |
| `ARCSUITE_REQUEST_TIMEOUT_MS` | `600000` | Java adapter ArcSuite request timeout |
| `ARCSUITE_SESSION_IDLE_TTL_SECONDS` | `1500` | Java adapter session idle lifetime |
| `ARCSUITE_SESSION_MAX_AGE_SECONDS` | `1700` | Java adapter session maximum lifetime |
| `ARCSUITE_PER_SESSION_CONCURRENCY` | `4` | Java adapter per-profile session concurrency |
| `ARCSUITE_LOCALE` | `ja` | ArcSuite request locale |
| `ARCSUITE_REQUEST_VERSION` | `4.0.0.0` | ArcSuite request version fallback |
| `MCP_TEMP_DIR` | `/tmp/arcsuite-mcp` | Java adapter mode-700 temporary directory |

Numeric values are validated as positive integers and bounded by repository
hard limits. Default limits cannot be larger than their corresponding hard
limits. The gateway-to-adapter token is read from
`ARCSUITE_ADAPTER_INTERNAL_TOKEN_FILE`; the environment-variable fallback is
intended only for controlled local development. The Java adapter supports the
same file-first behavior.

The current hard caps are 4 MiB for an MCP JSON request, 100 MiB for a
materialized content file, 1,000,000 extracted characters, 50,000 characters
per MCP read response, 50 search/list results, 86,400 seconds for cursor
validity, 100,000 requests per minute, and a 1,000-token burst. These caps are
repository safety bounds, not a substitute for deployment resource limits. The
Java adapter also caps internal JSON requests at 2,000,000 bytes and the
gateway caps a materialized adapter JSON response at 8 MiB.

## Scope registry

Use `config/scopes.example.yaml` as a template. A scope must have a stable
semantic name, configured cabinet mapping, default attributes, and any
semantic attributes that callers may filter. A real deployment must replace
`YOUR_*`/`SET_*` placeholders and pass adapter schema validation.

The registry may contain physical IDs because it is server-side operator
configuration, but it must never be sent to MCP callers or committed with
real environment values.

## Token profiles

Each profile contains a SHA-256 bearer token hash, a client profile ID,
allowed scope names, allowed tool names, and a rate limit. Keep token JSON
outside version control. A profile is not an ArcSuite user identity; user-aware
ArcSuite reads are a future roadmap item.

## Secret handling

Prefer secret files or a secret manager. Do not log environment values. The
Java adapter reads its password file, performs the ArcSuite challenge/public-key
login flow, and keeps the resulting Session ID internal to the adapter.
The environment-variable fallbacks are for controlled local development only;
production deployments should use `*_FILE` variables or the container
platform's secret manager. The Podman template documents the required secret
names and mounts.
