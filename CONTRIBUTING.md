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
