FROM node:26.8-bookworm-slim@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae

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
