# Dify example

This directory contains synthetic configuration and agent text for connecting
a self-hosted Dify MCP client to the ArcSuite MCP gateway.

Historical design target: Dify 1.14.2. That version is not a project
requirement. One operator deployment was live-qualified on 2026-09-28 for
Streamable HTTP, provider refresh, structured ref-native read output, and the
published ArcSuite workflow release `v0.10.2` against server source
`60e38ecdd6c7a648f3b14f6cf31008bb326a0079`.

That evidence does not qualify every Dify release or MCP plugin. Revalidate the
exact client/plugin, provider refresh, structured-output binding, and bounded
read path in each target environment.

Files:

- `mcp-config.example.json` — synthetic gateway URL and header shape;
- `agent-instructions.md` — read-only semantic agent guidance;
- `ssrf_proxy_allowlist.example.conf` — narrow destination example.

Do not add screenshots, private workspace names, private DNS names, real
tokens, or ArcSuite configuration to this directory.
