# Roadmap

## v1 boundary

The initial release focuses on R1 Core Read and R2 Content Read:

- semantic document search, metadata, paths, folder listing, revisions, and
  configured attribute filters;
- bounded text extraction from ArcSuite content delivered through SOAP/MTOM;
- signed cursors for bounded reads;
- no mutation, administrator mode, ACL changes, hard delete, workflow
  execution, or arbitrary SOAP dispatch.

## Future candidates

- R3 integrity validation, thumbnails, hard references, and richer content
  access after the read boundary is proven;
- user-aware identity, RMS, Collaboration, and Workflow reads;
- governed mutations only with explicit human approval and workflow-controlled
  execution. Business mutation retry remains zero.
- optional DocuWorks/XDW extraction only if a clean, redistributable and safe
  implementation is available.

Roadmap items are not part of the v1 security contract.
