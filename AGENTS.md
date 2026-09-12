# ArcSuite MCP Server agent and maintainer rules

## Mission

Maintain a safe, read-only semantic MCP gateway for ArcSuite. The public
project connects MCP-compatible clients to a licensed FUJIFILM ArcSuite Web
Service Interface through a constrained adapter.

## Architectural invariant

This project is **not a generic ArcSuite SOAP proxy**. MCP callers receive
semantic tools and bounded content results. SOAP, WSDL, session headers, MTOM,
cabinet IDs, Attribute IDs, and vendor ProcessingException details remain
inside server configuration and the ArcSuite adapter boundary.

## Source-of-truth rules

When changing behavior, reconcile the change with these sources of truth:

1. public project documentation and ADRs;
2. MCP tool schemas and their validation tests;
3. the semantic scope registry and its adapter schema validation;
4. the read-only operation allowlist;
5. official ArcSuite vendor documentation available to the developer/operator;
6. the current official MCP specification and supported SDK documentation.

Private project material is historical input only. It must be sanitized before
it influences a public fixture, example, comment, or default.

## Public repository safety

Never commit private ArcSuite endpoints, real cabinet/object IDs,
organization-specific identifiers, secrets, credentials, ArcSuite session IDs,
production SOAP/MTOM traces, document contents, vendor WSDL/XSD files, vendor
manuals, vendor SDKs, or vendor sample source code. Use synthetic values such
as `arcsuite.example.invalid`, `EXAMPLE_CABINET`, and `DOC-000001`.

## Security invariants

The following must remain mechanically true:

- administrator mode is never true;
- no `assertPrivilege` call and no administrator enabling operation;
- no ACL mutation, hard delete, privileged-print retrieval, workflow
  termination, or delegated workflow execution;
- no arbitrary SOAP operation exposure;
- MCP callers cannot supply the ArcSuite endpoint, unrestricted cabinet IDs,
  or unrestricted physical Attribute IDs;
- credentials and session IDs are not accepted in or returned by MCP tools;
- binary/base64 content is not returned through ordinary MCP tool results;
- MCP request bodies, adapter responses, extracted content, and response text
  are bounded before materialization;
- configured allowed object types are enforced on every direct repository
  object result; returned object IDs and path IDs remain within the selected
  cabinet/root scope;
- adapter redirects are disabled and the gateway-to-adapter token remains
  internal;
- GitHub Actions references are pinned to full commit SHAs;
- container base images are pinned to reviewed SHA-256 digests and each build
  context excludes vendor material, credentials, traces, and document data;
- read retry is bounded to one session-refresh attempt;
- future mutation retry must remain zero.

The operation allowlist, tool registry, Java adapter, and invariant tests must
be reviewed together whenever an ArcSuite operation is added.

## Validation requirements

Work is not complete until these commands pass from the repository root:

```sh
npm ci
npm run typecheck
npm test
npm run check:invariants
npm run check:hygiene
python3 -m py_compile scripts/ooxml_extract.py
(cd adapter-java && ./compile.sh && ./selftest.sh)
git diff --check
```

If a JDK or external ArcSuite environment is unavailable, report that as an
environment-dependent limitation; do not weaken the tests or claim
qualification. Do not push, change repository visibility, publish packages,
or rewrite Git history without explicit authorization.
