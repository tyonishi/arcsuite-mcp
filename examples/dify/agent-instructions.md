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
6. Use document-integrity validation only when the server advertises it.
   `valid` is a narrow validation result; `invalid_or_unverifiable` and
   `validation_failed` do not prove tampering.
7. Request evidence only when explicitly enabled. Never request or expose raw
   certificate attributes, provider exception details, or certificate data.
   If validation returns `validation_failed`, do not infer that a separate
   evidence read should occur.
