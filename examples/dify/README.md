# Dify example

This directory contains synthetic configuration and agent text for connecting
a self-hosted Dify MCP client to the ArcSuite MCP gateway.

Historical design target: Dify 1.14.2. It was not live-qualified as part of
this sanitized repository build. Use a Dify release/plugin that supports
Streamable HTTP and revalidate the exact configuration in the target
environment.

The gateway's S4 validation-only path has separate operator-controlled live
qualification, but this Dify integration has not. Treat
`invalid_or_unverifiable` and `validation_failed` as non-affirmative outcomes,
not proof of tampering. Evidence remains separately opt-in and its live path
was `NOT_AVAILABLE_IN_TEST_DATA`. See `agent-instructions.md` for the
conservative client behavior.

Files:

- `mcp-config.example.json` — synthetic gateway URL and header shape;
- `agent-instructions.md` — read-only semantic agent guidance;
- `ssrf_proxy_allowlist.example.conf` — narrow destination example.

Do not add screenshots, private workspace names, private DNS names, real
tokens, or ArcSuite configuration to this directory.
