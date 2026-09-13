# MCP tools

All tools are read-only. `scope` names and semantic filter names come from the
server-side scope registry and are filtered by the authenticated client
profile. Physical cabinet IDs, Attribute IDs, SOAP operations, endpoints,
credentials, and Session IDs are not tool inputs.

v1.2 adds typed semantic predicates and explicitly configured full-text modes to
the v1.1 discovery, paging, batch metadata, extraction reuse, and UI deep-link
features. These features do not add new mutation authority.

| Tool | Required input | Result |
| --- | --- | --- |
| `arcsuite_describe_capabilities` | none | Safe profile-aware scope/filter/object-type discovery; never physical ArcSuite IDs |
| `arcsuite_search_documents` | `scope` plus `query` or configured `filters`; or `scope` + `cursor` | Bounded semantic document page, partial failures, and optional continuation cursor |
| `arcsuite_get_document` | `document_id` | Metadata, status, revisions, content labels, optional path and optional configured `open_url` |
| `arcsuite_get_documents` | `scope`, `document_ids` | Bounded batch metadata with explicit per-input failures |
| `arcsuite_list_folder` | `scope`; optional proven `folder_id`, or `scope` + `cursor` | Bounded child document/folder page and optional continuation cursor |
| `arcsuite_list_document_revisions` | `document_id` | Revision metadata |
| `arcsuite_get_document_content_info` | `document_id`; optional semantic `content_label` | File name/type/size/extractor support for one configured label; may warm a private short-lived extracted-content snapshot; never binary |
| `arcsuite_read_document` | `document_id`; optional semantic `content_label` | Bounded extracted text, cache indicator, and optional signed content cursor |

## Capability discovery

Use `arcsuite_describe_capabilities` when a client does not expose rich MCP
tool schema metadata. It returns only semantic information already allowed for
the authenticated profile:

```json
{
  "version": "1.2",
  "read_only": true,
  "allowed_tools": ["arcsuite_search_documents"],
  "scopes": [
    {
      "id": "example_documents",
      "description": "Example document repository",
      "object_types": ["document", "folder", "reference"],
      "filters": [
        {
          "name": "document_number",
          "type": "string",
          "operators": ["eq", "like"],
          "allow_wildcards": true,
          "max_length": 128
        }
      ],
      "full_text_modes": ["none"],
      "ui_deep_link": false,
      "content_labels": ["system:primary", "preview"]
    }
  ]
}
```

The response deliberately omits cabinet IDs, roots, service DNs, and physical
Attribute IDs.

## Search and result paging

Initial search example:

```json
{
  "scope": "example_documents",
  "filters": {
    "document_number": "DOC-000001",
    "name": "*.pdf"
  },
  "limit": 10,
  "include_path": true
}
```

`document_number` and other semantic names are examples only. An operator must
configure and validate the corresponding ArcSuite schema first.

### Typed predicates and full-text modes

Scalar filter values remain supported for v1.1-compatible equality and wildcard
search. v1.2 also accepts an explicit predicate. The semantic scope determines
the type and permitted operators; callers never provide physical Attribute IDs
or ArcSuite operator names.

```json
{
  "scope": "example_documents",
  "query": "annual report",
  "text_search_mode": "stemming",
  "filters": {
    "document_number": "DOC-*",
    "page_count": {"operator": "gte", "value": 10},
    "approved": true,
    "published_on": {"operator": "gte", "value": "2026-01-01"}
  }
}
```

The v1.2 operator matrix is deliberately limited: strings use `eq`/`like`,
integers and numbers use `eq`/`gte`/`lte`, booleans use `eq`, dates and
date-times use `eq`/`gte`/`lte`, and enums use `eq`. Explicit date-times must be
unambiguous RFC3339 values. Legacy scalar date-time forms remain accepted where
the v1.1 configuration depended on them. Long integer inputs outside the
JavaScript safe-integer range are rejected without rounding.

`text_search_mode` defaults to `none`, and a non-`none` mode requires a text
query. `stemming` and `thesaurus` are available only when the selected scope
explicitly lists them in `search.full_text_modes`; the operator must qualify
those modes in the target environment.

