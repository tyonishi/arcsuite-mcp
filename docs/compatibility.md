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

## Qualification limits

Local tests use a mock adapter and synthetic content. They verify protocol
shape, semantic policy, content bounds, and security invariants; they do not
prove compatibility with a live ArcSuite server, every vendor version, a
particular client UI, or a production network proxy.
