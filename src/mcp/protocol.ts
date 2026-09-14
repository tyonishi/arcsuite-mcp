import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createMcpHandler, McpServer, type AuthInfo } from "@modelcontextprotocol/server";
import { hostHeaderValidation, originValidation, toNodeHandler } from "@modelcontextprotocol/node";
import type { ProfileStore, RateLimiter } from "./auth.ts";
import type { ToolRegistry } from "./tools.ts";
import { toMcpToolError } from "./errors.ts";
import { toolInputSchemaForProfile, type ToolInputName, type ToolSchemaLimits } from "./sdkSchemas.ts";
import { readJsonBody } from "../util/http.ts";

export type McpHttpServerOptions = {
  profiles: ProfileStore;
  rateLimiter: RateLimiter;
  tools: ToolRegistry;
  health: () => Promise<boolean>;
  ready: () => Promise<{ ok: boolean; message?: string }>;
  allowedHostnames: string[];
  allowedOriginHostnames: string[];
  maxRequestBytes: number;
  schemaLimits: ToolSchemaLimits;
};

type AuthenticatedRequest = IncomingMessage & { auth?: AuthInfo };

export function createMcpHttpServer(options: McpHttpServerOptions) {
  const schemaLimits = Object.freeze({ ...options.schemaLimits });
  const handler = createMcpHandler((context) => {
    const profileId = context.authInfo?.extra?.clientProfileId;
    const profile = typeof profileId === "string" ? options.profiles.get(profileId) : undefined;
    if (!profile) throw new Error("authenticated profile is unavailable");

    const server = new McpServer({ name: "arcsuite-mcp", version: "0.2.0" });
    for (const definition of options.tools.list(profile)) {
      const name = definition.name as ToolInputName;
      const schema = toolInputSchemaForProfile(name, profile.allowedScopes, schemaLimits);
      if (!schema) continue;
      server.registerTool(definition.name, {
        description: definition.description,
        inputSchema: schema
      }, async (args: unknown) => {
        try {
          return await options.tools.call(profile, definition.name, args);
        } catch (error) {
          const mapped = toMcpToolError(error);
          return {
            isError: true,
            content: [{
              type: "text" as const,
              text: JSON.stringify({ code: mapped.stableCode, category: mapped.category, retryable: mapped.retryable })
            }]
          };
        }
      });
    }
    return server;
  }, {
    legacy: "stateless",
    responseMode: "auto",
    onerror: (error) => console.error("MCP transport error", error.message)
  });

  const nodeHandler = toNodeHandler(handler, { onerror: (error) => console.error("MCP HTTP error", error.message) });
  const validateHost = hostHeaderValidation(options.allowedHostnames);
  const validateOrigin = originValidation(options.allowedOriginHostnames);

  const server = createServer((req, res) => {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

    if (pathname === "/healthz" && req.method === "GET") {
      void respondHealth(res, options.health);
      return;
    }
    if (pathname === "/readyz" && req.method === "GET") {
      void respondReady(res, options.ready);
      return;
    }
    if (pathname !== "/mcp") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    const profile = options.profiles.authenticate(req);
    if (!profile) {
      sendJson(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
      return;
    }
    if (!options.rateLimiter.allow(profile)) {
      sendJson(res, 429, { error: "rate_limited" }, { "retry-after": "60" });
      return;
    }

    const authenticated = req as AuthenticatedRequest;
    authenticated.auth = {
      token: "validated",
      clientId: profile.clientProfileId,
      scopes: profile.allowedScopes,
      extra: { clientProfileId: profile.clientProfileId }
    };
    void dispatchMcpRequest(authenticated, res, nodeHandler, options.maxRequestBytes);
  });

  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  return server;
}

async function dispatchMcpRequest(
  req: AuthenticatedRequest,
  res: ServerResponse,
  nodeHandler: ReturnType<typeof toNodeHandler>,
  maxRequestBytes: number
): Promise<void> {
  try {
    const parsedBody = req.method === "POST" ? await readJsonBody(req, maxRequestBytes) : undefined;
    await nodeHandler(req, res, parsedBody);
  } catch (error) {
    const message = error instanceof Error ? error.message : "REQUEST_BODY_ERROR";
    if (message === "REQUEST_TOO_LARGE") {
      sendJsonRpcError(res, 413, -32600, "Request body too large");
      req.destroy();
      return;
    }
    if (message === "INVALID_CONTENT_LENGTH") {
      sendJsonRpcError(res, 400, -32600, "Invalid Content-Length");
      req.destroy();
      return;
    }
    if (error instanceof SyntaxError) {
      sendJsonRpcError(res, 400, -32700, "Parse error: invalid JSON");
      return;
    }
    if (!res.headersSent) sendJsonRpcError(res, 400, -32700, "Parse error: request body could not be read");
  }
}

async function respondHealth(res: ServerResponse, health: () => Promise<boolean>): Promise<void> {
  try {
    const ok = await health();
    sendJson(res, ok ? 200 : 503, { ok });
  } catch {
    sendJson(res, 503, { ok: false });
  }
}

async function respondReady(res: ServerResponse, ready: () => Promise<{ ok: boolean; message?: string }>): Promise<void> {
  try {
    const state = await ready();
    sendJson(res, state.ok ? 200 : 503, { ok: state.ok });
  } catch {
    sendJson(res, 503, { ok: false });
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...extraHeaders });
  res.end(JSON.stringify(body));
}

function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  if (res.headersSent) return;
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null });
}
