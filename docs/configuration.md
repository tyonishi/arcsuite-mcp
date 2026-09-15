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
| `MCP_CURSOR_HMAC_SECRET_FILE` | none | Non-empty HMAC key file for read and paging cursors; required in production |
| `MCP_CURSOR_HMAC_SECRET` | none | Controlled non-production fallback for cursor HMAC; ignored in production |
| `MCP_VALIDATE_ON_STARTUP` | `true` | Validate adapter health and configured schema before readiness |
| `MCP_ALLOWED_HOSTNAMES` | `localhost,127.0.0.1` | Host/DNS-rebinding allowlist |
| `MCP_ALLOWED_ORIGIN_HOSTNAMES` | `localhost,127.0.0.1` | Browser Origin allowlist |
| `MCP_SEARCH_DEFAULT_LIMIT` | `20` | Default search/list page size |
| `MCP_SEARCH_MAX_LIMIT` | `50` | Hard search/list page-size limit |
| `MCP_HARD_REFERENCE_MAX_CANDIDATES` | `min(200, snapshot cap)` | Maximum incoming Hard Reference candidates collected before authorization and paging; hard maximum `1000` |
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
| `MCP_PAGING_SNAPSHOT_MAX_IDS` | `1000` | Maximum IDs retained in one search, folder, or Hard Reference snapshot |
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
limits. In production, `MCP_CURSOR_HMAC_SECRET_FILE` must point to a non-empty
secret; the inline cursor secret is ignored. The gateway-to-adapter token is
read from `ARCSUITE_ADAPTER_INTERNAL_TOKEN_FILE`; the environment-variable
fallback is intended only for controlled local development. The Java adapter
supports the same file-first behavior.

The current hard caps are 4 MiB for an MCP JSON request, 100 MiB for a
materialized content file, 1,000,000 extracted characters, 50,000 characters
per MCP read response, 50 search/list results per page, 1,000 Hard Reference
candidates, 100 batch IDs, 5,000
IDs in one paging snapshot, 1,000 paging snapshots, 100 paging snapshots per
client, 100,000 total cached paging IDs, 256 MiB extracted-content cache,
86,400 seconds for cursor/cache TTLs, 100,000 requests per minute, and a
1,000-token burst. These caps are repository safety bounds, not a substitute
for deployment resource limits. The Java adapter also caps internal JSON
requests at 2,000,000 bytes and the gateway caps a materialized adapter JSON
response at 8 MiB.

The authenticated MCP `tools/list` schemas expose the effective configured
limits for batch IDs, search/list/revision/Hard Reference page sizes, and read
characters. A request above one of those deployment limits is rejected by the
registered schema before tool dispatch; the runtime parsers enforce the same
limits as defense in depth.

## Scope registry

Use `config/scopes.example.yaml` as a template. A scope must have a stable
semantic name, configured cabinet mapping, default attributes, and any
semantic attributes that callers may filter. A real deployment must replace
`YOUR_*`/`SET_*` placeholders and pass adapter schema validation.

The registry may contain physical IDs because it is server-side operator
configuration, but it must never be sent to MCP callers or committed with real
environment values. v1.2 capability discovery exposes only safe semantic scope
metadata: scope ID/description, allowed object classes, semantic filter names,
types/operators, enum aliases, configured full-text modes, wildcard policy, and
whether a deep link is enabled. It also exposes configured semantic content-label
aliases, enabled semantic relationships, and enabled integrity capabilities;
physical content-label mappings are omitted.

### Incoming Hard References

Hard Reference discovery is opt-in for each scope. Existing version 1 scope
files remain valid; an omitted setting is disabled. Unknown relationship keys
and non-boolean values fail startup validation:

```yaml
relationships:
  hard_references: true
```

