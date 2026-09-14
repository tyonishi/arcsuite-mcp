# ADR 0005: v1.1 Read UX and Efficiency

- Status: accepted
- Date: 2026-09-13

## Context

v1.0 establishes the semantic read-only boundary defined by ADR 0001 and the
bounded content boundary defined by ADR 0004. The current server can search,
read metadata, list folders and revisions, and extract bounded document text,
but several user-experience gaps remain:

- clients cannot reliably discover the scopes and semantic filters available to
  their policy profile from the generic tool schema alone;
- bounded search and folder results can report truncation but cannot retrieve a
  stable next page;
- callers that need metadata for several search results must perform repeated
  single-document calls;
- reading successive chunks can repeat ArcSuite content retrieval and text
  extraction;
- operators have no generic way to attach a safe ArcSuite UI deep link to a
  result.

These gaps can be addressed without widening the authorization or mutation
boundary.

## Decision

v1.1 is the **Read UX and Efficiency** release. It SHALL improve discovery,
paging, batch reads, content reuse, and optional deep-link navigation while
preserving the v1.0 read-only security contract.

### Included capabilities

1. **Profile-aware scope and filter discovery**
   - `tools/list` SHALL be derived from the authenticated client profile and
     the server-side semantic scope registry.
   - Published tool schemas and descriptions SHOULD enumerate the scopes and
     semantic filters available to that profile where the MCP SDK permits it.
   - A read-only capability-description tool MAY be provided as a compatibility
     fallback for clients that do not surface rich tool schema metadata.
   - Physical cabinet IDs and ArcSuite Attribute IDs remain server-side only.

2. **Stable search and folder paging**
   - `arcsuite_search_documents` and `arcsuite_list_folder` SHALL support an
     opaque continuation cursor.
   - The server SHOULD build the result snapshot from ArcSuite ID-only
     list/search operations and cache only the bounded ID set needed for later
     pages.
   - Default page size remains conservative; page size MUST remain bounded.
   - Snapshot size, TTL, per-client cache use, and total cache memory MUST be
     bounded by configuration.
   - A cursor MUST be integrity-protected, expire, and be bound to the client
     profile, scope, query snapshot, and paging position.

3. **Batch metadata reads**
   - Add a semantic `arcsuite_get_documents` capability backed by ArcSuite's
     multi-object read operation.
   - Batch size MUST be bounded.
   - Every requested and returned object MUST be proven inside the selected
     allowed scope before returning data.
   - Partial upstream failures MUST be represented explicitly rather than
     silently dropped.

4. **Extracted-content snapshot cache**
   - Successive bounded reads of the same document revision SHOULD reuse a
     short-lived normalized-text snapshot rather than repeatedly downloading
     and extracting the same content.
   - Cache identity MUST include client profile, semantic scope, document ID,
     revision identity, extractor identity, and content hash.
   - Cache bytes, entry count, entry lifetime, and per-client use MUST be
     bounded.
   - Cached content MUST NOT be written to audit logs and MUST be deleted on
     expiry and best-effort shutdown cleanup.

5. **Content-info/read reuse**
   - When content metadata inspection already materialized safe content, a
     following read MAY reuse the same bounded private cache entry instead of
     causing a duplicate ArcSuite download.
   - Reuse MUST never cross client-profile or scope boundaries.

6. **Optional ArcSuite UI deep links**
   - A scope MAY define an operator-controlled document URL template.
   - A result MAY expose `open_url` only when the template is enabled and the
     target host/scheme is fixed by trusted server configuration.
   - Tool callers MUST NOT provide arbitrary URL templates, hosts, or query
     credentials.
   - Authentication secrets and ArcSuite session identifiers MUST never be
     embedded in generated links.

### ArcSuite operation additions

The read-only operation allowlist MAY be extended with the ID-only repository
list/search operations needed for bounded paging. Any addition must be made in
all enforcement layers together: TypeScript allowlist, adapter dispatch,
Java-side allowlist, tests, and public documentation.

## Security invariants

v1.1 does not change ADR 0001's semantic read-only boundary.

In particular, v1.1 SHALL NOT add:

- administrator mode or privilege assertion;
- ACL mutation, delete, state-changing workflow operations, or any other
  mutation;
- arbitrary SOAP operation dispatch;
- caller-supplied ArcSuite endpoints, cabinets, physical Attribute IDs, or
  credentials;
- ordinary MCP tool responses containing raw binary/base64 document data.

Paging and content caches are performance features, not new authorities. A
content cache hit or cursor continuation MUST first reauthorize the current
requested/effective repository identity with the same client profile, semantic
scope, cabinet/root/object-type, revision, and exact content-label membership
that applies to the current request. A signed cursor proves integrity, not
current authorization.

## Compatibility impact

The existing six v1.0 tools remain valid. New cursor fields and new read-only
tools are additive. Existing clients that do not use v1.1 features should
continue to work unchanged.

## Implementation consequences

- Extend the semantic tool registry to build profile-aware schemas.
- Add a bounded server-side paging snapshot store and signed paging cursor.
- Add batch metadata adapter support using the existing multi-object SOAP
  operation already allowed by the v1.0 boundary.
- Add an extracted-text snapshot cache shared by content-info and read paths.
- Extend scope configuration with optional trusted deep-link metadata.
- Add unit/integration/security tests for profile isolation, cursor tampering,
  cache expiry, batch partial failure, and deep-link host confinement.

## Acceptance boundary

v1.1 is complete when all included capabilities are covered by synthetic
integration tests, security invariants remain mechanically enforced, and the
existing v1.0 tool behavior remains backward compatible. Live ArcSuite
qualification remains an operator-owned environment test and is not implied by
repository CI.

## Related decisions

- ADR 0001: Semantic read-only MCP boundary
- ADR 0002: No generic SOAP proxy
- ADR 0004: Content extraction boundary
- ADR 0006: v1.2 Rich Repository Read
