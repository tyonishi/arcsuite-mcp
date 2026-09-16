import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  InMemoryHandleStore,
  OpaqueHandleService,
  type HandlePolicyContext,
  type OpaqueHandleRecord
} from "../../src/mcp/opaqueHandles.ts";
import type { SemanticScope } from "../../src/semantic/scopeRegistry.ts";

const scope: SemanticScope = {
  description: "Synthetic documents",
  enabled: true,
  arcsuite: {
    cabinet_alias: "EXAMPLE_CABINET",
    cabinet_id: "rep:mock:EXAMPLE_CABINET",
    root_object_id: null,
    resolve_references: false
  },
  search: { full_text_modes: ["none", "stemming"] },
  allowed_object_types: ["document"],
  default_attr_ids: [{ ns: "rep", name: "system:name" }],
  semantic_attributes: {
    document_number: {
      attr_id: { ns: "rep", name: "user:example_document_number" },
      type: "string",
      operators: ["eq"]
    }
  }
};

function context(overrides: Partial<HandlePolicyContext["profile"]> = {}): HandlePolicyContext {
  return {
    profile: {
      tokenSha256: createHash("sha256").update("synthetic-token").digest("hex"),
      clientProfileId: "synthetic-profile",
      allowedScopes: ["example_documents"],
      allowedTools: ["arcsuite_search_documents"],
      rateLimit: { requestsPerMinute: 60, burst: 10 },
      ...overrides
    },
    scopeId: "example_documents",
    scope
  };
}

function config(activeKid = "active-1", keys = [
  { kid: "active-1", secret: Buffer.alloc(32, 0x11) }
]) {
  return {
    activeKid,
    keys,
    ttlSeconds: 600,
    capacity: 100,
    capacityPerProfile: 100,
    contractGeneration: 1,
    credentialContextGeneration: 1
  };
}

const searchAuthority = {
  scopeId: "example_documents",
  appliedQuery: {
    operator: "and" as const,
    filters: {
      operator: "and" as const,
      predicates: [{ name: "document_number", type: "string" as const, operator: "eq" as const, value: "DOC-000001" }]
    },
    text: null
  },
  includePath: false,
  pageSize: 20
};

test("opaque handles round-trip all P1 kinds and remain reusable", () => {
  const service = new OpaqueHandleService(config());
  const refs = [
    service.issueSearch(context(), searchAuthority),
    service.issueContinuation(context(), { searchAuthority, cursor: "private-cursor" }),
    service.issueResult(context(), { documentId: "rep:mock:EXAMPLE_CABINET:1001", objectClass: "document" })
  ] as const;

  assert.equal(service.resolve(refs[0], "search", context()).kind, "search");
  assert.equal(service.resolve(refs[1], "continuation", context()).kind, "continuation");
  assert.equal(service.resolve(refs[2], "result", context()).kind, "result");
  assert.deepEqual(service.resolve(refs[2], "result", context()), service.resolve(refs[2], "result", context()));
  assert.equal(new Set(refs).size, 3);
  for (const ref of refs) {
    const envelope = Buffer.from(ref.split(".")[1], "base64url").toString("utf8");
    assert.equal(envelope.includes("private-cursor"), false);
    assert.equal(envelope.includes("rep:mock:EXAMPLE_CABINET:1001"), false);
  }
});

test("public envelope is bounded, authenticated, opaque, and kind-bound", () => {
  const service = new OpaqueHandleService(config());
  const ref = service.issueSearch(context(), searchAuthority);
  assert.ok(ref.length <= 1024);
  for (const privateValue of ["DOC-000001", "example_documents", "synthetic-profile", "rep:mock", "private-cursor"]) {
    assert.equal(ref.includes(privateValue), false);
  }
  const decoded = JSON.parse(Buffer.from(ref.split(".")[1], "base64url").toString("utf8"));
  assert.deepEqual(Object.keys(decoded).sort(), ["exp", "gen", "iat", "k", "kid", "loc", "v"]);
  const decodedText = JSON.stringify(decoded);
  for (const privateValue of ["DOC-000001", "document_number", "example_documents", "synthetic-profile", "rep:mock"]) {
    assert.equal(decodedText.includes(privateValue), false);
  }
  assert.throws(() => service.resolve(ref, "result", context()), refUnavailable);

  const mutations = new Set<string>([
    ref.slice(0, -1),
    `${ref.slice(0, -1)}${ref.endsWith("A") ? "B" : "A"}`,
    `x${ref.slice(1)}`,
    ...[1, 8, Math.floor(ref.length / 2), ref.length - 2].map((index) => `${ref.slice(0, index)}!${ref.slice(index + 1)}`)
  ]);
  for (const mutation of mutations) assert.throws(() => service.resolve(mutation, "search", context()), refUnavailable);
});

