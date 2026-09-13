import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { toolInputSchemas } from "./mcp/sdkSchemas.ts";

export const CONFIG_LIMITS = Object.freeze({
  maxRequestBytes: 4 * 1024 * 1024,
  maxContentBytes: 100 * 1024 * 1024,
  maxExtractedChars: 1_000_000,
  maxReadChars: 50_000,
  maxSearchLimit: 50,
  maxHardReferenceCandidates: 1000,
  maxBatchIds: 100,
  maxCursorTtlSeconds: 86_400,
  maxPagingSnapshotIds: 5_000,
  maxPagingSnapshots: 1_000,
  maxPagingSnapshotsPerClient: 100,
  maxPagingTotalIds: 100_000,
  maxContentCacheEntries: 1_000,
  maxContentCacheEntriesPerClient: 100,
  maxContentCacheBytes: 256 * 1024 * 1024,
  maxRequestsPerMinute: 100_000,
  maxBurst: 1_000
});

export type TokenProfile = {
  tokenSha256: string;
  clientProfileId: string;
  allowedScopes: string[];
  allowedTools: string[];
  rateLimit: { requestsPerMinute: number; burst: number };
};

export type AppConfig = {
  bindHost: string;
  port: number;
  allowedHostnames: string[];
  allowedOriginHostnames: string[];
  adapterMode: "http" | "mock";
  adapterBaseUrl: string;
  adapterInternalToken: string;
  scopesFile: string;
  tokenProfiles: TokenProfile[];
  searchDefaultLimit: number;
  searchMaxLimit: number;
  hardReferenceMaxCandidates: number;
  batchMaxIds: number;
  readDefaultMaxChars: number;
  readMaxChars: number;
  maxRequestBytes: number;
  maxContentBytes: number;
  maxExtractedChars: number;
  sharedTempDir: string;
  auditLogPath: string;
  cursorSecret: Buffer;
  cursorTtlSeconds: number;
  pagingTtlSeconds: number;
  pagingSnapshotMaxIds: number;
  pagingSnapshotMaxSnapshots: number;
  pagingSnapshotMaxSnapshotsPerClient: number;
  pagingSnapshotMaxTotalIds: number;
  contentCacheTtlSeconds: number;
  contentCacheMaxEntries: number;
  contentCacheMaxEntriesPerClient: number;
  contentCacheMaxBytes: number;
  validateOnStartup: boolean;
};

function readSecretFile(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return readFileSync(path, "utf8").trim();
}

