# Contributing

Contributions should preserve the semantic, read-only boundary and the public
sanitization rules in `AGENTS.md`.

Before opening a pull request, run:

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

Use synthetic IDs, hostnames, document names, and content in tests. Do not
commit licensed ArcSuite manuals, WSDL/XSD files, SDK binaries, sample source,
production traces, secrets, or personal information.

Every change that affects a tool, scope mapping, adapter operation, content
extractor, authentication rule, or transport must include tests and update
the relevant Markdown documentation.

## Build-context and public-template checks

The public hygiene gate includes the tracked Compose and environment examples,
including hidden `.env.example` and `.env.compose.example`. Those three required
examples must exist as regular files. Future root-level `.env.*.example` and
`*.example.yml`/`*.example.yaml` templates are discovered as well. Ignored local
operator `.env` and `docker-compose.yml` are not public scan targets. The detector
uses existing heuristic patterns; this is not a comprehensive secret scanner.

For build-context changes, also run:

```sh
node scripts/check-java-build-context.mjs
```

This requires Docker Engine with Buildx and Java 17. CI runs it in the Java job.
It builds a disposable scratch context from tracked Java files plus synthetic
markers, exports Docker's filtered COPY result, checks marker paths and values
are absent, compares required build inputs byte-for-byte, and compiles the
exported sources. It does not pull the production base images, deploy a service,
or inspect local operator environment files. A missing local engine is an
unrun check, not a passing skip; CI must supply the required verification.

Never use real credentials or private endpoints in negative test fixtures.
