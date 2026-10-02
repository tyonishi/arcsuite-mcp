#!/usr/bin/env sh
set -eu

# Example only. Review network, secret, volume, and service names with the
# operator's container platform. The adapter is reachable only inside this
# private network; do not publish its port to an untrusted network.

: "${ARCSUITE_SOAP_ENDPOINT:?Set ARCSUITE_SOAP_ENDPOINT to the licensed ArcSuite HTTPS endpoint}"
: "${ARCSUITE_USERNAME:?Set ARCSUITE_USERNAME to the service account name}"

IMAGE_TAG="${IMAGE_TAG:-0.1.0}"
SOURCE_REVISION="${ARCSUITE_MCP_SOURCE_REVISION:-unknown}"

for required_file in config/scopes.yaml; do
  if [ ! -f "$required_file" ]; then
    echo "Required operator configuration is missing: $required_file" >&2
    exit 1
  fi
done

for required_secret in arcsuite_password adapter_token mcp_tokens cursor_hmac; do
  if ! podman secret inspect "$required_secret" >/dev/null 2>&1; then
    echo "Required Podman secret is missing: $required_secret" >&2
    exit 1
  fi
done

podman build \
  --label "org.opencontainers.image.revision=$SOURCE_REVISION" \
  -f adapter-java/Containerfile \
  -t "arcsuite-mcp-adapter:$IMAGE_TAG" \
  adapter-java
podman build \
  --label "org.opencontainers.image.revision=$SOURCE_REVISION" \
  -f Containerfile \
  -t "arcsuite-mcp:$IMAGE_TAG" \
  .

podman volume create arcsuite-mcp-shared >/dev/null 2>&1 || true
podman volume create arcsuite-mcp-logs >/dev/null 2>&1 || true
podman network create arcsuite-mcp-net >/dev/null 2>&1 || true

podman run -d --name arcsuite-mcp-adapter --network arcsuite-mcp-net \
  --restart=always \
  --secret arcsuite_password,type=mount,target=/run/secrets/arcsuite_password \
  --secret adapter_token,type=mount,target=/run/secrets/adapter_token \
  -v arcsuite-mcp-shared:/shared:rw \
  -e ARCSUITE_SOAP_ENDPOINT="$ARCSUITE_SOAP_ENDPOINT" \
  -e ARCSUITE_USERNAME="$ARCSUITE_USERNAME" \
  -e ARCSUITE_PASSWORD_FILE=/run/secrets/arcsuite_password \
  -e ARCSUITE_ADAPTER_INTERNAL_TOKEN_FILE=/run/secrets/adapter_token \
  -e ARCSUITE_ADAPTER_BIND_HOST=0.0.0.0 \
  -e ARCSUITE_ADAPTER_PORT=18080 \
  -e MCP_TEMP_DIR=/shared \
  "arcsuite-mcp-adapter:$IMAGE_TAG"

podman run -d --name arcsuite-mcp --network arcsuite-mcp-net \
  --restart=always \
  --secret adapter_token,type=mount,target=/run/secrets/adapter_token \
  --secret mcp_tokens,type=mount,target=/run/secrets/mcp_tokens \
  --secret cursor_hmac,type=mount,target=/run/secrets/cursor_hmac \
  -v "$PWD/config/scopes.yaml:/app/config/scopes.yaml:ro,Z" \
  -v arcsuite-mcp-shared:/shared:rw \
  -v arcsuite-mcp-logs:/var/log/arcsuite-mcp:rw \
  -e ARCSUITE_ADAPTER_BASE_URL=http://arcsuite-mcp-adapter:18080 \
  -e ARCSUITE_ADAPTER_INTERNAL_TOKEN_FILE=/run/secrets/adapter_token \
  -e ARCSUITE_MCP_CLIENT_TOKENS_JSON_FILE=/run/secrets/mcp_tokens \
  -e MCP_CURSOR_HMAC_SECRET_FILE=/run/secrets/cursor_hmac \
  -e MCP_SCOPES_FILE=/app/config/scopes.yaml \
  -e MCP_SHARED_TEMP_DIR=/shared \
  -e MCP_AUDIT_LOG_PATH=/var/log/arcsuite-mcp/audit.jsonl \
  -e MCP_ALLOWED_HOSTNAMES=arcsuite-mcp,localhost,127.0.0.1 \
  -e MCP_ALLOWED_ORIGIN_HOSTNAMES=arcsuite-mcp,localhost,127.0.0.1 \
  -e MCP_VALIDATE_ON_STARTUP=true \
  "arcsuite-mcp:$IMAGE_TAG"

# Do not publish -p 8080 unless host access is explicitly required and the
# Host/Origin allowlists plus an external TLS/authentication boundary are set.
