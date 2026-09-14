# Security model

## Defense in depth

- Host and Origin allowlists protect plain Node HTTP against DNS rebinding and
  untrusted browser origins.
- Bearer tokens are compared by hash and timing-safe comparison. The token
  value is not placed in MCP results or audit records.
- Profiles limit scopes and tools and have a bounded token-bucket rate limit.
- MCP request bodies and adapter response bodies are bounded before the SDK or
  semantic layer materializes them; adapter redirects are rejected.
- Scope configuration proves cabinet/root membership and validates semantic
  attributes against adapter metadata when available.
- Scope `allowed_object_types` is enforced on every direct repository object
  returned by search, list, get, and revision operations. Returned object IDs
  and path IDs are checked against the selected cabinet, and configured root
  membership is revalidated before results are exposed.
- Incoming Hard Reference candidates are bounded before hydration, and only
  cabinet/root/type-authorized IDs enter a paging snapshot. Hard Reference
  reads keep reference resolution disabled; physical relationship IDs, raw
  reference identity, and edition data are excluded from MCP output and audit
  metadata.
- The TypeScript and Java layers enforce a read-only SOAP operation allowlist.
- ArcSuite challenge/password credentials use the server public key with RSA
  PKCS#1 v1.5 padding (`RSA/ECB/PKCS1Padding`) over UTF-8
  (`challenge + password`); the resulting wire behavior remains subject to
  live ArcSuite qualification.
- Administrator mode is fixed false; privileged-print, ACL, delete, workflow,
  delegation, and arbitrary SOAP operations are absent.
- Content is size-bounded, character-bounded, extracted by allowlisted
  handlers, and deleted from the shared directory in all normal paths.
- XML DTD/external entities, unsafe archive paths, suspicious compression, and
  macro/embedded-object execution are rejected or never attempted. XML entity
  decoding leaves ampersands until the final pass, preventing nested entities
  from being decoded twice.
- Audit records contain request metadata only. Query and extracted content are
  excluded from audit output.
- GitHub Actions workflow references and container base images are pinned to
  reviewed immutable commit/digest references. Container updates must keep the
  human-readable tag and SHA-256 digest synchronized.

## Repository security integrations

- GitHub CodeQL Default setup is the authority for repository code scanning.
  Its configuration and language coverage are managed in the repository's
  GitHub security settings; the repository does not rely on a checked-in
  custom CodeQL workflow.
- Dependency Review requires GitHub's dependency graph. It runs automatically
  for a public repository, or for a private repository with the repository
  variable `DEPENDENCY_REVIEW_ENABLED=true` after the dependency graph and
  applicable Advanced Security capability have been enabled. A skipped check
  means that the GitHub integration is unavailable; it is not a substitute for
  dependency review.
- Dependabot groups minor and patch updates by ecosystem. Major runtime,
  compiler, action, and container updates remain separate for compatibility
  and security review.

## Trust boundaries

The MCP caller is untrusted input. The TypeScript gateway is trusted to apply
semantic policy. The Java adapter is a separate private service with its own
internal bearer token. ArcSuite is an external enterprise service whose
permissions and schema are environment-specific.

The gateway's read retry is limited to one session refresh. A future mutation
must not reuse this retry behavior: business mutation retry is zero.

## Operator responsibilities

Operators must protect bearer tokens, Java secret files, cursor HMAC keys,
adapter network access, audit files, and the licensed ArcSuite endpoint. They
must review scope mappings, TLS, reverse-proxy behavior, container network
allowlists, log retention, and real-client qualification.
