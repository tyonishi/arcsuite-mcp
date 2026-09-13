import test from "node:test";
import assert from "node:assert/strict";
import { AdapterSessionManager } from "../../src/arcsuite/sessionManager.ts";
import { ArcSuiteAdapterError } from "../../src/arcsuite/errors.ts";

test("gateway propagates session expiration to the Java retry owner without replay", async () => {
  const sessions = new AdapterSessionManager();
  let calls = 0;
  const expired = new ArcSuiteAdapterError("ARCSUITE_SESSION_EXPIRED", "expired", { retryable: true });
  await assert.rejects(() => sessions.executeRead("p", async () => {
    calls++;
    throw expired;
  }), (error: unknown) => error === expired);
  assert.equal(calls, 1);
});

test("successful gateway reads execute the adapter operation once", async () => {
  const sessions = new AdapterSessionManager();
  let calls = 0;
  const result = await sessions.executeRead("p", async () => {
    calls++;
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

test("read does not retry arbitrary upstream error", async () => {
  const sessions = new AdapterSessionManager();
  let calls = 0;
  await assert.rejects(() => sessions.executeRead("p", async () => {
    calls++;
    throw new ArcSuiteAdapterError("ARCSUITE_UPSTREAM_ERROR", "bad");
  }));
  assert.equal(calls, 1);
});
