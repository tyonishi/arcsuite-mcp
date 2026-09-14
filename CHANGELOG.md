# Changelog

## 0.1.0 - unreleased

- Initial public-ready tree for ArcSuite MCP Server.
- Added generic semantic R1 Core Read and R2 Content Read tools.
- Added the current TypeScript MCP SDK Streamable HTTP handler with a
  stateless legacy compatibility path.
- Added the Java 17+ ArcSuite SOAP/MTOM adapter boundary, security invariants,
  content bounds, cursor support, tests, and public-hygiene automation.
- Hardened the pre-push boundary with bounded MCP/adapter bodies, bounded Java
  SOAP/MTOM reads, redirect rejection, strict profile limits, and enforced
  semantic object-type and returned-object scope policy.
- Fixed the container adapter bind address and documented operator-owned secret
  setup for the two-service Podman example.
- Unified the Podman example on the `mcp_tokens` secret and aligned its audit
  log volume with the non-root container log directory.
- Isolated the Java container build context from vendor/secrets/document data,
  made the Podman template executable, and pinned container base images by
  SHA-256 digest.
- Pinned GitHub Actions workflow references to immutable commit SHAs and added
  an invariant check to prevent tag-based regressions.
- Defined the accepted v1.x capability roadmap in ADR 0005 through ADR 0007:
  v1.1 Read UX and Efficiency, v1.2 Rich Repository Read, and v1.3 Advanced
  Content and Scope. These roadmap releases preserve the read-only semantic
  security boundary.
- Implemented ADR 0005 v1.1 Read UX and Efficiency: profile-aware semantic
  capability discovery, bounded ID-snapshot paging for search/folder results,
  bounded batch metadata reads, short-lived extracted-content snapshot reuse,
  content-info/read reuse, and optional trusted ArcSuite UI deep links.
- Implemented the v1.2 S1 Typed Search Foundation: schema-validated string,
  integer, number, boolean, date, datetime, and enum predicates; safe enum
  alias mapping; expanded AttributeSchema metadata; and explicitly configured
  `none`/`stemming`/`thesaurus` full-text modes. This slice adds no SOAP
  operations and preserves the v1.0/v1.1 read-only boundary.
- Implemented the v1.2 S2 Content Labels slice: additive per-scope semantic
  content-label aliases, exact document/revision membership proof, returned
  label identity checks, namespace-safe extracted-content caches, and signed
  cursors bound to semantic labels. S2 adds no SOAP operation; S4 integrity
  validation remains a separate v1.2 slice.
- Implemented v1.2 S3 Hard References: per-scope opt-in incoming relationship
  discovery, bounded candidate collection, cabinet/root/object-type filtering
  before target-bound paging, resolveRef=false hydration, and public semantic
  results that omit private relationship IDs and reference identity data.
- Added one read-only ArcSuite operation for incoming Hard Reference discovery;
  TypeScript and Java operation allowlists remain in parity.
- Added the read-only ArcSuite `searchRepositoryObjectIds` and
  `listRepositoryObjectIds` operations to the mechanically checked allowlist;
  mutation/admin/ACL/delete/privileged-print exclusions remain unchanged.
- Corrected ArcSuite credential encryption to the documented RSA PKCS#1 v1.5
  wire contract; the corresponding `java/rsa-without-oaep` CodeQL findings
  remain visible as an intentional ArcSuite compatibility exception for
  security review.
- Remediated staged wildcard-regex unescaping and nested XML entity-decoding
  findings.

Real ArcSuite and client qualification remain environment-dependent; see
`docs/compatibility.md`.
