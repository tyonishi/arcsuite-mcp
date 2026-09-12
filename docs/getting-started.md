# Getting started

## Synthetic local run

The repository includes a mock adapter and a synthetic scope. It is the
recommended first validation because it needs no ArcSuite account or vendor
file.

```sh
npm ci
MCP_DEV_BEARER_TOKEN=local-example-token npm run dev
```

In another terminal, discover tools:

```sh
curl -sS http://127.0.0.1:8080/mcp \
  -H 'Authorization: Bearer local-example-token' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-03-26' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

The current official SDK may return a legacy-compatible SSE response for a
2025-era request. A current client using the 2026-07-28 era may use the same
`/mcp` endpoint with its modern request envelope.

## Operator setup outline

1. Obtain the ArcSuite Web Service Interface Reference Guide and WSDL from the
   licensed environment.
2. Copy `config/scopes.example.yaml` to an ignored `config/scopes.yaml` and
   replace the cabinet, root, service, and semantic attribute placeholders
   after checking the actual schema.
3. Create a token profile from a local bearer token hash. Do not commit the
   token file.
4. Build and run the Java adapter in a private network with secret files for
   its password and internal token.
5. Set `ARCSUITE_ADAPTER_MODE=http`, the internal adapter URL, cursor secret,
   token profile file, and the real scope file.
6. Run startup validation and confirm `/readyz` before connecting an MCP
   client.
7. Qualify the real ArcSuite version and client in a controlled environment.

For the two-container Podman template, follow the secret-name and mount
instructions in [deployment.md](deployment.md) before running
`podman/podman-run.example.sh`.

Do not put an ArcSuite endpoint or credentials into MCP client configuration.
The MCP client should know only the gateway URL and its bearer token.

## Token hashing

```sh
npm run hash-token -- 'replace-with-a-local-token'
```

Store the resulting hash in a local ignored token file. The plaintext token
belongs only in the MCP client's secret management.
