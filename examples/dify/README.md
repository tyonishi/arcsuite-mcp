# Dify example

This directory contains synthetic configuration and agent text for connecting
a self-hosted Dify MCP client to the ArcSuite MCP gateway.

Historical design target: Dify 1.14.2. It was not live-qualified as part of
this sanitized repository build. Use a Dify release/plugin that supports
Streamable HTTP and revalidate the exact configuration in the target
environment.

Files:

- `mcp-config.example.json` — synthetic gateway URL and header shape;
- `agent-instructions.md` — read-only semantic agent guidance;
- `ssrf_proxy_allowlist.example.conf` — narrow destination example.

Do not add screenshots, private workspace names, private DNS names, real
tokens, or ArcSuite configuration to this directory.
