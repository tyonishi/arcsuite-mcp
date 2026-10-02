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

## Document-integrity guidance

Use `arcsuite_validate_document_integrity` only when the selected scope and
token profile advertise it. A `valid` result is a narrow ArcSuite validation
outcome, not a general trust or authenticity guarantee.
`invalid_or_unverifiable` and `validation_failed` do not prove tampering and
should be presented as inconclusive or failed validation, not as an accusation.
Evidence availability is a separate operator opt-in. Do not request it unless
the scope permits it, and never supply certificate IDs or ask for raw
certificate attributes, raw provider exceptions, or certificate material.

Synthetic request example:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "arcsuite_validate_document_integrity",
    "arguments": {
      "document_id": "rep:example:document-001",
      "include_evidence": false
    }
  }
}
```

The validation-only path has been qualified in an operator-controlled live
ArcSuite environment. The optional evidence-provider path is
`NOT_AVAILABLE_IN_TEST_DATA`. Operators should separately qualify the evidence
path for the target environment and intended document corpus before enabling
it.
