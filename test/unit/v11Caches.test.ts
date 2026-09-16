import test from "node:test";
import assert from "node:assert/strict";
import { PagingSnapshotStore } from "../../src/mcp/paging.ts";
import { ContentSnapshotCache } from "../../src/content/snapshotCache.ts";

const secret = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");

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
  const store = new PagingSnapshotStore(secret, 600, 10, 1, 1, 10);
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