Enum discovery returns only configured semantic aliases. For an
`I18N_STRING_TYPE` attribute, the server maps an alias to the configured
`ns`/`name` and checks it against `AttributeSchema.enumLabels`. For a
string-valued enumerated attribute, the mapping uses `{ "value": "..." }` and
is serialized as `StringValue`. A declared type that does not match the
validated schema fails startup or the request closed.

If `next_cursor` is non-null, continue the same result snapshot with only the
scope and cursor:

```json
{
  "scope": "example_documents",
  "cursor": "<opaque-signed-cursor>"
}
```

Do not repeat or alter query/filter/folder/page-size parameters on a
continuation request. Paging cursors are signed, expire, and are bound to the
client profile, semantic scope, result kind, snapshot, page size, and offset.
The server stores only a bounded ID snapshot. `snapshot_limited=true` means the
bounded snapshot itself hit its configured maximum; no additional pages beyond
that snapshot are promised.

## Batch metadata

Use `arcsuite_get_documents` when an agent needs metadata for several known
results without making one MCP call per object:

```json
{
  "scope": "example_documents",
  "document_ids": [
    "rep:example:EXAMPLE_CABINET:1001",
    "rep:example:EXAMPLE_CABINET:1002"
  ],
  "include_path": false
}
```

The server bounds the batch size, checks every requested ID against the selected
scope, validates every returned object, and returns upstream partial failures
with their original request index and document ID. Missing or inconsistent
batch coverage fails closed rather than silently dropping objects.

## Content labels and read reuse

`content_label` is a semantic alias. `system:primary` is always available and
is the default. Additional aliases are configured per scope, for example:

```yaml
content_labels:
  preview:
    ns: "rep"
    name: "user:YOUR_PREVIEW_CONTENT_LABEL"
```

The namespace/name pair is trusted server-side configuration, not an MCP input.
Discovery returns only aliases. Runtime scope resolution still rejects an
alias configured for another scope or an unknown alias. Before a cache miss can
fetch content, the target document or requested revision must advertise the
exact namespace and name in `rep:system:contentlabellist`. If the label is not
present, content-info returns `extractable: false` with
`reason: "CONTENT_LABEL_NOT_FOUND"`; a document read fails without dispatching
the content operation.

`arcsuite_get_document_content_info` may extract a supported selected label
into a short-lived in-memory normalized-text snapshot. A subsequent
`arcsuite_read_document` by the same client profile and semantic scope can
reuse that snapshot instead of downloading/extracting the document again.
Cache entries are bounded by TTL, total entries, per-client entries, and bytes.
They are never written to the audit log.

Read example:

```json
{
  "document_id": "rep:mock:EXAMPLE_CABINET:1001",
  "content_label": "preview",
  "max_chars": 20000
}
```

When a text read is truncated, send `next_cursor` back as `cursor` without
also sending page-selection fields. Content cursors are signed, expire, and are
bound to document, revision, extracted content, extractor, semantic
`content_label`, client profile, and scope. The page selection that produced
the snapshot is preserved across continuation reads. Omitting the label on a
continuation uses the signed cursor label; supplying a different label fails.
Valid short-lived v1.1 cursors without a label are interpreted as
`system:primary`.

The result field `cached` reports whether that specific read used an already
existing private extracted-content snapshot. It is informational only and does
not change authorization.

The stable invalid-argument category `content_label_not_allowed` is used for
unknown or scope-disallowed aliases. Physical namespace/name mappings never
appear in normal tool output or these errors.

## Optional ArcSuite UI deep links

An operator may configure a trusted HTTPS `document_url_template` in a scope.
When configured, document metadata can include `open_url`. The template must
contain exactly one `{document_id}` placeholder in the path or query, cannot
include credentials, and is validated server-side. MCP callers cannot supply
or override the host, template, or credentials. If an optional template is
invalid at decoration time, the server omits `open_url`.

## Stable error behavior

Tool errors use stable codes such as `ARCSUITE_INVALID_ARGUMENT`,
`ARCSUITE_FORBIDDEN`, `UNSUPPORTED_CONTENT_TYPE`,
`ARCSUITE_LIMIT_EXCEEDED`, `ARCSUITE_SESSION_EXPIRED`, and
`ARCSUITE_UPSTREAM_ERROR`. Responses intentionally omit raw SOAP faults,
credentials, session IDs, binary data, and extracted content from audit logs.
