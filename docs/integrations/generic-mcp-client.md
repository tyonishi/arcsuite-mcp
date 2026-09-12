# Generic MCP client

The client needs only the gateway URL and a bearer token mapped to a server
profile. It does not need the ArcSuite URL, WSDL, cabinet, Attribute IDs, or
credentials.

Illustrative configuration:

```json
{
  "mcpServers": {
    "arcsuite": {
      "url": "https://mcp.example.invalid/mcp",
      "headers": {
        "Authorization": "Bearer ${ARCSUITE_MCP_TOKEN}"
      }
    }
  }
}
```

The exact key names depend on the MCP client. Prefer its current official
Streamable HTTP implementation. If a client still speaks the older 2025-era
handshake, the SDK's stateless compatibility path may serve it; qualify that
client version before deployment.

Suggested agent behavior:

1. choose an allowed semantic scope;
2. search with configured semantic names;
3. inspect metadata and revisions before reading;
4. read bounded text and continue with the signed cursor only when needed;
5. never ask the server for raw SOAP, binary/base64, credentials, or physical
   ArcSuite identifiers.
