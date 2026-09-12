# ADR 0002: Do not expose a generic SOAP proxy

- Status: accepted
- Date: 2026-09-12

## Decision

There is no MCP tool for arbitrary SOAP operation, endpoint, cabinet, WSDL, or
Attribute ID input. The adapter has a fixed read-only operation allowlist.

## Rationale

A generic proxy would turn model input into an administrative and data-access
primitive, make authorization difficult to reason about, and leak vendor
protocol details. Semantic tools make the trust boundary testable.
