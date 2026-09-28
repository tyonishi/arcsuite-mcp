# Dify integration example

This page is an integration example only. ArcSuite MCP Server does not depend
on Dify and its core schemas, source, and architecture contain no Dify-specific
behavior.

## Compatibility status

- Historical design target: self-hosted Dify 1.14.2. It remains historical and
  is not a project requirement.
- Live operator qualification: `PASS` on 2026-09-28 against ArcSuite MCP
  source `60e38ecdd6c7a648f3b14f6cf31008bb326a0079` and the operator's
  published ArcSuite workflow release `v0.10.2`.
- `DIFY_TOOLS_LIST_COMPATIBILITY`: `PASS`. After provider refresh, Dify
  exposed the ref-native read's structured `content`, `truncated`, and
  `result_ref` outputs. The qualified strict profile remained nine tools;
  the ref-native read output did not expose `document_id` or `open_url`.
- `DIFY_RUNTIME_SMOKE_TEST`: `PASS`. One non-empty qualified document
  returned 10,990 structured characters through both raw MCP and Dify for the
  same result ref, with matching SHA-256. The workflow consumed structured
  content through its bounded Content Read Bridge.
- Unified workflow regression: `PASS` for revision history, content summary,
  bounded compare, and cross-scope replay (B1-B4) on the same published
  workflow release.
- Recommended transport: Dify's MCP plugin configured for standards-based
  Streamable HTTP at `/mcp`.
- Legacy SSE-only plugin behavior: not part of the core endpoint. Upgrade or
  separately qualify a compatible plugin rather than exposing the ArcSuite
  adapter directly.

This qualification record applies to one operator deployment. The exact Dify
platform/plugin release was not promoted into the sanitized public contract;
other deployments must requalify their plugin, transport, provider refresh,
and workflow binding. Do not treat the historical version as a requirement or
the live record as a generic compatibility guarantee.

## Structured read output

`arcsuite_read_document` and `arcsuite_read_document_by_ref` advertise output
schemas for their successful structured results. After deploying an MCP server
version that includes these schemas and refreshing the Dify provider/tool
definition, bind the ref-native result's structured `content` field as the
primary input to a content bridge. For a bridge variable named
`det_content_read`, the intended binding is `det_content_read.content`.

Keep the existing text-header parser as a compatibility fallback using
`det_content_read.text`. Preserve the workflow's existing 16,000-character
bound and fail-closed guard until a non-empty structured content value has
been verified. Persisted qualification evidence should contain only status,
length/truncation, hashes, and other non-content metadata. Document text and
opaque-ref values must not be persisted. A workflow may carry an opaque
`result_ref` internally for authority validation, but it must remain
non-user-visible and be excluded or redacted from retained evidence.

The live qualification above confirms the structured binding for the recorded
operator deployment. It also confirmed an important content boundary:
`extractable: true` does not guarantee non-empty normalized text. A
content-summary workflow must require a non-empty structured `content` value
and fail closed when it is empty; a human-readable read-result header is not
document content.

Other Dify plugin releases still require provider refresh, binding inspection,
and a bounded live read before being treated as compatible.

## Synthetic MCP configuration

```json
{
  "name": "arcsuite-example",
  "transport": "streamable-http",
  "url": "http://arcsuite-mcp:8080/mcp",
  "headers": {
    "Authorization": "Bearer ${ARCSUITE_MCP_TOKEN}"
  }
}
```

The URL is a synthetic container-network example. Use an actual service name
only after configuring `MCP_ALLOWED_HOSTNAMES` and the network boundary.
Never put the ArcSuite SOAP endpoint, WSDL, password, or adapter token in the
Dify configuration.

## Self-hosted networking

Place Dify's MCP client, the gateway, and only the gateway-facing proxy on a
network where the gateway service name resolves. Keep the Java adapter and
ArcSuite endpoint on a separate private path. The gateway should be the only
service Dify can call.

If Dify's SSRF proxy is enabled, add only the gateway service destination to
its allowlist. Do not allow all RFC1918/private networks. The sample rule is
in `examples/dify/ssrf_proxy_allowlist.example.conf`.

Confirm that the proxy preserves the `Authorization` header to the gateway,
does not forward it to unrelated destinations, and does not log it. Set the
gateway Host/Origin allowlists to the names clients actually use.

## Agent instruction example

Use the short instruction in `examples/dify/agent-instructions.md`. It tells
the agent to search a configured semantic scope, inspect metadata, read
bounded text, and avoid physical ArcSuite details or unsupported operations.
