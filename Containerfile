FROM node:26.10.0-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2

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
