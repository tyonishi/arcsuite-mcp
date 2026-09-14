# ADR 0006: v1.2 Rich Repository Read

- Status: accepted
- Date: 2026-09-13

## Context

v1.0 proves a constrained semantic read-only gateway and v1.1 improves its
usability and efficiency without changing authority. ArcSuite exposes
additional repository capabilities that are still read-only and useful to AI
clients, including relationship traversal, certificate/evidence inspection,
and richer attribute search.

Those capabilities should be introduced deliberately rather than by exposing
more SOAP surface directly. The semantic boundary, explicit operation
allowlist, scope validation, and bounded-result rules remain the primary
security controls.

## Decision

v1.2 is the **Rich Repository Read** release. It SHALL add selected ArcSuite
repository read capabilities that improve document understanding and discovery
while preserving ADR 0001's semantic read-only model.

### Included capabilities

1. **Related-document traversal**
   - S3 exposes only `arcsuite_list_hard_references` for incoming hard-reference
     relationships; traversal is single-hop and has no caller-selected depth or
     relationship type.
   - Relationship traversal MUST return only objects proven to be inside an
     allowed semantic scope.
   - Physical reference IDs and raw ArcSuite relationship structures remain
     internal implementation details.
   - A scope MUST explicitly enable Hard Reference discovery. Candidates MUST
     be bounded and authorized before paging; recursive unbounded graph walking
     is not allowed.

2. **Document integrity validation**
   - Add a semantic read tool such as `arcsuite_validate_document_integrity`.
   - `validateCertificate` MAY be allowlisted as the primary validation
     operation.
   - `getCertificateEvidence` MAY be allowlisted for already-calculated
     evidence when useful to the semantic result.
   - Semantic output SHOULD normalize vendor-specific certificate/evidence
     structures into a compact status, warnings, and evidence summary without
     exposing raw SOAP faults or unnecessary certificate material.

3. **Typed semantic filters**
   - Extend semantic attribute configuration beyond the v1.0 string/datetime
     baseline to support, where ArcSuite schema validation confirms the type:
     string, integer, number, boolean, date/datetime, and enumerated values.
   - Supported operators MUST be explicitly configured per semantic attribute.
   - Runtime values MUST be validated and normalized according to the verified
     ArcSuite `AttributeSchema` before SOAP conditions are constructed.
   - Unsupported type/operator combinations MUST fail closed.

4. **Configured full-text search modes**
   - A scope MAY opt in to specific ArcSuite full-text search modes supported by
     the operator's environment.
   - The client MAY choose only from modes explicitly permitted by the scope.
   - Environment-sensitive modes such as thesaurus or stemming MUST NOT be
     assumed available merely because the protocol defines them.

5. **Additional content labels**
   - A scope MAY explicitly allow additional read-only content labels beyond
     `system:primary`.
   - Allowed labels MUST be server-side configuration and MUST be validated
     against document metadata before retrieval.
   - The tool caller cannot provide an unrestricted ArcSuite content label.

### ArcSuite operation additions

v1.2 MAY add the following read-only operations after adapter and environment
verification:

- `listRepositoryObjectHardReferences`
- `validateCertificate`
- `getCertificateEvidence`

`calculateCertificateEvidence` is intentionally excluded from v1.2, even though
the Guide describes calculation without updating the document. It is not
necessary for S4, and any future proposal would require a new decision and
separate approval. S4 reads only evidence that ArcSuite has already calculated.

## Explicit exclusions

v1.2 SHALL NOT allow:

- `attachTimestamp` or `attachTimestampWithOptions`;
- repository mutation, lifecycle/state mutation, checkout/checkin, locking,
  stamping, move/copy, class mutation, revision mutation, ACL mutation, delete,
  disuse, or restore;
- administrator mode, privilege assertion, or privileged-print retrieval;
- arbitrary content labels or arbitrary physical ArcSuite filter expressions;
- RMS, Collaboration, or Workflow capabilities as a side effect of repository
  enrichment.

## Security invariants

- Every new ArcSuite operation must appear in an explicit read-only allowlist
  and in no generic dispatch surface.
- Relationship results, integrity targets, and content-label reads are subject
  to the same client-profile and semantic-scope checks as v1.0/v1.1.
- Result counts, relationship depth, evidence payloads, and extracted content
  remain bounded.
- Integrity/evidence responses MUST be sanitized before entering MCP output or
  audit metadata.
- No cache or relationship traversal may cross client-profile or scope
  boundaries.
- Physical enum names/localized labels MUST NOT cross the semantic boundary;
  configured Attribute IDs MUST be resolved by exact namespace and name.
- JSON/text/XML/OOXML extraction MUST keep output materialization bounded by
  the configured output budget or an independently reviewed input bound.
- Incoming Hard Reference cursors are additionally bound to the target object,
  and candidate overflow fails without a partial relationship result.

## Compatibility impact

v1.2 is additive. Existing v1.0/v1.1 clients remain valid. Typed-filter and
full-text enhancements SHOULD be discoverable through the profile-aware schema
introduced by v1.1 so clients do not need to guess environment capabilities.

## Implementation consequences

- Extend semantic attribute types and operator mapping.
- Extend startup schema validation to verify configured data types, enum
  constraints, searchability, and sortability where applicable.
- Add related-document adapter and semantic normalization paths.
- Add integrity/evidence adapter and semantic normalization paths.
- Extend the TypeScript and Java read-only operation allowlists together.
- Add tests for cross-scope references, bounded relationship traversal,
  integrity result normalization, typed filter validation, unsupported search
  modes, and additional content-label authorization.

## Acceptance boundary

v1.2 is complete when all added SOAP operations are mechanically constrained to
read-only use, all returned objects/evidence remain within semantic policy, and
synthetic integration tests prove that invalid types, labels, relationship
expansion, and forbidden operations fail closed. Live integrity behavior and
search-mode support remain operator qualification items.

S4 implements the integrity tool with one-document accounting, pre-dispatch
cabinet/root/type authorization, separate validation and evidence opt-ins, and
conservative status mapping. The Java adapter reduces validation elements to
certificate ID, boolean result, and exception presence, and reduces evidence
to certificate IDs; raw exception details and certificate attributes remain
inside the SOAP parser. These synthetic contracts do not qualify a live
ArcSuite installation.

## Related decisions

- ADR 0001: Semantic read-only MCP boundary
- ADR 0002: No generic SOAP proxy
- ADR 0004: Content extraction boundary
- ADR 0005: v1.1 Read UX and Efficiency
- ADR 0007: v1.3 Advanced Content and Scope
