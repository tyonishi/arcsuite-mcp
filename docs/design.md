# Design

## Product boundary

ArcSuite MCP Server is a semantic gateway for MCP-compatible clients. It is
not a general-purpose SOAP bridge. A model can ask for a document search or a
bounded read in an allowed semantic scope; it cannot construct a SOAP body or
choose an arbitrary ArcSuite endpoint.

The v1 contract is R1 Core Read plus R2 Content Read. R3 integrity,
thumbnails, hard references, and richer content access are roadmap items, not
hidden options.

## Semantic scopes

A scope has a public name, description, allowed object types, configured
ArcSuite cabinet/root mapping, default system attributes, and optional
semantic attributes. Semantic filter names are validated against the selected
scope before an adapter request is built.

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
binary payload.

Extractors do not execute macros or embedded objects. XML DTD/external entity
input is rejected. OOXML archive traversal, decompression, member size, and
output limits are enforced by the Python helper and its Node process wrapper.

## Extensibility

The adapter interface is intentionally narrower than the full ArcSuite
interface. Future read features should add a semantic contract, scope policy,
adapter method, test fixture, and threat-model entry together. Mutations are
not an implicit extension point: any future governed mutation needs a new
approval and workflow design with zero business retries.
