# Dify integration example

This page is an integration example only. ArcSuite MCP Server does not depend
on Dify and its core schemas, source, and architecture contain no Dify-specific
behavior.

## Compatibility status

- Historical design target: self-hosted Dify 1.14.2.
- Live Dify qualification: not performed for this sanitized public tree.
- `DIFY_TOOLS_LIST_COMPATIBILITY`: `EVIDENCE_NOT_AVAILABLE`; source review
  confirms the read tool uses an `anyOf` schema, but does not prove that the
  target Dify MCP plugin interprets that shape correctly.
- `DIFY_RUNTIME_SMOKE_TEST`: `PENDING_BEFORE_MERGE`; run the target Dify
  profile through `tools/list` and a bounded read-tool call before merge or
  deployment.
- Recommended transport: Dify's MCP plugin configured for standards-based
  Streamable HTTP at `/mcp`.
- Legacy SSE-only plugin behavior: not part of the core endpoint. Upgrade or
  separately qualify a compatible plugin rather than exposing the ArcSuite
  adapter directly.

Recheck the exact Dify plugin and transport behavior in the target Dify
release. Do not treat the historical version as a project requirement.

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
