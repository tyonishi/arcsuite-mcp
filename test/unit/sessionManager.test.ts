import test from "node:test";
import assert from "node:assert/strict";
import { AdapterSessionManager } from "../../src/arcsuite/sessionManager.ts";
import { ArcSuiteAdapterError } from "../../src/arcsuite/errors.ts";
import type { ArcSuiteAdapterClient } from "../../src/arcsuite/soapAdapterClient.ts";

function fakeAdapter(): ArcSuiteAdapterClient & { logins: number; logouts: number } {
  const a: any = {
    logins: 0, logouts: 0,
    health: async () => true, version: async () => ({}),
    login: async () => { a.logins++; }, logout: async () => { a.logouts++; },
    validateSchema: async () => ({ ok: true, version: {}, cabinet: {}, attributes: [], errors: [] }),
    search: async () => [], list: async () => [], get: async () => { throw new Error(); }, revisions: async () => [], content: async () => { throw new Error(); }
  };
  return a;
}

test("read retries once only for session expiration", async () => {
  const adapter = fakeAdapter();
  const sessions = new AdapterSessionManager(adapter);
  let calls = 0;
  const result = await sessions.executeRead("p", async () => {
    calls++;
    if (calls === 1) throw new ArcSuiteAdapterError("ARCSUITE_SESSION_EXPIRED", "expired", { retryable: true });
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 2);
  assert.equal(adapter.logins, 1);
});

test("read does not retry arbitrary upstream error", async () => {
  const adapter = fakeAdapter();
  const sessions = new AdapterSessionManager(adapter);
  let calls = 0;
  await assert.rejects(() => sessions.executeRead("p", async () => {
    calls++;
    throw new ArcSuiteAdapterError("ARCSUITE_UPSTREAM_ERROR", "bad");
  }));
  assert.equal(calls, 1);
});
