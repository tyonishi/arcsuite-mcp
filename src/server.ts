import { chmod, mkdir } from "node:fs/promises";
import { loadConfig } from "./config.ts";
import { ProfileStore, RateLimiter } from "./mcp/auth.ts";
import { createMcpHttpServer } from "./mcp/protocol.ts";
import { ScopeRegistry } from "./semantic/scopeRegistry.ts";
import { HttpArcSuiteAdapterClient, MockArcSuiteAdapterClient, type ArcSuiteAdapterClient } from "./arcsuite/soapAdapterClient.ts";
import { AdapterSessionManager } from "./arcsuite/sessionManager.ts";
import { CursorManager } from "./content/cursor.ts";
import { ContentBridge } from "./content/contentBridge.ts";
import { AuditLogger } from "./audit/auditLogger.ts";
import { ToolRegistry } from "./mcp/tools.ts";
import { assertOperationAllowlistSafe } from "./arcsuite/operationAllowlist.ts";

export async function buildRuntime(env: NodeJS.ProcessEnv = process.env) {
  assertOperationAllowlistSafe();
  const config = loadConfig(env);
  await mkdir(config.sharedTempDir, { recursive: true, mode: 0o700 });
  await chmod(config.sharedTempDir, 0o700);
  const scopes = ScopeRegistry.load(config.scopesFile);
  const profiles = new ProfileStore(config.tokenProfiles);
  const adapter: ArcSuiteAdapterClient = config.adapterMode === "mock"
    ? new MockArcSuiteAdapterClient(config.sharedTempDir)
    : new HttpArcSuiteAdapterClient(config.adapterBaseUrl, config.adapterInternalToken);
  const sessions = new AdapterSessionManager(adapter);
  const cursors = new CursorManager(config.cursorSecret, config.cursorTtlSeconds);
  const bridge = new ContentBridge(config.sharedTempDir, cursors, {
    maxContentBytes: config.maxContentBytes,
    maxExtractedChars: config.maxExtractedChars
  });
  const audit = new AuditLogger(config.auditLogPath);
  const tools = new ToolRegistry(config, scopes, adapter, sessions, bridge, audit);
  let readyState: { ok: boolean; message?: string } = { ok: !config.validateOnStartup, message: config.validateOnStartup ? "validation pending" : undefined };

  const validate = async () => {
    try {
      const first = profiles.first();
      if (!first) throw new Error("No client profiles configured");
      if (!(await adapter.health())) throw new Error("SOAP adapter is not healthy");
      await scopes.validateAgainstAdapter(adapter, first.clientProfileId);
      readyState = { ok: true };
    } catch (error) {
      readyState = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  };
  if (config.validateOnStartup) await validate();

  const server = createMcpHttpServer({
    profiles,
    rateLimiter: new RateLimiter(),
    tools,
    allowedHostnames: config.allowedHostnames,
    allowedOriginHostnames: config.allowedOriginHostnames,
    maxRequestBytes: config.maxRequestBytes,
    health: () => adapter.health(),
    ready: async () => readyState
  });
  return { config, scopes, adapter, tools, server, validate };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const runtime = await buildRuntime();
  runtime.server.listen(runtime.config.port, runtime.config.bindHost, () => {
    console.log(`ArcSuite MCP listening on http://${runtime.config.bindHost}:${runtime.config.port}`);
  });
  const shutdown = async () => {
    runtime.server.close();
    process.exitCode = 0;
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
