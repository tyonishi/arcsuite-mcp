import test from "node:test";
import assert from "node:assert/strict";
import { PagingSnapshotStore } from "../../src/mcp/paging.ts";
import { ContentSnapshotCache } from "../../src/content/snapshotCache.ts";

const secret = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");

function searchPage(store: PagingSnapshotStore, clientProfileId: string, suffix: string, count = 3) {
  const appliedQuery: any = { operator: "and", filters: { operator: "and", predicates: [] }, text: null };
  return store.create({
    clientProfileId,
    scopeId: "scope_a",
    kind: "search",
    ids: Array.from({ length: count }, (_, index) => `rep:a:${suffix}-${index + 1}`),
    pageSize: 1,
    context: {
      includePath: false,
      searchVerificationPlan: [],
      searchAppliedQuery: appliedQuery,
      responseContract: "opaque_refs_v1",
      searchAuthority: { scopeId: "scope_a", appliedQuery, includePath: false, pageSize: 1 }
    }
  });
}

function pagingUsage(store: PagingSnapshotStore) {
  const internal = store as unknown as {
    snapshots: Map<string, { clientProfileId: string; ids: string[] }>;
    retainedSearchSnapshots: Map<string, { clientProfileId: string; ids: string[] }>;
    totalIds: number;
    retainedSearchTotalIds: number;
  };
  const all = [...internal.snapshots.values(), ...internal.retainedSearchSnapshots.values()];
  return {
    count: all.length,
    countFor: (clientProfileId: string) => all.filter((snapshot) => snapshot.clientProfileId === clientProfileId).length,
    ids: internal.totalIds + internal.retainedSearchTotalIds
  };
}

test("paging snapshots preserve order and bind cursors to profile scope and kind", () => {
  const store = new PagingSnapshotStore(secret, 600, 10, 10, 5, 100);
  const first = store.create({
    clientProfileId: "client-a",
    scopeId: "scope_a",
    kind: "search",
    ids: ["rep:a:1", "rep:a:2", "rep:a:3"],
    pageSize: 2,
    context: { includePath: true, searchVerificationPlan: [], searchAppliedQuery: { operator: "and", filters: { operator: "and", predicates: [] }, text: null } }
  });
  assert.deepEqual(first.ids, ["rep:a:1", "rep:a:2"]);
  assert.equal(first.pageSize, 2);
  assert.equal(typeof first.nextCursor, "string");

  const second = store.next(first.nextCursor!, { clientProfileId: "client-a", scopeId: "scope_a", kind: "search" });
  assert.deepEqual(second.ids, ["rep:a:3"]);
  assert.equal(second.pageSize, 2);
  assert.equal(second.nextCursor, null);
  assert.equal(second.context.includePath, true);

  assert.throws(() => store.next(first.nextCursor!, { clientProfileId: "client-b", scopeId: "scope_a", kind: "search" }));
});

test("paging cursor tampering and duplicate ID snapshots fail closed", () => {
  const store = new PagingSnapshotStore(secret, 600, 10, 10, 5, 100);
  const first = store.create({
    clientProfileId: "client-a",
    scopeId: "scope_a",
    kind: "folder",
    ids: ["rep:a:1", "rep:a:2"],
    pageSize: 1,
    context: { folderId: "rep:a:folder", includePath: false }
  });
  assert.throws(() => store.next(`${first.nextCursor}x`, { clientProfileId: "client-a", scopeId: "scope_a", kind: "folder" }));
  assert.throws(() => store.create({
    clientProfileId: "client-a",
    scopeId: "scope_a",
    kind: "search",
    ids: ["rep:a:1", "rep:a:1"],
    pageSize: 1,
    context: { includePath: false, searchVerificationPlan: [], searchAppliedQuery: { operator: "and", filters: { operator: "and", predicates: [] }, text: null } }
  }));
});

test("hard-reference paging snapshots bind continuation to the requested target", () => {
  const store = new PagingSnapshotStore(secret, 600, 10, 10, 5, 100);
  const first = store.create({
    clientProfileId: "client-a",
    scopeId: "scope_a",
    kind: "hard_reference",
    ids: ["rep:a:hardref-1", "rep:a:hardref-2"],
    pageSize: 1,
    context: { includePath: false, targetDocumentId: "rep:a:target-1" }
  });
  assert.equal(typeof first.nextCursor, "string");

  assert.throws(() => store.next(first.nextCursor!, {
    clientProfileId: "client-a",
    scopeId: "scope_a",
    kind: "hard_reference",
    targetDocumentId: "rep:a:target-2"
  }), /PAGING_CURSOR_TARGET_MISMATCH/);
  assert.throws(() => store.next(first.nextCursor!, {
    clientProfileId: "client-b",
    scopeId: "scope_a",
    kind: "hard_reference",
    targetDocumentId: "rep:a:target-1"
  }), /PAGING_CURSOR_SCOPE_MISMATCH/);
  assert.throws(() => store.next(first.nextCursor!, {
    clientProfileId: "client-a",
    scopeId: "scope_b",
    kind: "hard_reference",
    targetDocumentId: "rep:a:target-1"
  }), /PAGING_CURSOR_SCOPE_MISMATCH/);

  const second = store.next(first.nextCursor!, {
    clientProfileId: "client-a",
    scopeId: "scope_a",
    kind: "hard_reference",
    targetDocumentId: "rep:a:target-1"
  });
  assert.deepEqual(second.ids, ["rep:a:hardref-2"]);
  assert.equal(second.context.targetDocumentId, "rep:a:target-1");
});

