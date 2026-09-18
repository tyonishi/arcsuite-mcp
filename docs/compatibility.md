# Compatibility

## MCP protocol and SDK

The primary endpoint is `/mcp` using the official MCP TypeScript SDK v2 and
the Node Streamable HTTP adapter. This tree was implemented against the
current official MCP specification revision `2026-07-28` and the matching
official SDK documentation available during the initial build.

References:

- [MCP specification](https://modelcontextprotocol.io/specification)
- [MCP SDK documentation](https://modelcontextprotocol.io/docs/sdk)
- [TypeScript SDK repository](https://github.com/modelcontextprotocol/typescript-sdk)

The server keeps the SDK's stateless 2025-era fallback enabled for clients
that still use the pre-envelope handshake. It is compatibility behavior, not
the core architecture. A client should use standards-based Streamable HTTP;
the older HTTP+SSE deployment style is not a separate core endpoint here.

The tested local request path uses protocol header `2025-03-26` and accepts
`application/json, text/event-stream`. Current clients should negotiate their
supported protocol era through the official SDK.

## Runtime matrix

| Component | Supported/tested baseline |
| --- | --- |
| Node.js | 22.6+; local validation used Node 24 |
| TypeScript MCP SDK | v2.0.0 package line |
| Java adapter | Java 17+; Java 21 is also suitable |
| Python helper | Python 3 |
| PDF extraction | Poppler `pdftotext` |
| ArcSuite | Licensed environment and version must be qualified by the operator |
| Dify | Integration example only; historical design target Dify 1.14.2 was not requalified in this sanitized tree |

## ArcSuite v1.1 operation requirements

v1.1 paging and batch metadata reads add three read-only ArcSuite operations to
the v1.0 baseline:

- `searchRepositoryObjectIds`
- `listRepositoryObjectIds`
- `getRepositoryObjects`

The operator must verify that the live ArcSuite WSDL exposes these operations
before qualifying v1.1 against a real server. The repository intentionally does
not redistribute a vendor WSDL, and documentation or sample WSDLs from another
ArcSuite installation are not runtime authority.

The adapter serializes the `getRepositoryObjects` `ids` parameter as the ArcSuite
`Ids` complex type (`<ids><id>...</id></ids>`). The Java adapter self-test
locks this request shape so it cannot silently regress to a generic string-array
wire representation.

The licensed WSDL defines the `searchRepositoryObjectIds` and
`listRepositoryObjectIds` Return values directly as `Ids`: zero or more direct
`id` children, with no `result` or nested `ids` wrapper. The adapter accepts
valid empty/single/multiple responses and rejects missing Return elements,
nested wrappers, malformed or duplicate IDs, and mixed valid/invalid results.
The revision list Return is directly `RepositoryObjects` with zero or more
direct `repositoryObject` children; malformed or missing responses fail as
upstream errors rather than becoming an empty history.

v1.1 batch metadata hydration deliberately sends `resolveRef=false` for
`getRepositoryObjects`. Paging snapshots are keyed by the exact IDs returned by
the ID-only operations, so reference resolution at this internal batch step
would change object identity and make page/accounting checks ambiguous. Existing
single-object and content paths continue to apply the configured reference
resolution policy where their contracts allow it.

The Java adapter encrypts the `getLoginInfo` challenge concatenated with the
configured password using RSA PKCS#1 v1.5 padding
(`RSA/ECB/PKCS1Padding`). The plaintext is the UTF-8 encoding of
`challenge + password`. This padding choice is part of the adapter's wire
behavior and must be qualified against the operator's licensed ArcSuite
version before deployment.

## ArcSuite v1.2 S1 typed search requirements

S1 adds no ArcSuite operation. It uses the existing repository search
operations with the following verified wire shapes: `AttributeValue` is
serialized as the concrete `StringValue`, `BooleanValue`, `IntValue`,
`LongValue`, `DoubleValue`, `DateValue`, `DateTimeValue`, or
`I18nStringValue` type; attribute conditions use `BinaryOperatorCondition`
with `ONEVAL`; and the search option carries `TextSearchMode`.

The semantic layer permits only its configured `eq`/`like`/`gte`/`lte` matrix.
`stemming` and `thesaurus` are never enabled from the WSDL alone. Enum aliases
are checked against the returned schema for `I18N_STRING_TYPE`; a
`STRING_TYPE` enumerated attribute is mapped to a `StringValue` literal and
must be operator-qualified against the target environment's actual enum
values. These checks are implementation and synthetic-contract qualified;
they are not a live ArcSuite qualification claim.

Configured semantic Attribute IDs are exact namespace/name pairs; the gateway
does not fall back from `user:state` to another namespace's `rep:state`.
Physical enum names and localized labels are not public semantic output. The
top-level `status` field is emitted only when one unambiguous configured
semantic enum maps the exact `rep:system:status` physical value; otherwise it
is omitted.

## Qualification limits

Local tests use a mock adapter and synthetic content. They verify protocol
shape, semantic policy, content bounds, and security invariants; they do not
prove compatibility with a live ArcSuite server, every vendor version, a
particular client UI, or a production network proxy.

## ArcSuite v1.2 S2 content-label requirements

S2 adds no SOAP operation. It uses the existing
`getRepositoryObjectContentWithOptions` request with one configured physical
`I18nString` in the `contentLabels` wrapper and server-controlled options only.
The WSDL contract used by the adapter is document/literal: each request label
is an `i18nString` with `ns` and `name` attributes, and the response
`Content.label` is the same `I18nString` shape. The Java self-test locks this
synthetic wire shape and exact returned-label comparison.

The gateway verifies `rep:system:contentlabellist` on the current object or the
requested revision before dispatching content. Reference resolution must prove
the same effective object used by the content request. Real label existence,
reference behavior, revision content, and MTOM behavior remain live-environment
qualification responsibilities for the operator.

Content-info, initial reads, and cursor continuations revalidate current
authority before consulting a private snapshot. A signed cursor proves token
integrity only; its opaque effective-identity binding must match the current
requested/effective object and configured cabinet/root context.

The WSDL declares revision numbers as `xsd:int`. The public semantic contract
accepts positive values `1..2147483647`, inclusive, and the MCP schemas,
runtime parser, Java serializer, and provider dispatch use that same range.

The WSDL's revision-get response uses the exact
`getRepositoryDocumentByRevisionNubmerReturn` element name. The adapter uses
that operation-specific Return and treats a missing or malformed object as an
upstream error; an ordinary ArcSuite SOAP not-available fault retains its
stable not-available classification. MTOM attachments are handled as bytes,
with only MIME framing CRLF removed at a boundary. The initial MIME boundary is
accepted at byte offset zero or with exactly one leading CRLF at byte offset two,
matching an ArcSuite response framing variant observed in a licensed environment.
LF-only prefixes, multiple leading CRLF pairs, and arbitrary preamble bytes remain
rejected. Synthetic Java tests cover both the accepted framing and these
fail-closed cases; the operator must still qualify the behavior against the
licensed ArcSuite version in use.

## ArcSuite v1.2 S3 incoming Hard References

S3 adds one bounded, single-hop incoming Hard Reference read. The operator must
enable `relationships.hard_references` per scope. The gateway authorizes the
target before lookup, proves candidate cabinet/root/object-type membership
before snapshot creation, and hydrates Hard Reference objects with reference
resolution disabled. The public result contains semantic metadata only; the
physical relationship object ID, raw reference identity, edition data, and
physical path IDs remain private.

The candidate collection is bounded by `MCP_HARD_REFERENCE_MAX_CANDIDATES`
(default 200 or the lower snapshot cap, repository maximum 1,000) and by
`MCP_PAGING_SNAPSHOT_MAX_IDS`. Since the licensed operation has no result-limit
parameter, an upstream candidate set beyond the configured bound fails closed
with `ARCSUITE_LIMIT_EXCEEDED`. Synthetic tests qualify request/response
parsing, identity proof, overflow, authorization, filtering, paging, and
redaction. A live ArcSuite environment is still required to qualify the
operator's configured service version and real repository behavior.

## ArcSuite v1.2 S4 document integrity

S4 adds only `validateCertificate` and `getCertificateEvidence` to the
read-only SOAP allowlist. Their narrow request and response shapes are locked
by synthetic Java self-tests based on the operator-provided licensed contract.
`calculateCertificateEvidence`, timestamp attachment, and mutation-capable
operations remain prohibited.
For one requested document, strict accounting accepts zero or one validation
result entry and zero or one per-ID failure. A mixed result-plus-failure shape
is accepted only for the live-compatible case of a structurally valid but
completely empty result placeholder paired with an index-zero failure; it is
treated as the per-ID failure. A populated or malformed result plus a failure,
duplicate entries, unexpected direct text, or a nonzero failure index remains
fail-closed. Validation elements are
reduced to certificate ID, boolean result, and exception presence; evidence is
reduced to certificate IDs, with certificate attributes and raw provider
details discarded in the adapter. No vendor WSDL or response excerpt is
redistributed.

The Reference Guide semantics are intentionally conservative: a false result
can mean a missing signature or timestamp and does not prove tampering. The MCP
tool therefore reports `invalid_or_unverifiable` for false, exceptional, or
empty validation results. `getCertificateEvidence` reports availability only
and cannot promote validation status. `invalid_or_unverifiable` and
`validation_failed` do not prove that the document was altered. Evidence is a
separate scope opt-in; requesting it while disabled fails before integrity
provider dispatch, and a per-ID validation failure produces no evidence
dispatch.

The validation-only path has passed qualification in an operator-controlled
live ArcSuite environment, including the empty-placeholder plus index-zero
failure response (23 checks passed and none failed). Suitable evidence-bearing
records were not available in the qualification corpus, so evidence-provider
live status is
`NOT_AVAILABLE_IN_TEST_DATA`, not pass or fail. Component availability,
unsigned-object variants, XAdES/PAdES variants, and each operator's exact
environment still require local qualification.

## v1.2 cross-cutting remediation status

The F1–F7 closure remediation is implemented and covered by the complete local
validation suite. Closure Remediation Round 2 is also implemented, including
current content authority, strict WSDL response shapes, bounded materialization,
and MCP revision-schema parity. This records implementation evidence plus the
narrow S4 validation-only live qualification above; it does not claim broad
operator-environment or client qualification. An independent Final
Cross-Cutting Audit remains pending before v1.2 closure.
