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

v1.1 batch metadata hydration deliberately sends `resolveRef=false` for
`getRepositoryObjects`. Paging snapshots are keyed by the exact IDs returned by
the ID-only operations, so reference resolution at this internal batch step
would change object identity and make page/accounting checks ambiguous. Existing
single-object and content paths continue to apply the configured reference
resolution policy where their contracts allow it.

The Java adapter encrypts the `getLoginInfo` challenge concatenated with the
configured password using explicitly parameterized RSA-OAEP (SHA-256 with
SHA-256 MGF1). This padding choice is part of the adapter's wire behavior and
must be qualified against the operator's licensed ArcSuite version before
deployment.

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
S3 does not implement document-integrity validation; that remains the next
approved v1.2 slice.