test("search snapshots retain an immutable private verification plan without changing cursor payload", () => {
  const store = new PagingSnapshotStore(secret, 600, 10, 10, 5, 100);
  const plan: any = [{
    semanticName: "page_count",
    semanticType: "integer",
    operator: "gte",
    verification: "deterministic",
    condition: {
      attrId: { ns: "rep", name: "user:page_count" },
      operator: "GREATER_EQUAL",
      value: { type: "long", value: 10 }
    }
  }];
  const appliedQuery: any = { operator: "and", filters: { operator: "and", predicates: [{ name: "page_count", type: "integer", operator: "gte", value: 10 }] }, text: null };
  const first = store.create({
    clientProfileId: "client-a",
    scopeId: "scope_a",
    kind: "search",
    ids: ["rep:a:1", "rep:a:2"],
    pageSize: 1,
    context: { includePath: false, searchVerificationPlan: plan, searchAppliedQuery: appliedQuery }
  });
  plan[0].condition.value.value = 0;
  appliedQuery.filters.predicates[0].value = 0;
  assert.equal(first.context.searchAppliedQuery?.filters.predicates[0].value, 10);
  assert.throws(() => { (first.context.searchAppliedQuery!.filters.predicates[0] as any).value = 0; }, TypeError);
  const page = store.next(first.nextCursor!, { clientProfileId: "client-a", scopeId: "scope_a", kind: "search" });
  assert.equal((page.context.searchVerificationPlan?.[0].condition.value as any).value, 10);
  assert.equal(page.context.searchAppliedQuery?.filters.predicates[0].value, 10);
  const [cursorBody] = first.nextCursor!.split(".");
  const cursorPayload = JSON.parse(Buffer.from(cursorBody, "base64url").toString("utf8")) as Record<string, unknown>;
  assert.equal(Object.hasOwn(cursorPayload, "searchVerificationPlan"), false);
  assert.equal(JSON.stringify(cursorPayload).includes("page_count"), false);
  assert.equal(JSON.stringify(cursorPayload).includes("user:page_count"), false);
  assert.equal(Object.hasOwn(cursorPayload, "value"), false);
  assert.throws(() => store.create({
    clientProfileId: "client-a",
    scopeId: "scope_a",
    kind: "search",
    ids: ["rep:a:1", "rep:a:2"],
    pageSize: 1,
    context: { includePath: false } as any
  }), /VERIFICATION_PLAN/);
});

test("ref-native search paging is non-destructive, bounded, and independent of legacy final-page deletion", () => {
  const store = new PagingSnapshotStore(secret, 600, 10, 2, 2, 20);
  const appliedQuery: any = { operator: "and", filters: { operator: "and", predicates: [] }, text: { terms: ["x"], operator: "and", mode: "none" } };
  const searchAuthority: any = { scopeId: "scope_a", appliedQuery, includePath: false, pageSize: 1 };
  const create = (ids: string[]) => store.create({
    clientProfileId: "client-a",
    scopeId: "scope_a",
    kind: "search" as const,
    ids,
    pageSize: 1,
    context: {
      includePath: false,
      searchVerificationPlan: [],
      searchAppliedQuery: appliedQuery,
      responseContract: "opaque_refs_v1" as const,
      searchAuthority
    }
  });

  const first = create(["rep:a:1", "rep:a:2"]);
  const retained = store.continuationAuthority(first.nextCursor!, { clientProfileId: "client-a", scopeId: "scope_a" });
  const legacyFinal = store.next(first.nextCursor!, { clientProfileId: "client-a", scopeId: "scope_a", kind: "search" });
  assert.equal(legacyFinal.nextCursor, null);
  const one = store.resolveContinuationAuthority(retained, { clientProfileId: "client-a", scopeId: "scope_a" });
  const two = store.resolveContinuationAuthority(retained, { clientProfileId: "client-a", scopeId: "scope_a" });
  assert.deepEqual(one.page.ids, ["rep:a:2"]);
  assert.deepEqual(two.page.ids, one.page.ids);

  const replacement = create(["rep:a:3", "rep:a:4"]);
  store.continuationAuthority(replacement.nextCursor!, { clientProfileId: "client-a", scopeId: "scope_a" });
  assert.throws(
    () => store.resolveContinuationAuthority(retained, { clientProfileId: "client-a", scopeId: "scope_a" }),
    /PAGING_REF_AUTHORITY_UNAVAILABLE/
  );
});

