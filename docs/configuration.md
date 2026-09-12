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
| `MCP_CURSOR_HMAC_SECRET_FILE` | none | HMAC key for read and paging cursors; required in production |
| `MCP_CURSOR_HMAC_SECRET` | none | Controlled local-development fallback for cursor HMAC |
| `MCP_VALIDATE_ON_STARTUP` | `true` | Validate adapter health and configured schema before readiness |
| `MCP_ALLOWED_HOSTNAMES` | `localhost,127.0.0.1` | Host/DNS-rebinding allowlist |
| `MCP_ALLOWED_ORIGIN_HOSTNAMES` | `localhost,127.0.0.1` | Browser Origin allowlist |
| `MCP_SEARCH_DEFAULT_LIMIT` | `20` | Default search/list page size |
| `MCP_SEARCH_MAX_LIMIT` | `50` | Hard search/list page-size limit |
| `MCP_BATCH_MAX_IDS` | `50` | Maximum IDs accepted by `arcsuite_get_documents` |
| `MCP_MAX_REQUEST_BYTES` | `1048576` | Maximum JSON MCP request body |
| `MCP_READ_DEFAULT_MAX_CHARS` | `20000` | Default extracted text chunk |
| `MCP_READ_MAX_CHARS` | `50000` | Hard per-response text limit |
| `MCP_MAX_CONTENT_BYTES` | `52428800` | Maximum adapter content file size |
| `MCP_MAX_EXTRACTED_CHARS` | `200000` | Maximum extractor output retained for cursoring/cache |
| `MCP_SHARED_TEMP_DIR` | `/tmp/arcsuite-mcp-shared` | Private adapter/content exchange directory |
| `MCP_AUDIT_LOG_PATH` | `/tmp/arcsuite-mcp-audit.jsonl` | Metadata-only audit log |
| `MCP_CURSOR_TTL_SECONDS` | `600` | Signed content cursor validity period |
| `MCP_PAGING_TTL_SECONDS` | `600` | Paging snapshot/cursor lifetime |
| `MCP_PAGING_SNAPSHOT_MAX_IDS` | `1000` | Maximum IDs retained in one search/folder snapshot |
| `MCP_PAGING_MAX_SNAPSHOTS` | `100` | Maximum in-memory paging snapshots |
| `MCP_PAGING_MAX_SNAPSHOTS_PER_CLIENT` | `10` | Maximum paging snapshots for one client profile |
| `MCP_PAGING_MAX_TOTAL_IDS` | `10000` | Global ID budget across paging snapshots |
| `MCP_CONTENT_CACHE_TTL_SECONDS` | `600` | Extracted-content snapshot lifetime |
| `MCP_CONTENT_CACHE_MAX_ENTRIES` | `64` | Global extracted-content entry limit |
| `MCP_CONTENT_CACHE_MAX_ENTRIES_PER_CLIENT` | `16` | Extracted-content entries per client profile |
| `MCP_CONTENT_CACHE_MAX_BYTES` | `16777216` | Global normalized-text cache byte budget |
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
per MCP read response, 50 search/list results per page, 100 batch IDs, 5,000
IDs in one paging snapshot, 1,000 paging snapshots, 100 paging snapshots per
client, 100,000 total cached paging IDs, 256 MiB extracted-content cache,
86,400 seconds for cursor/cache TTLs, 100,000 requests per minute, and a
1,000-token burst. These caps are repository safety bounds, not a substitute
for deployment resource limits. The Java adapter also caps internal JSON
requests at 2,000,000 bytes and the gateway caps a materialized adapter JSON
response at 8 MiB.

## Scope registry

Use `config/scopes.example.yaml` as a template. A scope must have a stable
semantic name, configured cabinet mapping, default attributes, and any
semantic attributes that callers may filter. A real deployment must replace
`YOUR_*`/`SET_*` placeholders and pass adapter schema validation.

The registry may contain physical IDs because it is server-side operator
configuration, but it must never be sent to MCP callers or committed with real
environment values. v1.1 capability discovery exposes only safe semantic scope
metadata: scope ID/description, allowed object classes, semantic filter names,
semantic types/operators, wildcard policy, and whether a deep link is enabled.

### Optional document deep link

A scope may include a trusted ArcSuite UI URL template:

```yaml
ui:
  document_url_template: "https://arcsuite.example.invalid/open?id={document_id}"
```

The template is operator configuration, not a tool argument. It must:

- use absolute HTTPS;
- contain exactly one `{document_id}` placeholder;
- contain no username/password or URL fragment;
- keep the generated URL on the configured origin.

When enabled, normalized metadata may include `open_url`. The implementation
URL-encodes the object ID and never embeds ArcSuite credentials or Session IDs.

## Paging snapshot cache

Search and folder paging use a process-local, bounded snapshot of ArcSuite
object IDs. The initial request uses ArcSuite ID-only list/search operations;
later pages use the stored ID snapshot rather than re-running the search.
Paging cursors are HMAC protected and bound to the client profile, semantic
scope, result kind, snapshot, page size, offset, and expiry.

A paging snapshot contains IDs and small navigation context only, never
extracted document text or credentials. `snapshot_limited=true` means the
configured snapshot ID cap was reached; it is not permission to issue an
unbounded follow-up search.

## Extracted-content cache

v1.1 can reuse a short-lived process-local snapshot of normalized extracted
text. This avoids repeated ArcSuite downloads/extraction for content-info +
read or successive read chunks. Cache identity includes client profile, scope,
document, revision, content label, extraction variant, and content hash.

The cache:

- is bounded by TTL, entry count, per-client count, and total UTF-8 bytes;
- is not persisted;
- is cleared on normal server shutdown on a best-effort basis;
- never changes ArcSuite authorization; every cached lookup is profile/scope
  bound;
- never writes extracted content to the audit log.

## Token profiles

Each profile contains a SHA-256 bearer token hash, a client profile ID,
allowed scope names, allowed tool names, and a rate limit. Keep token JSON
outside version control. A profile is not an ArcSuite user identity; user-aware
ArcSuite reads are a future roadmap item.

v1.1 introduces two additional generic read tools that operators can add to an
allowed tool list:

- `arcsuite_describe_capabilities`
- `arcsuite_get_documents`

Existing v1.0 profiles remain valid and simply do not see these tools until the
operator permits them.

## Secret handling

Prefer secret files or a secret manager. Do not log environment values. The
Java adapter reads its password file, performs the ArcSuite challenge/public-key
login flow, and keeps the resulting Session ID internal to the adapter.
The environment-variable fallbacks are for controlled local development only;
production deployments should use `*_FILE` variables or the container
platform's secret manager. The Podman template documents the required secret
names and mounts.
