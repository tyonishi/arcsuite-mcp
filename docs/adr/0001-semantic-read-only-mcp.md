# ADR 0001: Semantic read-only MCP boundary

- Status: accepted
- Date: 2026-09-12

## Decision

Expose generic semantic read tools and bounded content reads through MCP. Keep
ArcSuite SOAP, WSDL, sessions, physical cabinets, and Attribute IDs inside
server configuration and the adapter.

## Consequences

Clients receive a stable product-facing contract and cannot freely compose
ArcSuite operations. New semantic capabilities require explicit scope,
schema, test, and security review. Physical ArcSuite differences are handled
by operator configuration.