test("normal and retained paging authorities share global client and ID capacity", () => {
  const global = new PagingSnapshotStore(secret, 600, 10, 2, 2, 100);
  const globalFirst = searchPage(global, "client-a", "global-a");
  global.continuationAuthority(globalFirst.nextCursor!, { clientProfileId: "client-a", scopeId: "scope_a" });
  const globalNewest = searchPage(global, "client-b", "global-b");
  assert.equal(pagingUsage(global).count, 2, "normal and retained entries must share maxSnapshots");
  assert.deepEqual(
    global.next(globalNewest.nextCursor!, { clientProfileId: "client-b", scopeId: "scope_a", kind: "search" }).ids,
    ["rep:a:global-b-2"],
    "capacity eviction must not remove the newly inserted legacy authority"
  );

  const perClient = new PagingSnapshotStore(secret, 600, 10, 4, 2, 100);
  const clientFirst = searchPage(perClient, "client-a", "client-a-first");
  perClient.continuationAuthority(clientFirst.nextCursor!, { clientProfileId: "client-a", scopeId: "scope_a" });
  searchPage(perClient, "client-a", "client-a-second");
  assert.equal(pagingUsage(perClient).countFor("client-a"), 2,
    "normal and retained entries must share maxSnapshotsPerClient");

  const byIds = new PagingSnapshotStore(secret, 600, 6, 10, 10, 6);
  const idsFirst = searchPage(byIds, "client-a", "ids-a");
  byIds.continuationAuthority(idsFirst.nextCursor!, { clientProfileId: "client-a", scopeId: "scope_a" });
  assert.equal(pagingUsage(byIds).count, 2, "a retained copy is a second combined paging entry");
  assert.equal(pagingUsage(byIds).ids, 6, "retained copies must participate in combined ID accounting");
  searchPage(byIds, "client-b", "ids-b");
  assert.equal(pagingUsage(byIds).ids, 6, "normal and retained entries must share maxTotalIds");

  const constrained = new PagingSnapshotStore(secret, 600, 3, 1, 1, 3);
  const protectedLegacy = searchPage(constrained, "client-a", "protected");
  assert.throws(
    () => constrained.continuationAuthority(protectedLegacy.nextCursor!, { clientProfileId: "client-a", scopeId: "scope_a" }),
    /PAGING_REF_CACHE_LIMIT/
  );
  assert.deepEqual(
    constrained.next(protectedLegacy.nextCursor!, { clientProfileId: "client-a", scopeId: "scope_a", kind: "search" }).ids,
    ["rep:a:protected-2"],
    "a failed retained-copy insertion must not evict its source legacy authority"
  );
});

test("expired normal and retained paging entries are pruned before combined capacity decisions", () => {
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const store = new PagingSnapshotStore(secret, 1, 6, 2, 2, 6);
    const expired = searchPage(store, "client-a", "expired");
    store.continuationAuthority(expired.nextCursor!, { clientProfileId: "client-a", scopeId: "scope_a" });
    now += 2_000;
    const current = searchPage(store, "client-a", "current");
    const usage = pagingUsage(store);
    assert.equal(usage.count, 1);
    assert.equal(usage.ids, 3);
    assert.deepEqual(
      store.next(current.nextCursor!, { clientProfileId: "client-a", scopeId: "scope_a", kind: "search" }).ids,
      ["rep:a:current-2"]
    );
  } finally {
    Date.now = realNow;
  }
});

test("content snapshots are isolated by client scope document revision and variant", () => {
  const cache = new ContentSnapshotCache(600, 10, 5, 1024 * 1024);
  const base = {
    clientProfileId: "client-a",
    scopeId: "scope_a",
    documentId: "rep:a:1",
    effectiveDocumentId: "rep:a:1",
    wireDocumentId: "rep:a:1:3",
    cabinetId: "rep:a",
    rootObjectId: null,
    provenRevisionNumber: 3,
    contentLabel: "system:primary",
    physicalContentLabel: { ns: "rep", name: "system:primary" },
    variant: "full"
  };
  const snapshot = {
    contentHash: "sha256:abc",
    label: "system:primary",
    fileName: "example.txt",
    contentType: "text/plain",
    sizeBytes: 5,
    extractor: "text",
    text: "hello",
    warnings: []
  };
  cache.put(base, snapshot);
  assert.equal(cache.get(base)?.text, "hello");
  assert.equal(cache.get({ ...base, clientProfileId: "client-b" }), undefined);
  assert.equal(cache.get({ ...base, scopeId: "scope_b" }), undefined);
  assert.equal(cache.get({ ...base, documentId: "rep:a:2" }), undefined);
  assert.equal(cache.get({ ...base, wireDocumentId: "rep:a:1:2", provenRevisionNumber: 2 }), undefined);
  assert.equal(cache.get({ ...base, variant: "pages:1-2" }), undefined);
});

