# Java ArcSuite adapter rules

The Java module is a private-network adapter, not a second MCP surface and not
a generic SOAP dispatcher. It accepts only server-to-server requests from the
TypeScript semantic gateway.

## SOAP and session constraints

- Keep the SOAP operation set aligned with the TypeScript read-only allowlist.
- Keep administrator mode false and do not add privilege assertion, ACL,
  deletion, print, workflow, delegation, or arbitrary-operation code.
- Obtain the licensed ArcSuite WSDL and Reference Guide in the operator's
  environment when validating a deployment; do not copy them into this tree.
- Use the configured endpoint only. The MCP request never supplies an
  endpoint, cabinet, WSDL path, or SOAP operation.
- Preserve the ArcSuite Session header behavior, request version, locale, and
  MTOM attachment type required by the operator's licensed service.
- RSA credential handling must use the server challenge and public key with
  the documented encrypted-login scheme. Passwords and the gateway token are
  read from secret files when configured, with environment variables only as
  a controlled local-development fallback; neither is ever logged or
  returned.

## MTOM and content lifecycle

- Fully consume and close the HTTP response body and MTOM parts before a later
  SOAP operation uses the session.
- Enforce response/content size bounds before materializing a shared file.
- Keep shared files inside the configured mode-700 directory, use safe names,
  and remove them after the TypeScript content bridge consumes or discards
  them.
- Never log extracted text, binary data, credentials, session IDs, or SOAP
  envelopes.
- Keep `Containerfile` base images pinned to reviewed SHA-256 digests. The
  adapter build context must remain covered by `.dockerignore` exclusions for
  vendor material, credentials, traces, and document data.

## XML safety

Disable DTD and external entities in all XML parsing. Escape XML values,
reject unsafe archive paths and decompression ratios, and do not execute
macros or embedded objects.

Before changing this module, run:

```sh
(cd adapter-java && ./compile.sh && ./selftest.sh)
npm run check:invariants
npm run check:hygiene
```
