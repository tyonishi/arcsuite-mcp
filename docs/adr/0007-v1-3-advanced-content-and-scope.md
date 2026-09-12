# ADR 0007: v1.3 Advanced Content and Scope

- Status: accepted
- Date: 2026-09-13

## Context

v1.0 establishes the semantic read-only contract, v1.1 improves discovery and
efficiency, and v1.2 adds richer repository read capabilities. The next set of
user-experience improvements involves richer content presentation and more
flexible semantic scoping.

These changes are more structurally significant because they can affect MCP
resource delivery, tool contracts, cache behavior, and how one physical
ArcSuite cabinet is partitioned into multiple semantic views. They therefore
need an explicit boundary separate from v1.1 and v1.2.

## Decision

v1.3 is the **Advanced Content and Scope** release. It SHALL improve rich
content access, revision comparison, and semantic-scope composition while
preserving the existing read-only and no-generic-proxy architecture.

### Included capabilities

1. **Thumbnail and preview delivery**
   - ArcSuite thumbnail retrieval MAY be added after the target environment is
     qualified.
   - Binary thumbnail data SHALL NOT be embedded as base64 in ordinary tool
     text or `structuredContent` merely for convenience.
   - Preferred delivery is an MCP Resource or an equivalent short-lived,
     authenticated internal resource URL when the target MCP client supports
     it safely.
   - Preview lifetime, size, MIME type, authorization, and cache use MUST be
     bounded.

2. **Revision comparison**
   - Add a semantic read capability to compare two explicitly selected document
     revisions.
   - The server SHOULD reuse the existing bounded content extraction pipeline
     and compare normalized text snapshots rather than exposing raw binary
     diffing as an MCP contract.
   - Comparison output MUST be bounded and SHOULD provide concise structured
     change segments plus warnings when extraction fidelity is limited.
   - Both revisions MUST be authorized within the same allowed semantic scope.

3. **Multiple semantic scopes over one physical cabinet**
   - Remove the v1.0 assumption that enabled scopes cannot overlap at the
     cabinet level when a stronger root/path membership proof is configured.
   - Object-oriented tools SHALL accept or otherwise resolve an explicit
     semantic scope when object ID alone cannot identify a unique scope.
   - Scope membership MUST be proven using configured root/path constraints and
     returned ArcSuite path information before any data is returned.
   - Ambiguous membership MUST fail closed; the server must not guess a scope.

4. **Scope-qualified object contracts**
   - Tool contracts MAY evolve from `document_id` alone to the explicit pair
     `scope + document_id` for operations that require unambiguous semantic
     authorization.
   - Backward compatibility MAY be retained only when the server can prove that
     an object ID maps to exactly one allowed scope.
   - Client-facing migration behavior MUST be documented before changing any
     required input fields.

5. **Configurable semantic shortcut tools**
   - Operators MAY define high-value semantic shortcuts that bind a stable tool
     contract to a configured scope and semantic filter set.
   - Shortcut tools are generated only from trusted server configuration; they
     are not derived dynamically from WSDL operations.
   - Generated tools MUST inherit the same profile allowlist, input validation,
     result bounds, and audit behavior as core tools.
   - A shortcut can narrow authority but must never widen it.

6. **Optional richer document relationship navigation**
   - v1.2 relationship reads MAY be composed into bounded user-facing
     navigation patterns such as "related documents" or "referenced by".
   - Automatic recursive graph crawling remains prohibited unless every depth,
     fan-out, scope, and total-result bound is explicit.

7. **Optional DocuWorks/XDW content integration**
   - DocuWorks/XDW extraction MAY be added only if a clean, redistributable,
     operationally safe implementation or operator-supplied integration is
     available.
   - Vendor executables, SDK binaries, manuals, and sample source MUST NOT be
     redistributed by this repository.
   - Unsupported environments continue to fail safely rather than silently
     degrading into unsafe conversion behavior.

### ArcSuite operation additions

v1.3 MAY add `getRepositoryObjectThumbnailContent` for bounded preview delivery
after transport and client-resource semantics are qualified.

No mutation operation is implied by v1.3.

## Explicit exclusions

v1.3 SHALL NOT introduce:

- administrator mode, privilege assertion, ACL mutation, delete, or any other
  mutation;
- privileged-print retrieval;
- arbitrary binary/base64 tool responses;
- arbitrary URL fetching or caller-controlled resource hosts;
- automatic WSDL-to-tool generation;
- unbounded relationship traversal or revision comparison;
- implicit cross-scope authorization based only on an object ID prefix when
  multiple semantic scopes overlap.

## Security invariants

- ADR 0001 and ADR 0004 remain authoritative.
- Binary preview resources are separately authorized and bounded; they are not
  a bypass around the content extraction boundary.
- Every object and revision comparison target is proven in the selected
  semantic scope before content retrieval.
- Same-cabinet multi-scope support must strengthen path/root verification
  rather than weaken it.
- Semantic shortcut generation is configuration-driven and can only narrow
  existing policy.
- Any temporary content or preview cache remains client-profile and scope
  isolated, bounded, expiring, and excluded from audit content.

## Compatibility impact

The multiple-scope model can affect object-oriented tool input contracts. Any
required `scope` addition must be introduced with explicit migration guidance
and compatibility tests. Existing deployments with non-overlapping scopes
should continue to operate without behavior changes.

Thumbnail/resource support depends on MCP client capabilities and therefore
must remain optional and capability-detected. Core metadata and text reads
remain usable without preview support.

## Implementation consequences

- Introduce an explicit scope-resolution and membership-proof abstraction.
- Update the scope registry to permit overlapping cabinets only when disjoint
  or otherwise provable root/path constraints are configured.
- Update tool schemas and tests for ambiguous versus explicit scope selection.
- Add a bounded revision-comparison service over normalized extracted text.
- Add optional MCP Resource or signed internal-resource delivery for thumbnails.
- Add trusted configuration and schema generation for semantic shortcut tools.
- Add client compatibility tests for resource-capable and resource-incapable
  MCP clients.
- Keep DocuWorks integration behind an optional provider interface and public
  repository licensing/hygiene checks.

## Acceptance boundary

v1.3 is complete when advanced content and multi-scope features preserve the
existing read-only boundary, ambiguous scope membership fails closed, preview
resources cannot be used as arbitrary binary exfiltration, revision comparison
is bounded, and optional integrations do not alter core operation for clients
that do not support them. Live thumbnail and DocuWorks behavior remain
operator qualification items.

## Related decisions

- ADR 0001: Semantic read-only MCP boundary
- ADR 0002: No generic SOAP proxy
- ADR 0003: No vendor material distribution
- ADR 0004: Content extraction boundary
- ADR 0005: v1.1 Read UX and Efficiency
- ADR 0006: v1.2 Rich Repository Read