test("parser collapses garbage, truncation, unknown version/kid, and oversized input", () => {
  const service = new OpaqueHandleService(config());
  const arbitrary = ["", ".", "garbage", "arh1.a.b", "\u0000", "あ".repeat(20), "x".repeat(1025)];
  for (const value of arbitrary) assert.throws(() => service.resolve(value, "search", context()), refUnavailable);

  const ref = service.issueSearch(context(), searchAuthority);
  const [, body, tag] = ref.split(".");
  const envelope = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  for (const patch of [{ v: 2 }, { kid: "unknown" }]) {
    const changed = Buffer.from(JSON.stringify({ ...envelope, ...patch }), "utf8").toString("base64url");
    assert.throws(() => service.resolve(`arh1.${changed}.${tag}`, "search", context()), refUnavailable);
  }
});

test("expiry, policy mismatch, missing records, and process restart fail closed", () => {
  let now = 1_800_000_000_000;
  const clock = () => now;
  const store = new InMemoryHandleStore<OpaqueHandleRecord>(100, 100, clock);
  const service = new OpaqueHandleService(config(), store, clock);
  const ref = service.issueSearch(context(), searchAuthority);

  assert.throws(() => service.resolve(ref, "search", context({ allowedScopes: ["other_scope"] })), refUnavailable);
  assert.throws(() => service.resolve(ref, "search", context({ clientProfileId: "other-profile" })), refUnavailable);
  assert.throws(() => service.resolve(ref, "search", context({
    tokenSha256: createHash("sha256").update("other-token").digest("hex")
  })), refUnavailable);
  assert.throws(() => new OpaqueHandleService(config(), undefined, clock).resolve(ref, "search", context()), refUnavailable);
  now += 601_000;
  assert.throws(() => service.resolve(ref, "search", context()), refUnavailable);
});

test("key rotation accepts a retained previous key and rejects unknown keys", () => {
  const store = new InMemoryHandleStore<OpaqueHandleRecord>(100, 100);
  const oldService = new OpaqueHandleService(config("old", [{ kid: "old", secret: Buffer.alloc(32, 0x22) }]), store);
  const ref = oldService.issueSearch(context(), searchAuthority);
  const rotated = new OpaqueHandleService(config("new", [
    { kid: "new", secret: Buffer.alloc(32, 0x33) },
    { kid: "old", secret: Buffer.alloc(32, 0x22) }
  ]), store);
  assert.equal(rotated.resolve(ref, "search", context()).kind, "search");
  assert.throws(() => new OpaqueHandleService(config("new", [{ kid: "new", secret: Buffer.alloc(32, 0x33) }]), store).resolve(ref, "search", context()), refUnavailable);
});

test("in-memory handle store is bounded, expires deterministically, prunes, and reads non-destructively", () => {
  let now = 1000;
  const store = new InMemoryHandleStore<string>(2, 2, () => now);
  store.put("a", "A", 2000, "profile-a");
  store.put("b", "B", 3000, "profile-a");
  assert.equal(store.get("a"), "A");
  assert.equal(store.get("a"), "A");
  store.put("c", "C", 4000, "profile-a");
  assert.equal(store.size, 2);
  assert.equal(store.get("b"), undefined);
  now = 2500;
  store.prune();
  assert.equal(store.get("a"), undefined);
  assert.equal(store.get("c"), "C");
  store.delete("c");
  assert.equal(store.get("c"), undefined);
});

