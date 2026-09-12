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

Real ArcSuite and client qualification remain environment-dependent; see
`docs/compatibility.md`.
