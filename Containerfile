FROM node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

RUN apt-get update \
    && apt-get install --no-install-recommends -y python3 poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts/ooxml_extract.py ./scripts/ooxml_extract.py
COPY config/scopes.example.yaml ./config/scopes.example.yaml

RUN install -d -m 700 /shared /var/log/arcsuite-mcp \
    && useradd --create-home --uid 10001 --shell /usr/sbin/nologin arcsuite \
    && chown -R arcsuite:arcsuite /app /shared /var/log/arcsuite-mcp
USER arcsuite

ENV ARCSUITE_MCP_BIND_HOST=0.0.0.0 \
    ARCSUITE_MCP_PORT=8080 \
    MCP_SHARED_TEMP_DIR=/shared \
    MCP_AUDIT_LOG_PATH=/var/log/arcsuite-mcp/audit.jsonl

EXPOSE 8080
CMD ["node", "--experimental-strip-types", "src/server.ts"]