function loadTokenProfiles(env: NodeJS.ProcessEnv): TokenProfile[] {
  const file = env.ARCSUITE_MCP_CLIENT_TOKENS_JSON_FILE;
  const inline = env.ARCSUITE_MCP_CLIENT_TOKENS_JSON;
  let raw: string | undefined;
  if (file) raw = readFileSync(file, "utf8");
  else if (inline) raw = inline;
  if (!raw) {
    const dev = env.MCP_DEV_BEARER_TOKEN;
    if (dev && env.NODE_ENV !== "production") {
      return [{
        tokenSha256: createHash("sha256").update(dev).digest("hex"),
        clientProfileId: "dev-profile",
        allowedScopes: ["example_documents"],
        allowedTools: [
          "arcsuite_describe_capabilities",
          "arcsuite_search_documents",
          "arcsuite_get_document",
          "arcsuite_get_documents",
          "arcsuite_list_folder",
          "arcsuite_list_document_revisions",
          "arcsuite_get_document_content_info",
          "arcsuite_read_document",
          "arcsuite_list_hard_references",
          "arcsuite_validate_document_integrity"
        ],
        rateLimit: { requestsPerMinute: 120, burst: 30 }
      }];
    }
    throw new Error("ARCSUITE_MCP_CLIENT_TOKENS_JSON_FILE or ARCSUITE_MCP_CLIENT_TOKENS_JSON is required");
  }
  const parsed = JSON.parse(raw) as { tokens?: unknown };
  if (!Array.isArray(parsed.tokens) || !parsed.tokens.length) throw new Error("Token config must contain non-empty tokens[]");
  const knownTools = new Set(Object.keys(toolInputSchemas));
  const profileIds = new Set<string>();
  const profiles: TokenProfile[] = [];
  for (const [index, rawProfile] of parsed.tokens.entries()) {
    if (!rawProfile || typeof rawProfile !== "object" || Array.isArray(rawProfile)) throw new Error(`Invalid token profile at index ${index}`);
    const profile = rawProfile as Record<string, unknown>;
    const tokenSha256 = profile.tokenSha256;
    const clientProfileId = profile.clientProfileId;
    if (typeof tokenSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(tokenSha256)) throw new Error(`Invalid tokenSha256 at index ${index}`);
    if (typeof clientProfileId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(clientProfileId)) throw new Error(`Invalid clientProfileId at index ${index}`);
    if (profileIds.has(clientProfileId)) throw new Error(`Duplicate clientProfileId: ${clientProfileId}`);
    profileIds.add(clientProfileId);

    const allowedScopes = stringArray(profile.allowedScopes, `allowedScopes for ${clientProfileId}`, /^[a-z][a-z0-9_]{0,63}$/);
    const allowedTools = stringArray(profile.allowedTools, `allowedTools for ${clientProfileId}`, /^[a-z][a-z0-9_]{0,127}$/);
    for (const tool of allowedTools) if (!knownTools.has(tool)) throw new Error(`Unknown allowed tool ${tool} for ${clientProfileId}`);

    if (!profile.rateLimit || typeof profile.rateLimit !== "object" || Array.isArray(profile.rateLimit)) throw new Error(`Invalid rateLimit for ${clientProfileId}`);
    const rateLimit = profile.rateLimit as Record<string, unknown>;
    const requestsPerMinute = boundedInteger(rateLimit.requestsPerMinute, `rateLimit.requestsPerMinute for ${clientProfileId}`, 1, CONFIG_LIMITS.maxRequestsPerMinute);
    const burst = boundedInteger(rateLimit.burst, `rateLimit.burst for ${clientProfileId}`, 1, CONFIG_LIMITS.maxBurst);
    profiles.push({ tokenSha256, clientProfileId, allowedScopes, allowedTools, rateLimit: { requestsPerMinute, burst } });
  }
  return profiles;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const production = env.NODE_ENV === "production";
  const mode = (env.ARCSUITE_ADAPTER_MODE ?? "http") as "http" | "mock";
  if (mode !== "http" && mode !== "mock") throw new Error("ARCSUITE_ADAPTER_MODE must be http or mock");
  let cursorSecret: Buffer;
  const cursorSecretFile = readSecretFile(env.MCP_CURSOR_HMAC_SECRET_FILE);
  const cursorSecretText = production ? cursorSecretFile : cursorSecretFile ?? env.MCP_CURSOR_HMAC_SECRET;
  if (cursorSecretText) cursorSecret = Buffer.from(cursorSecretText, "utf8");
  else if (production) throw new Error("MCP_CURSOR_HMAC_SECRET_FILE is required in production");
  else cursorSecret = randomBytes(32);

  const adapterInternalToken = readSecretFile(env.ARCSUITE_ADAPTER_INTERNAL_TOKEN_FILE) ?? env.ARCSUITE_ADAPTER_INTERNAL_TOKEN ?? "";
  if (mode === "http" && !adapterInternalToken) throw new Error("ARCSUITE_ADAPTER_INTERNAL_TOKEN_FILE/TOKEN is required for http adapter mode");

  const port = positiveInteger(env.ARCSUITE_MCP_PORT ?? "8080", "ARCSUITE_MCP_PORT");
  const searchDefaultLimit = positiveInteger(env.MCP_SEARCH_DEFAULT_LIMIT ?? "20", "MCP_SEARCH_DEFAULT_LIMIT", CONFIG_LIMITS.maxSearchLimit);
  const searchMaxLimit = positiveInteger(env.MCP_SEARCH_MAX_LIMIT ?? "50", "MCP_SEARCH_MAX_LIMIT", CONFIG_LIMITS.maxSearchLimit);
  if (searchDefaultLimit > searchMaxLimit) throw new Error("MCP_SEARCH_DEFAULT_LIMIT cannot exceed MCP_SEARCH_MAX_LIMIT");
  const batchMaxIds = positiveInteger(env.MCP_BATCH_MAX_IDS ?? "50", "MCP_BATCH_MAX_IDS", CONFIG_LIMITS.maxBatchIds);
  const readDefaultMaxChars = positiveInteger(env.MCP_READ_DEFAULT_MAX_CHARS ?? "20000", "MCP_READ_DEFAULT_MAX_CHARS", CONFIG_LIMITS.maxReadChars);
  const readMaxChars = positiveInteger(env.MCP_READ_MAX_CHARS ?? "50000", "MCP_READ_MAX_CHARS", CONFIG_LIMITS.maxReadChars);
  if (readDefaultMaxChars > readMaxChars) throw new Error("MCP_READ_DEFAULT_MAX_CHARS cannot exceed MCP_READ_MAX_CHARS");
  const maxRequestBytes = positiveInteger(env.MCP_MAX_REQUEST_BYTES ?? "1048576", "MCP_MAX_REQUEST_BYTES", CONFIG_LIMITS.maxRequestBytes);
  const maxContentBytes = positiveInteger(env.MCP_MAX_CONTENT_BYTES ?? "52428800", "MCP_MAX_CONTENT_BYTES", CONFIG_LIMITS.maxContentBytes);
  const maxExtractedChars = positiveInteger(env.MCP_MAX_EXTRACTED_CHARS ?? "200000", "MCP_MAX_EXTRACTED_CHARS", CONFIG_LIMITS.maxExtractedChars);
  const cursorTtlSeconds = positiveInteger(env.MCP_CURSOR_TTL_SECONDS ?? "600", "MCP_CURSOR_TTL_SECONDS", CONFIG_LIMITS.maxCursorTtlSeconds);
  const pagingTtlSeconds = positiveInteger(env.MCP_PAGING_TTL_SECONDS ?? "600", "MCP_PAGING_TTL_SECONDS", CONFIG_LIMITS.maxCursorTtlSeconds);
  const pagingSnapshotMaxIds = positiveInteger(env.MCP_PAGING_SNAPSHOT_MAX_IDS ?? "1000", "MCP_PAGING_SNAPSHOT_MAX_IDS", CONFIG_LIMITS.maxPagingSnapshotIds);
  const hardReferenceMaxCandidates = positiveInteger(
    env.MCP_HARD_REFERENCE_MAX_CANDIDATES ?? String(Math.min(200, pagingSnapshotMaxIds)),
    "MCP_HARD_REFERENCE_MAX_CANDIDATES",
    CONFIG_LIMITS.maxHardReferenceCandidates
  );
  const pagingSnapshotMaxSnapshots = positiveInteger(env.MCP_PAGING_MAX_SNAPSHOTS ?? "100", "MCP_PAGING_MAX_SNAPSHOTS", CONFIG_LIMITS.maxPagingSnapshots);
  const pagingSnapshotMaxSnapshotsPerClient = positiveInteger(env.MCP_PAGING_MAX_SNAPSHOTS_PER_CLIENT ?? "10", "MCP_PAGING_MAX_SNAPSHOTS_PER_CLIENT", CONFIG_LIMITS.maxPagingSnapshotsPerClient);
  const pagingSnapshotMaxTotalIds = positiveInteger(env.MCP_PAGING_MAX_TOTAL_IDS ?? "10000", "MCP_PAGING_MAX_TOTAL_IDS", CONFIG_LIMITS.maxPagingTotalIds);
  if (pagingSnapshotMaxSnapshotsPerClient > pagingSnapshotMaxSnapshots) throw new Error("MCP_PAGING_MAX_SNAPSHOTS_PER_CLIENT cannot exceed MCP_PAGING_MAX_SNAPSHOTS");
  if (pagingSnapshotMaxIds > pagingSnapshotMaxTotalIds) throw new Error("MCP_PAGING_SNAPSHOT_MAX_IDS cannot exceed MCP_PAGING_MAX_TOTAL_IDS");
  if (searchMaxLimit > pagingSnapshotMaxIds) throw new Error("MCP_SEARCH_MAX_LIMIT cannot exceed MCP_PAGING_SNAPSHOT_MAX_IDS");
  if (hardReferenceMaxCandidates > pagingSnapshotMaxIds) throw new Error("MCP_HARD_REFERENCE_MAX_CANDIDATES cannot exceed MCP_PAGING_SNAPSHOT_MAX_IDS");
  const contentCacheTtlSeconds = positiveInteger(env.MCP_CONTENT_CACHE_TTL_SECONDS ?? "600", "MCP_CONTENT_CACHE_TTL_SECONDS", CONFIG_LIMITS.maxCursorTtlSeconds);
  const contentCacheMaxEntries = positiveInteger(env.MCP_CONTENT_CACHE_MAX_ENTRIES ?? "64", "MCP_CONTENT_CACHE_MAX_ENTRIES", CONFIG_LIMITS.maxContentCacheEntries);
  const contentCacheMaxEntriesPerClient = positiveInteger(env.MCP_CONTENT_CACHE_MAX_ENTRIES_PER_CLIENT ?? "16", "MCP_CONTENT_CACHE_MAX_ENTRIES_PER_CLIENT", CONFIG_LIMITS.maxContentCacheEntriesPerClient);
  if (contentCacheMaxEntriesPerClient > contentCacheMaxEntries) throw new Error("MCP_CONTENT_CACHE_MAX_ENTRIES_PER_CLIENT cannot exceed MCP_CONTENT_CACHE_MAX_ENTRIES");
  const contentCacheMaxBytes = positiveInteger(env.MCP_CONTENT_CACHE_MAX_BYTES ?? "16777216", "MCP_CONTENT_CACHE_MAX_BYTES", CONFIG_LIMITS.maxContentCacheBytes);
  const allowedHostnames = csv(env.MCP_ALLOWED_HOSTNAMES ?? "localhost,127.0.0.1");
  const allowedOriginHostnames = csv(env.MCP_ALLOWED_ORIGIN_HOSTNAMES ?? "localhost,127.0.0.1");
  const adapterBaseUrl = normalizeAdapterBaseUrl(env.ARCSUITE_ADAPTER_BASE_URL ?? "http://127.0.0.1:18080");
  if (mode === "http" && adapterInternalToken.length < 16) throw new Error("ARCSUITE_ADAPTER_INTERNAL_TOKEN must be at least 16 characters");

  return {
    bindHost: env.ARCSUITE_MCP_BIND_HOST ?? "127.0.0.1",
    port,
    allowedHostnames,
    allowedOriginHostnames,
    adapterMode: mode,
    adapterBaseUrl,
    adapterInternalToken,
    scopesFile: resolve(env.MCP_SCOPES_FILE ?? (mode === "mock" ? "config/scopes.mock.yaml" : "config/scopes.yaml")),
    tokenProfiles: loadTokenProfiles(env),
    searchDefaultLimit,
    searchMaxLimit,
    hardReferenceMaxCandidates,
    batchMaxIds,
    readDefaultMaxChars,
    readMaxChars,
    maxRequestBytes,
    maxContentBytes,
    maxExtractedChars,
    sharedTempDir: resolve(env.MCP_SHARED_TEMP_DIR ?? "/tmp/arcsuite-mcp-shared"),
    auditLogPath: resolve(env.MCP_AUDIT_LOG_PATH ?? "/tmp/arcsuite-mcp-audit.jsonl"),
    cursorSecret,
    cursorTtlSeconds,
    pagingTtlSeconds,
    pagingSnapshotMaxIds,
    pagingSnapshotMaxSnapshots,
    pagingSnapshotMaxSnapshotsPerClient,
    pagingSnapshotMaxTotalIds,
    contentCacheTtlSeconds,
    contentCacheMaxEntries,
    contentCacheMaxEntriesPerClient,
    contentCacheMaxBytes,
    validateOnStartup: (env.MCP_VALIDATE_ON_STARTUP ?? "true").toLowerCase() !== "false"
  };
}

function positiveInteger(value: string, name: string, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new Error(`${name} must be a positive integer <= ${max}`);
  return parsed;
}

function boundedInteger(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${name} must be an integer ${min}..${max}`);
  return value as number;
}

function stringArray(value: unknown, name: string, pattern: RegExp): string[] {
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== "string" || !pattern.test(item))) throw new Error(`${name} must be a non-empty string array`);
  return [...new Set(value as string[])];
}

function normalizeAdapterBaseUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error("ARCSUITE_ADAPTER_BASE_URL must be an absolute URL"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("ARCSUITE_ADAPTER_BASE_URL must use http:// or https://");
  if (parsed.username || parsed.password) throw new Error("ARCSUITE_ADAPTER_BASE_URL must not contain credentials");
  if (parsed.search || parsed.hash) throw new Error("ARCSUITE_ADAPTER_BASE_URL must not contain query or fragment");
  return parsed.toString().replace(/\/+$/, "");
}

function csv(value: string): string[] {
  const values = value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (!values.length) throw new Error("Host allowlists cannot be empty");
  return [...new Set(values)];
}
