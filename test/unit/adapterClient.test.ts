import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { HttpArcSuiteAdapterClient } from "../../src/arcsuite/soapAdapterClient.ts";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server has no address");
  return address.port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("gateway-to-adapter requests reject redirects before an internal token can follow", async () => {
  let forwardedToken: string | undefined;
  const capture = createServer((req, res) => {
    forwardedToken = req.headers["x-internal-token"] as string | undefined;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ minVersion: "synthetic" }));
  });
  const capturePort = await listen(capture);
  const redirect = createServer((_req, res) => {
    res.statusCode = 302;
    res.setHeader("location", `http://127.0.0.1:${capturePort}/internal/version`);
    res.end();
  });
  const redirectPort = await listen(redirect);

  try {
    const client = new HttpArcSuiteAdapterClient(`http://127.0.0.1:${redirectPort}`, "synthetic-internal-token");
    await assert.rejects(
      client.version(),
      (error: any) => error?.code === "ARCSUITE_UPSTREAM_ERROR" && error?.message === "Adapter request failed"
    );
    assert.equal(forwardedToken, undefined);
  } finally {
    await close(redirect);
    await close(capture);
  }
});

test("adapter client rejects an oversized declared response before materialization", async () => {
  const server = createServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader("content-length", String(8 * 1024 * 1024 + 1));
    res.end();
  });
  const port = await listen(server);
  try {
    const client = new HttpArcSuiteAdapterClient(`http://127.0.0.1:${port}`, "synthetic-internal-token");
    await assert.rejects(client.version(), (error: any) => error?.code === "ARCSUITE_LIMIT_EXCEEDED");
  } finally {
    await close(server);
  }
});
