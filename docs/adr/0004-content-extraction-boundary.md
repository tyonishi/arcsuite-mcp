# ADR 0004: Bounded content extraction

- Status: accepted
- Date: 2026-09-12

## Decision

Content is retrieved through the adapter, materialized only in a private
shared directory, extracted by allowlisted handlers, bounded by bytes and
characters, and returned as text plus a signed cursor where needed. Binary and
base64 payloads are not ordinary MCP results.

## Consequences

Some content is unsupported or truncated by design. XML and archive safety
checks are part of the content contract. DocuWorks/XDW remains a roadmap item
until a safe, redistributable extractor exists.
