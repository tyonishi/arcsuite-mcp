import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildRuntime } from "../../src/server.ts";

function listen(server: Server): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("server did not expose a TCP address"));
        return;
      }
      resolvePort(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(payload);
}

function dataTypeFor(name: string): string {
  return {
    "system:name": "STRING_TYPE",
    "system:objecttype": "STRING_TYPE",
    "system:status": "I18N_STRING_TYPE",
    "system:modifiedon": "DATE_TIME_TYPE",
    "system:modifiedby": "STRING_TYPE",
    "system:currentrevisionnumber": "INT_TYPE",
    "system:contentlabellist": "I18N_STRING_TYPE",
    "user:example_document_number": "STRING_TYPE",
    "user:page_count": "LONG_TYPE",
    "user:approved": "BOOLEAN_TYPE",
    "user:quality_score": "DOUBLE_TYPE",
    "user:published_on": "DATE_TYPE"
  }[name] ?? "STRING_TYPE";
}

test("startup validation retries until a slow adapter becomes ready", async () => {
  let healthCalls = 0;
  const adapterServer = createServer((req, res) => {
    if (req.url === "/internal/healthz") {
      healthCalls += 1;
      json(res, healthCalls === 1 ? 503 : 200, { ok: healthCalls > 1 });
      return;
    }
    if (req.url !== "/internal/schema/validate") {
      json(res, 404, { error: "not_found" });
      return;
    }

    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { body += chunk; });
    req.on("end", () => {
      const request = JSON.parse(body) as { attributes?: Array<{ attrId: { ns: string; name: string } }> };
      const attributes = (request.attributes ?? []).map(({ attrId }) => ({
        ...attrId,
        dataType: dataTypeFor(attrId.name),
        searchable: true,
        sortable: true,
        ...(attrId.name === "system:status" ? {
          enumerated: true,
          enumLabels: [{ ns: "rep", name: "ACTIVE" }, { ns: "rep", name: "RETIRED" }]
        } : {})
      }));
      json(res, 200, {
        ok: true,
        version: { minVersion: "4.0.0.0", curVersion: "4.0.0.0" },
        cabinet: { id: "rep:mock:EXAMPLE_CABINET" },
        attributes,
        errors: []
      });
    });
  });
  const adapterPort = await listen(adapterServer);
  const workDir = await mkdtemp(join(tmpdir(), "arcsuite-mcp-startup-validation-"));
  let runtime: Awaited<ReturnType<typeof buildRuntime>> | undefined;
  try {
    runtime = await buildRuntime({
      ...process.env,
      NODE_ENV: "test",
      ARCSUITE_ADAPTER_MODE: "http",
      ARCSUITE_ADAPTER_BASE_URL: `http://127.0.0.1:${adapterPort}`,
      ARCSUITE_ADAPTER_INTERNAL_TOKEN: "TEST_ADAPTER_TOKEN",
      MCP_DEV_BEARER_TOKEN: "TEST_BEARER_TOKEN",
      MCP_SCOPES_FILE: resolve("config/scopes.mock.yaml"),
      MCP_SHARED_TEMP_DIR: join(workDir, "shared"),
      MCP_AUDIT_LOG_PATH: join(workDir, "audit.jsonl"),
      MCP_CURSOR_HMAC_SECRET: "0123456789abcdef0123456789abcdef",
      MCP_VALIDATE_ON_STARTUP: "true"
    }, { startupValidationRetryDelayMs: 10 });
    await listen(runtime.server);

    let readyStatus = 503;
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      const response = await fetch(`http://127.0.0.1:${(runtime.server.address() as import("node:net").AddressInfo).port}/readyz`);
      readyStatus = response.status;
      if (readyStatus === 200) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }

    assert.equal(readyStatus, 200);
    assert.ok(healthCalls >= 2);
  } finally {
    runtime?.stopValidationRetry();
    if (runtime) await close(runtime.server);
    await close(adapterServer);
  }
});
