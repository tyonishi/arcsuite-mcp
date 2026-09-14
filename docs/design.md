# Design

## Product boundary

ArcSuite MCP Server is a semantic gateway for MCP-compatible clients. It is
not a general-purpose SOAP bridge. A model can ask for a document search or a
bounded read in an allowed semantic scope; it cannot construct a SOAP body or
choose an arbitrary ArcSuite endpoint.

The v1 contract is R1 Core Read plus R2 Content Read. The v1.2 surface adds
typed search, content-label policy, Hard Reference reads, and document
integrity through explicit semantic tools and per-scope authorization.
Thumbnails and richer content access remain roadmap items, not hidden options.

## Semantic scopes

A scope has a public name, description, allowed object types, configured
ArcSuite cabinet/root mapping, default system attributes, optional semantic
attributes, and optional semantic content-label aliases. Semantic filter and
content-label names are validated against the selected scope before an adapter
request is built.

The physical registry is operator configuration. The model sees names such as
`document_number` only when the operator has deliberately configured that
name. Physical Attribute IDs are not exposed in tool schemas or results.

At startup, a live adapter can validate required attributes against ArcSuite
schema metadata. A mock adapter provides synthetic fixtures for local tests.

## Read-only policy

The following layers must agree before an ArcSuite operation is reachable:

- public MCP tool schema;
- parser and semantic scope checks;
- TypeScript operation construction;
- Java adapter route and operation allowlist;
- invariant and integration tests.

Administrator mode is fixed false. Credentials, Session headers, and service
configuration never cross the MCP tool boundary.

## Content contract

ArcSuite content is materialized into a private shared directory only long
enough for extraction. The TypeScript bridge enforces a maximum byte size and
maximum extracted character count, supports signed cursors, and deletes the
file in a `finally` path. Unsupported content fails without returning the
binary payload. Every selected label is resolved from trusted scope policy to
one physical ArcSuite `I18nString`; current requested/effective identity,
cabinet/root/type, and membership are proved before cache/cursor reuse or
content dispatch. Membership is an exact namespace/name comparison against
`rep:system:contentlabellist`, and the adapter's returned `Content.label` is
checked against the same pair. The semantic alias, not the physical mapping,
is retained in MCP results and read cursors.

Extractors do not execute macros or embedded objects. XML DTD/external entity
input is rejected before entity expansion by the shared encoding-aware OOXML
parser. OOXML archive traversal, decompression, member size, and output limits
are enforced by the Python helper and its Node process wrapper.
DOCX/PPTX parts share one incremental output budget. XLSX cells are emitted
directly into that budget; repeated shared strings are sliced before output
materialization, and cell/row/sheet traversal stops when the budget is full.
The PDF subprocess stdout bound is derived from the same configured character
budget, while plain-text/XML input remains independently bounded by the
content-byte limit.

## Extensibility

The adapter interface is intentionally narrower than the full ArcSuite
interface. Future read features should add a semantic contract, scope policy,
adapter method, test fixture, and threat-model entry together. Mutations are
not an implicit extension point: any future governed mutation needs a new
approval and workflow design with zero business retries.
