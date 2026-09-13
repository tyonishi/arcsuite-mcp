# Development

## Local commands

```sh
npm ci
npm run typecheck
npm test
npm run check:invariants
npm run check:hygiene
python3 -m py_compile scripts/ooxml_extract.py
(cd adapter-java && ./compile.sh && ./selftest.sh)
```

`npm run dev` starts mock mode on loopback. `npm start` uses the configured
adapter mode and should not be run against a real service without operator
configuration.

## Test design

- unit tests cover cursors, session retry, schema/operation invariants,
  extractors, XML safety, and content bounds;
- integration tests cover MCP initialization/discovery and nine semantic tool
  calls, synthetic search/read behavior, authentication, Origin checks, raw-field
  rejection, object-class/cabinet/root response-boundary checks, and excluded
  tool reachability;
- the Java self-test covers JSON, RSA-OAEP encrypted credential construction,
  MTOM parsing, XML entity rejection, and synthetic Hard Reference SOAP shapes
  and identity proof.

Tests must use synthetic IDs, names, hostnames, and content. A test that needs
licensed ArcSuite behavior belongs in an environment-dependent qualification
plan, not in the default public test suite.

`npm run check:hygiene` scans source, documentation, examples, fixtures,
configuration, scripts, and GitHub metadata. Known private prototype markers
are represented by SHA-256 digests and lengths in `scripts/markerHashes.mjs`,
so the checker can reject their reintroduction without republishing the
markers themselves.

## Adding a semantic tool

1. Define the public schema and bounded result.
2. Add a tool definition and strict parser.
3. Add scope and adapter interfaces without exposing physical IDs.
4. Add mock and integration coverage.
5. Review operation allowlists and security invariants.
6. Update `docs/tools.md`, architecture/security documentation, and the
   changelog.

Do not add a tool merely to expose an arbitrary SOAP operation.

## Adding an extractor

Add a format-specific safe handler, byte/decompression/character limits,
cleanup tests, unsafe-input fixtures, and a documentation entry. Unsupported
formats must fail without returning the original binary.
