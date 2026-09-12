# ADR 0003: Do not redistribute vendor material

- Status: accepted
- Date: 2026-09-12

## Decision

Vendor manuals, WSDL/XSD files, SDK binaries, sample source, screenshots, and
unclear-rights extracts are excluded from the repository. The project names
the vendor topics developers must verify and supports operator-supplied
material outside version control.

## Rationale

The public tree should contain only original implementation and documentation
that the project can safely distribute. Licensed environment material remains
with the operator.