test("one profile cannot evict another profile's unexpired opaque handle", () => {
  const service = new OpaqueHandleService({ ...config(), capacity: 3, capacityPerProfile: 3 });
  const victim = context({
    clientProfileId: "synthetic-profile-b",
    tokenSha256: createHash("sha256").update("synthetic-token-b").digest("hex")
  });
  const churner = context({
    clientProfileId: "synthetic-profile-a",
    tokenSha256: createHash("sha256").update("synthetic-token-a").digest("hex")
  });
  const victimRef = service.issueSearch(victim, searchAuthority);
  assert.equal(service.resolve(victimRef, "search", victim).kind, "search");

  const churnerRefs = Array.from({ length: 3 }, () => service.issueSearch(churner, searchAuthority));

  assert.equal(service.resolve(victimRef, "search", victim).kind, "search");
  assert.throws(() => service.resolve(churnerRefs[0], "search", churner), refUnavailable);
  assert.equal(service.resolve(churnerRefs[2], "search", churner).kind, "search");
});

test("profile quota and global pressure evict only the allocating profile", () => {
  const store = new InMemoryHandleStore<string>(4, 2, () => 1_000);
  store.put("b-1", "B1", 10_000, "profile-b");
  store.put("a-1", "A1", 10_000, "profile-a");
  store.put("a-2", "A2", 10_000, "profile-a");
  assert.equal(store.get("a-1"), "A1");
  store.put("a-3", "A3", 10_000, "profile-a");
  assert.equal(store.size, 3);
  assert.equal(store.get("b-1"), "B1");
  assert.equal(store.get("a-2"), undefined, "least-recent same-profile entry must be evicted first");
  assert.equal(store.get("a-1"), "A1");
  assert.equal(store.get("a-3"), "A3");

  store.put("b-2", "B2", 10_000, "profile-b");
  assert.equal(store.size, 4);
  store.put("a-4", "A4", 10_000, "profile-a");
  assert.equal(store.size, 4);
  assert.equal(store.get("b-1"), "B1");
  assert.equal(store.get("b-2"), "B2");
});

test("global-full allocation fails atomically when the caller has no safe eviction candidate", () => {
  const store = new InMemoryHandleStore<string>(3, 3, () => 1_000);
  store.put("b-1", "B1", 10_000, "profile-b");
  store.put("b-2", "B2", 10_000, "profile-b");
  store.put("a-old", "A-old", 10_000, "profile-a");

  assert.throws(() => store.putMany("profile-a", [
    { index: "a-new-1", record: "A-new-1", expiresAtMs: 10_000 },
    { index: "a-new-2", record: "A-new-2", expiresAtMs: 10_000 }
  ]), /capacity unavailable/i);

  assert.equal(store.size, 3);
  assert.equal(store.get("a-old"), "A-old", "failed batch must not evict an existing caller record");
  assert.equal(store.get("a-new-1"), undefined);
  assert.equal(store.get("a-new-2"), undefined);
  assert.equal(store.get("b-1"), "B1");
  assert.equal(store.get("b-2"), "B2");
});

test("expired cross-profile entries are reclaimed before owner quota decisions", () => {
  let now = 1_000;
  const store = new InMemoryHandleStore<string>(2, 1, () => now);
  store.put("expired-b", "B", 1_500, "profile-b");
  now = 2_000;
  store.put("a-1", "A1", 3_000, "profile-a");
  assert.equal(store.size, 1);
  assert.equal(store.get("expired-b"), undefined);
  assert.equal(store.get("a-1"), "A1");
});

test("locators are unique 256-bit random values and are not raw store keys", () => {
  const store = new InMemoryHandleStore<OpaqueHandleRecord>(200, 200);
  const service = new OpaqueHandleService(config(), store);
  const refs = Array.from({ length: 128 }, () => service.issueSearch(context(), searchAuthority));
  const locators = refs.map((ref) => {
    const body = ref.split(".")[1];
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")).loc as string;
  });
  assert.equal(new Set(locators).size, locators.length);
  assert.ok(locators.every((locator) => Buffer.from(locator, "base64url").length === 32));
  for (const locator of locators) assert.equal(store.hasIndex(locator), false);
});

function refUnavailable(error: unknown): boolean {
  const value = error as { stableCode?: string; category?: string; retryable?: boolean; recovery?: string };
  return value?.stableCode === "ARCSUITE_REF_UNAVAILABLE"
    && value.category === "ref_unavailable"
    && value.retryable === false
    && value.recovery === "search_again";
}
