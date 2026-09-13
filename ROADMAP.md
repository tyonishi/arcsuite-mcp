# Roadmap

## v1.0 — Read-only Complete

Status: current baseline

v1.0 establishes the R1 Core Read + R2 Content Read boundary:

- semantic document search and configured attribute filters;
- metadata, path, folder, and revision reads;
- bounded ArcSuite content retrieval through SOAP/MTOM;
- safe text extraction for supported formats;
- signed cursors for bounded document reads;
- no mutation, administrator mode, ACL changes, hard delete, workflow
  execution, privileged-print retrieval, or arbitrary SOAP dispatch.

The core security model is defined by ADR 0001 through ADR 0004.

## v1.1 — Read UX and Efficiency

ADR: [0005-v1-1-read-ux-and-efficiency.md](docs/adr/0005-v1-1-read-ux-and-efficiency.md)

Goal: improve discoverability, navigation, paging, and read efficiency without
widening authority.

Planned scope:

- profile-aware scope and semantic-filter discovery;
- profile-aware dynamic tool schemas and descriptions;
- stable search/folder continuation paging using bounded ID snapshots;
- bounded batch metadata reads;
- short-lived extracted-content snapshot/cache reuse;
- reuse between content-info and document-read paths;
- optional operator-configured ArcSuite UI deep links.

v1.1 remains entirely read-only and additive to the v1.0 tool surface.

## v1.2 — Rich Repository Read

ADR: [0006-v1-2-rich-repository-read.md](docs/adr/0006-v1-2-rich-repository-read.md)

Goal: expose selected higher-value ArcSuite repository reads through the same
semantic policy boundary.

Implemented scope:

- bounded, single-hop incoming Hard Reference traversal;
- document integrity validation and optional already-calculated evidence
  availability;
- typed semantic filters for string, numeric, boolean, date/time, and enum
  attributes after live schema validation;
- operator-allowlisted full-text search modes;
- operator-allowlisted additional content labels.

S1 Typed Search Foundation, S2 Content Labels, S3 Hard References, and S4
Document Integrity are implemented and synthetically qualified. Live ArcSuite
qualification remains environment-dependent. v1.2 does not include
`calculateCertificateEvidence`, timestamp attachment, evidence mutation,
repository mutation, RMS, Collaboration, or Workflow operations.

## v1.3 — Advanced Content and Scope

ADR: [0007-v1-3-advanced-content-and-scope.md](docs/adr/0007-v1-3-advanced-content-and-scope.md)

Goal: add richer content presentation and more flexible semantic scope
composition while keeping the read-only boundary intact.

Planned scope:

- bounded thumbnail/preview delivery through MCP Resource or an equivalent
  authenticated short-lived internal resource path;
- bounded revision comparison over normalized extracted text;
- multiple semantic scopes mapped onto one physical cabinet when membership can
  be proven by root/path constraints;
- explicit scope-qualified object access where object ID alone is ambiguous;
- trusted configuration-driven semantic shortcut tools;
- richer bounded relationship navigation;
- optional DocuWorks/XDW extraction only when a clean, redistributable and safe
  provider is available.

## Future — User-aware identity and reads

Future user-aware work may include per-user ArcSuite identity, RMS,
Collaboration reads, and Workflow reads. It is not required for v1.x and must
preserve ArcSuite's user-level authorization semantics.

## Future — Governed mutation

Mutation remains optional future work rather than a v1.x goal. If introduced,
it requires explicit human approval and workflow-controlled execution.
Business mutation retry remains zero.

## Permanently constrained / excluded from the semantic MCP surface

The following remain outside the read-only roadmap unless a future ADR
explicitly reopens them with a new security model:

- generic SOAP proxy behavior;
- arbitrary endpoint/cabinet/Attribute ID input;
- administrator mode and privilege assertion;
- ACL mutation;
- hard delete;
- privileged-print retrieval;
- delegated workflow execution;
- arbitrary mutation dispatch.

Roadmap version labels describe planned capability boundaries, not claims of
live ArcSuite qualification. Repository CI uses synthetic fixtures; each
operator must qualify the relevant ArcSuite version, schema, and enabled
services in its own licensed environment.
