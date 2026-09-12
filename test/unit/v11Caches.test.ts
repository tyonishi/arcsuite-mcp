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
    context: { includePath: true }
  });
  assert.deepEqual(first.ids, ["rep:a:1", "rep:a:2"]);
  assert.equal(first.pageSize, 2);
  assert.equal(typeof first.nextCursor, "string");

  const second = store.next(first.nextCursor!, { clientProfileId: "client-a", scopeId: "scope_a", kind: "search" });
  assert.deepEqual(second.ids, ["rep:a:3"]);
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
    context: { includePath: false }
  }));
});

test("content snapshots are isolated by client scope document revision and variant", () => {
  const cache = new ContentSnapshotCache(600, 10, 5, 1024 * 1024);
  const base = {
    clientProfileId: "client-a",
    scopeId: "scope_a",
    documentId: "rep:a:1",
    revisionNumber: 3,
    contentLabel: "system:primary",
    variant: "full"
  };
  const snapshot = {
    contentHash: "sha256:abc",
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
  assert.equal(cache.get({ ...base, revisionNumber: 2 }), undefined);
  assert.equal(cache.get({ ...base, variant: "pages:1-2" }), undefined);
});

test("content cache evicts old entries to enforce per-client and byte bounds", () => {
  const cache = new ContentSnapshotCache(600, 2, 1, 128);
  const snapshot = (text: string) => ({
    contentHash: `sha256:${text}`,
    fileName: "example.txt",
    contentType: "text/plain",
    sizeBytes: Buffer.byteLength(text),
    extractor: "text",
    text,
    warnings: []
  });
  const first = { clientProfileId: "client-a", scopeId: "scope", documentId: "rep:a:1", contentLabel: "system:primary" };
  const second = { clientProfileId: "client-a", scopeId: "scope", documentId: "rep:a:2", contentLabel: "system:primary" };
  cache.put(first, snapshot("first"));
  cache.put(second, snapshot("second"));
  assert.equal(cache.get(first), undefined);
  assert.equal(cache.get(second)?.text, "second");
});
