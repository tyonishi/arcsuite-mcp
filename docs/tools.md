# MCP tools

All tools are read-only. `scope` names and semantic filter names come from the
server-side scope registry. Physical cabinet IDs, Attribute IDs, SOAP
operations, endpoints, credentials, and Session IDs are not tool inputs.

| Tool | Required input | Result |
| --- | --- | --- |
| `arcsuite_search_documents` | `scope` plus `query` or configured `filters` | Bounded semantic document results; optional paths |
| `arcsuite_get_document` | `document_id` | Metadata, status, revisions, content labels, optional path |
| `arcsuite_list_folder` | `scope` | Bounded child document/folder results; optional proven folder ID |
| `arcsuite_list_document_revisions` | `document_id` | Revision metadata |
| `arcsuite_get_document_content_info` | `document_id` | File name/type/size/extractor support; never binary |
| `arcsuite_read_document` | `document_id` | Bounded extracted text and optional signed cursor |

## Search example

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

`document_number` and other semantic names are examples only. An operator
must configure and validate the corresponding ArcSuite schema first.

## Read example

```json
{
  "document_id": "rep:mock:EXAMPLE_CABINET:1001",
  "max_chars": 20000
}
```

When `truncated` is true, send `next_cursor` back as `cursor` without also
sending `start_page`. Cursors are signed, expire, and are bound to document,
revision, extracted content, and extractor.

## Stable error behavior

Tool errors use stable codes such as `ARCSUITE_INVALID_ARGUMENT`,
`ARCSUITE_FORBIDDEN`, `UNSUPPORTED_CONTENT_TYPE`,
`ARCSUITE_LIMIT_EXCEEDED`, `ARCSUITE_SESSION_EXPIRED`, and
`ARCSUITE_UPSTREAM_ERROR`. Responses intentionally omit raw SOAP faults,
credentials, session IDs, binary data, and extracted content from audit logs.