test("content cache separates semantic labels and same-name labels in different namespaces", () => {
  const cache = new ContentSnapshotCache(600, 10, 5, 1024 * 1024);
  const snapshot = (label: string, text: string) => ({
    contentHash: `sha256:${text}`,
    label,
    fileName: `${label}.txt`,
    contentType: "text/plain",
    sizeBytes: Buffer.byteLength(text),
    extractor: "text",
    text,
    warnings: []
  });
  const primary = {
    clientProfileId: "client-a",
    scopeId: "scope",
    documentId: "rep:a:1",
    effectiveDocumentId: "rep:a:1",
    wireDocumentId: "rep:a:1:1",
    cabinetId: "rep:a",
    rootObjectId: null,
    provenRevisionNumber: 1,
    contentLabel: "system:primary",
    physicalContentLabel: { ns: "rep", name: "system:primary" }
  };
  const preview = {
    ...primary,
    contentLabel: "preview",
    physicalContentLabel: { ns: "rep", name: "user:SAME_NAME" }
  };
  const otherNamespace = {
    ...primary,
    contentLabel: "preview",
    physicalContentLabel: { ns: "other", name: "user:SAME_NAME" }
  };
  cache.put(primary, snapshot("system:primary", "primary"));
  cache.put(preview, snapshot("preview", "preview"));
  cache.put(otherNamespace, snapshot("other", "other"));
  assert.equal(cache.get(primary)?.text, "primary");
  assert.equal(cache.get(preview)?.text, "preview");
  assert.equal(cache.get(otherNamespace)?.text, "other");
});

test("content cache evicts old entries to enforce per-client and byte bounds", () => {
  const cache = new ContentSnapshotCache(600, 2, 1, 128);
  const snapshot = (text: string) => ({
    contentHash: `sha256:${text}`,
    label: "system:primary",
    fileName: "example.txt",
    contentType: "text/plain",
    sizeBytes: Buffer.byteLength(text),
    extractor: "text",
    text,
    warnings: []
  });
  const first = { clientProfileId: "client-a", scopeId: "scope", documentId: "rep:a:1", effectiveDocumentId: "rep:a:1", wireDocumentId: "rep:a:1:1", cabinetId: "rep:a", rootObjectId: null, provenRevisionNumber: 1, contentLabel: "system:primary", physicalContentLabel: { ns: "rep", name: "system:primary" } };
  const second = { clientProfileId: "client-a", scopeId: "scope", documentId: "rep:a:2", effectiveDocumentId: "rep:a:2", wireDocumentId: "rep:a:2:1", cabinetId: "rep:a", rootObjectId: null, provenRevisionNumber: 1, contentLabel: "system:primary", physicalContentLabel: { ns: "rep", name: "system:primary" } };
  cache.put(first, snapshot("first"));
  cache.put(second, snapshot("second"));
  assert.equal(cache.get(first), undefined);
  assert.equal(cache.get(second)?.text, "second");
});

test("content cache evicts the oldest entry when the total byte bound is exceeded", () => {
  const cache = new ContentSnapshotCache(600, 2, 2, 128);
  const snapshot = (text: string) => ({
    contentHash: `sha256:${text}`,
    label: "system:primary",
    fileName: "example.txt",
    contentType: "text/plain",
    sizeBytes: Buffer.byteLength(text),
    extractor: "text",
    text,
    warnings: []
  });
  const first = { clientProfileId: "client-a", scopeId: "scope", documentId: "rep:a:1", effectiveDocumentId: "rep:a:1", wireDocumentId: "rep:a:1:1", cabinetId: "rep:a", rootObjectId: null, provenRevisionNumber: 1, contentLabel: "system:primary", physicalContentLabel: { ns: "rep", name: "system:primary" } };
  const second = { clientProfileId: "client-b", scopeId: "scope", documentId: "rep:b:1", effectiveDocumentId: "rep:b:1", wireDocumentId: "rep:b:1:1", cabinetId: "rep:b", rootObjectId: null, provenRevisionNumber: 1, contentLabel: "system:primary", physicalContentLabel: { ns: "rep", name: "system:primary" } };
  cache.put(first, snapshot("a".repeat(80)));
  cache.put(second, snapshot("b".repeat(80)));
  assert.equal(cache.get(first), undefined);
  assert.equal(cache.get(second)?.text, "b".repeat(80));
});