This setting exposes only the `hard_reference_incoming` semantic capability.
The token profile must also include `arcsuite_list_hard_references` in its
`allowedTools` list. See [MCP tools](tools.md#incoming-hard-reference-relationships)
for authorization, paging, and candidate-bound behavior.

### Document integrity

Integrity checks default off for existing and new scope files. A token profile
must allow `arcsuite_validate_document_integrity`, and the inferred scope must
also opt in. Unknown keys or non-boolean values are rejected, and evidence
cannot be enabled while validation is disabled:

```yaml
integrity:
  enabled: true
  allow_evidence: false
```

Set `allow_evidence: true` only when clients may request the already-calculated
evidence-availability summary. Evidence is separate from validation and does
not affect its status. The adapter discards raw exception details and
certificate attributes before returning data to the gateway. See
[Document integrity](tools.md#document-integrity) for output semantics and
authorization behavior.

### Content labels

`system:primary` is a reserved built-in alias and always maps internally to
`{ns: "rep", name: "system:primary"}`. It cannot be overridden. Custom labels
are optional and additive, and existing scope files without this block remain
valid:

```yaml
content_labels:
  preview:
    ns: "rep"
    name: "user:YOUR_PREVIEW_CONTENT_LABEL"
```

Aliases must match `[a-z][a-z0-9_]{0,63}`. The registry accepts at most 32
custom labels per scope and bounds namespace/name lengths, whitespace, control
characters, duplicate physical mappings, and reserved-alias redefinition.
The server does not make a startup call to prove that each configured label
exists. Before any content cache lookup or content dispatch, document or
revision membership is checked at runtime from the exact
`rep:system:contentlabellist` metadata together with current cabinet, root,
object-type, and effective-identity proof. The selected physical label is
never a public fallback value.

### Typed semantic filters

Semantic attributes may declare `string`, `integer`, `number`, `boolean`,
`date`, `datetime`, or `enum`. Operators are restricted to the v1.2 matrix
advertised by `arcsuite_describe_capabilities`; arbitrary ArcSuite operator
names are not accepted. The server checks each declaration against the
operator-returned `AttributeSchema` before using it.

```yaml
semantic_attributes:
  page_count:
    attr_id: {ns: "rep", name: "user:YOUR_PAGE_COUNT_ATTRIBUTE"}
    type: integer
    operators: [eq, gte, lte]
  approved:
    attr_id: {ns: "rep", name: "user:YOUR_APPROVED_ATTRIBUTE"}
    type: boolean
    operators: [eq]
  lifecycle:
    attr_id: {ns: "rep", name: "system:status"}
    type: enum
    operators: [eq]
    values:
      active: {ns: "rep", name: "ACTIVE"}
      retired: {ns: "rep", name: "RETIRED"}
```

For `I18N_STRING_TYPE` enums, `values` entries use `ns`/`name` and must be
present in the validated schema's `enumLabels`. For a string-valued enumerated
attribute (`STRING_TYPE` with `enumerated: true`), use a literal mapping such
as `active: {value: "ACTIVE"}`; it is sent as `StringValue`. The alias names,
not physical mappings, are returned to MCP clients. Duplicate aliases for the
same physical enum identity are rejected using the same canonical key for
I18n (`type + namespace + name`) and string (`type + exact literal`) mappings.
Unambiguous configured aliases are the only public enum/status values; raw
physical names and localized labels are omitted. Long integer requests must
be JavaScript safe integers; unsafe values fail closed.

Public `revision_number` inputs are positive `xsd:int` values from `1` through
`2147483647`, inclusive. The declarative schemas, actual MCP `tools/list`
schemas, runtime parser, and Java adapter use this same range; values above it
are rejected before provider dispatch.

### Full-text search modes

The optional scope block below is additive and defaults to `none` when omitted:

```yaml
search:
  full_text_modes: [none]
```

Only explicitly configured modes can be selected by a client. `stemming` and
`thesaurus` require operator/live-environment qualification and are never
auto-enabled from the WSDL. A non-`none` mode is rejected when no text query is
provided.

### Optional document deep link

A scope may include an operator-controlled ArcSuite UI URL template. HTTPS is
the default and does not require any additional setting:

```yaml
ui:
  document_url_template: "https://arcsuite.example.invalid/open?id={document_id}"
```

`{document_id}` is the legacy placeholder and is replaced with the complete
semantic MCP document ID, including its `rep:` prefix. The value is encoded as
one URL component before substitution. For ArcSuite UI routes that require the
native object ID, use `{arcsuite_object_id}` instead:

```yaml
ui:
  document_url_template: "https://arcsuite.example.invalid/ArcSuite/docspace/sdk/open.do?id={arcsuite_object_id}&enc=UTF-8"
```

For a trusted internal deployment whose UI is intentionally HTTP-only, HTTP
must be explicitly enabled for that scope:

```yaml
ui:
  allow_http: true
  document_url_template: "http://arcsuite-internal.example.invalid/ArcSuite/docspace/sdk/open.do?id={arcsuite_object_id}&enc=UTF-8"
```

`ui.allow_http` defaults to `false`; setting it to `true` permits HTTP only for
that scope's configured UI deep link. It is not a global transport switch and
does not affect the SOAP adapter endpoint. Do not reuse `ARCSUITE_ALLOW_HTTP`
for this setting. HTTP should be limited to a trusted internal deployment; this
option does not make HTTP secure.

The template is operator configuration, not a tool argument. It must:

- use an absolute HTTP or HTTPS URL;
- use HTTPS unless `ui.allow_http: true` is explicitly set;
- contain exactly one supported placeholder: either `{document_id}` or
  `{arcsuite_object_id}`, but not both or a duplicate;
- place the selected placeholder only in the URL path or query, never in the
  authority (hostname, username/password, or port);
- contain no username/password or URL fragment;
- keep the generated URL on the configured origin.

When enabled, normalized metadata may include `open_url`. The implementation
URL-encodes the selected object ID and never embeds ArcSuite credentials or
Session IDs. A native-ID template is omitted when the runtime ID is not a
valid `rep:`-prefixed semantic ID. The link is a navigation helper, not an
authorization decision, and configuring it does not bypass ArcSuite
authentication. MCP callers cannot override the template or its host. Keep
operator-private hosts and identifiers in ignored/private scope configuration;
do not place them in the public example or documentation.

## Paging snapshot cache

Search and folder paging use a process-local, bounded snapshot of ArcSuite
object IDs. The initial request uses ArcSuite ID-only list/search operations;
later pages use the stored ID snapshot rather than re-running the search.
Paging cursors are HMAC protected and bound to the client profile, semantic
scope, result kind, snapshot, page size, offset, and expiry.

`MCP_SEARCH_MAX_LIMIT` and `MCP_HARD_REFERENCE_MAX_CANDIDATES` must not exceed
`MCP_PAGING_SNAPSHOT_MAX_IDS`, so accepted page sizes and authorized candidate
snapshots fit the configured store. Hard Reference candidate collection also
has a repository hard maximum of 1,000. The MCP caller cannot change this
candidate limit; overflow fails the whole request without a partial result.

A paging snapshot contains IDs and small navigation context only, never
extracted document text or credentials. `snapshot_limited=true` means the
configured snapshot ID cap was reached; it is not permission to issue an
unbounded follow-up search.

## Extracted-content cache

v1.1 can reuse a short-lived process-local snapshot of normalized extracted
text. This avoids repeated ArcSuite downloads/extraction for content-info +
read or successive read chunks. Cache identity includes client profile, scope,
requested and effective document identity, cabinet/root authority context,
revision, semantic and physical content label, extraction variant, and content
hash.

The cache:

- is bounded by TTL, entry count, per-client count, and total UTF-8 bytes;
- is not persisted;
- is cleared on normal server shutdown on a best-effort basis;
- never changes ArcSuite authorization; every cached lookup is preceded by
  current profile/scope/cabinet/root/type/revision/content-label proof and an
  exact comparison with the snapshot authority binding;
- never writes extracted content to the audit log.

## Token profiles

Each profile contains a SHA-256 bearer token hash, a client profile ID,
allowed scope names, allowed tool names, and a rate limit. Keep token JSON
outside version control. A profile is not an ArcSuite user identity; user-aware
ArcSuite reads are a future roadmap item.

Earlier v1.1 profiles remain valid and simply do not see additive tools until
the operator permits them. The v1.2 Hard Reference and document-integrity tools
are:

- `arcsuite_list_hard_references`
- `arcsuite_validate_document_integrity`

Both the profile's `allowedTools` and each tool's target-scope opt-in are
required. Hard References use `relationships.hard_references: true`; integrity
validation uses `integrity.enabled: true`, with `integrity.allow_evidence: true`
required when evidence is requested.

## Secret handling

Prefer secret files or a secret manager. Do not log environment values. The
Java adapter reads its password file, performs the ArcSuite challenge/public-key
login flow, and keeps the resulting Session ID internal to the adapter.
The environment-variable fallbacks are for controlled local development only;
production deployments should use `*_FILE` variables or the container
platform's secret manager. The Podman template documents the required secret
names and mounts.
