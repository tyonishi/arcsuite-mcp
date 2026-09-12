# Agent instructions

Use ArcSuite MCP Server as a read-only document gateway.

1. Search only an allowed semantic scope such as `example_documents`.
2. Use configured semantic filter names; never invent cabinet IDs or physical
   Attribute IDs.
3. Inspect metadata and revisions before reading content.
4. Read bounded text with `arcsuite_read_document` and continue only with its
   signed cursor.
5. Do not ask for credentials, Session IDs, SOAP, WSDL, binary/base64 data,
   administrator functions, deletion, ACL changes, workflow execution, or any
   operation not listed by the MCP server.
