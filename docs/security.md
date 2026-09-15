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
- Hard Reference relationship records are admitted only with the native
  `rep/system:hardReference` class; this operation-specific check is separate
  from the ordinary document-scope object-type allowlist.
- Semantic enum values and top-level status never fall back to ArcSuite
  physical names or localized labels. Configured Attribute IDs are looked up
  by exact namespace and name, and duplicate physical enum mappings are
  rejected during scope loading.
- Incoming Hard Reference candidates are bounded before hydration, and only
  cabinet/root/type-authorized IDs enter a paging snapshot. Hard Reference
  reads keep reference resolution disabled; physical relationship IDs, raw
  reference identity, and edition data are excluded from MCP output and audit
  metadata.
- Document-integrity validation requires both profile permission and an
  integrity-enabled semantic scope. The gateway proves target cabinet, root,
  identity, and document type before dispatch. Evidence has a separate scope
  opt-in; the Java adapter discards raw validation exceptions and certificate
  attributes, and evidence cannot change validation status.
- The TypeScript and Java layers enforce a read-only SOAP operation allowlist.
- ArcSuite challenge/password credentials use the server public key with RSA
  PKCS#1 v1.5 padding (`RSA/ECB/PKCS1Padding`) over UTF-8
  (`challenge + password`); the resulting wire behavior remains subject to
  live ArcSuite qualification.
- CodeQL's `java/rsa-without-oaep` finding corresponds to a vendor-required
  compatibility path. Replacing PKCS#1 v1.5 with OAEP would change the
  licensed ArcSuite login wire contract. The gateway never exposes the
  challenge, ciphertext, or credentials through MCP; the Java adapter keeps
  the operation internal, and live qualification must still check for any
  observable padding-oracle behavior. Individual CodeQL alert disposition is
  tracked separately from this compatibility requirement.
- Administrator mode is fixed false; privileged-print, ACL, delete, workflow,
  delegation, and arbitrary SOAP operations are absent.
- Content is size-bounded, character-bounded, extracted by allowlisted
  handlers, and deleted from the shared directory in all normal paths. Content
  caches and cursors are optimizations/integrity tokens, not authority: each
  content-info call, initial read, and continuation revalidates current
  requested/effective identity, cabinet/root/type, revision, and exact label
  membership before reuse.
- XML DTD/external entities, unsafe archive paths, suspicious compression, and
  macro/embedded-object execution are rejected or never attempted. The shared
  OOXML helper rejects DTD and entity declarations in an encoding-aware parser
  before expansion. XML entity decoding leaves ampersands until the final
  pass, preventing nested entities from being decoded twice.
- Audit records contain request metadata only. Query and extracted content are
  excluded from audit output.
- GitHub Actions workflow references and container base images are pinned to
  reviewed immutable commit/digest references. Container updates must keep the
  human-readable tag and SHA-256 digest synchronized.

## Resource-bound content handling

Every content path has a finite limit before data is exposed to the semantic
layer. The configured values may be lowered per deployment, but cannot exceed
the hard bounds enforced by configuration and the relevant parser.

| Boundary | Enforced bound | Failure behavior |
| --- | --- | --- |
| MCP request body | 4 MiB hard maximum | Reject before JSON materialization |
| Adapter JSON response | 8 MiB hard maximum | Reject while streaming the response |
| Content file | 100 MiB hard maximum | Reject before extraction and remove the temporary file |
| Extracted text | 1,000,000 characters hard maximum | Truncate with a warning or reject parser output |
| JSON formatting | 256 nesting levels plus output budget | Stop with a bounded result and warning |
| OOXML archive | 20,000 members, 128 MiB total uncompressed, 200:1 compression-ratio guard | Reject the archive or member before extraction |
| OOXML XML | 256 nesting levels, input-sized node/text budgets, and DTD/entity rejection | Reject the XML before entity expansion |
| Content snapshot cache | 1,000 entries, 100 per client, and 256 MiB | Evict bounded entries or reject insertion |

The same output budget is applied again by the gateway normalizer, so a
bounded parser cannot be followed by an unbounded materialization step.
Limits are defensive resource controls, not a qualification of a licensed
ArcSuite deployment or of provider-specific content semantics.

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

The Java adapter's `SessionManager` owns the read retry and permits one session
refresh, for at most two business SOAP attempts. The TypeScript gateway sends
each adapter read once and does not replay it. A future mutation must not use
this retry behavior: business mutation retry is zero.

## Operator responsibilities

Operators must protect bearer tokens, Java secret files, cursor HMAC keys,
adapter network access, audit files, and the licensed ArcSuite endpoint. They
must review scope mappings, TLS, reverse-proxy behavior, container network
allowlists, log retention, and real-client qualification.
