import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type PagingKind = "search" | "folder" | "hard_reference";

export type PagingSnapshotContext = {
  folderId?: string;
  targetDocumentId?: string;
  includePath: boolean;
};

type PagingSnapshot = {
  id: string;
  clientProfileId: string;
  scopeId: string;
  kind: PagingKind;
  ids: string[];
  pageSize: number;
  context: PagingSnapshotContext;
  snapshotLimited: boolean;
  createdAt: number;
  expiresAt: number;
  lastAccessAt: number;
};

type PagingCursorPayload = {
  v: 1;
  snapshot_id: string;
  client_profile_id: string;
  scope_id: string;
  kind: PagingKind;
  offset: number;
  page_size: number;
  expires_at: number;
};

export type PagingPage = {
  ids: string[];
  nextCursor: string | null;
  snapshotLimited: boolean;
  pageSize: number;
  context: PagingSnapshotContext;
};

export class PagingSnapshotStore {
  private readonly snapshots = new Map<string, PagingSnapshot>();
  private totalIds = 0;
  private readonly secret: Buffer;
  private readonly ttlSeconds: number;
  private readonly maxIdsPerSnapshot: number;
  private readonly maxSnapshots: number;
  private readonly maxSnapshotsPerClient: number;
  private readonly maxTotalIds: number;

  constructor(secret: Buffer, ttlSeconds: number, maxIdsPerSnapshot: number, maxSnapshots: number, maxSnapshotsPerClient: number, maxTotalIds: number) {
    this.secret = secret;
    this.ttlSeconds = ttlSeconds;
    this.maxIdsPerSnapshot = maxIdsPerSnapshot;
    this.maxSnapshots = maxSnapshots;
    this.maxSnapshotsPerClient = maxSnapshotsPerClient;
    this.maxTotalIds = maxTotalIds;
    if (secret.length < 16) throw new Error("Paging cursor HMAC secret must be at least 16 bytes");
    for (const [name, value] of Object.entries({ ttlSeconds, maxIdsPerSnapshot, maxSnapshots, maxSnapshotsPerClient, maxTotalIds })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid paging limit: ${name}`);
    }
    if (maxSnapshotsPerClient > maxSnapshots) throw new Error("Paging per-client snapshot limit cannot exceed global snapshot limit");
    if (maxIdsPerSnapshot > maxTotalIds) throw new Error("Paging snapshot ID limit cannot exceed global ID limit");
  }

  create(input: { clientProfileId: string; scopeId: string; kind: PagingKind; ids: string[]; pageSize: number; context: PagingSnapshotContext; upstreamLimited?: boolean }): PagingPage {
    this.pruneExpired();
    if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > this.maxIdsPerSnapshot) throw new Error("INVALID_PAGE_SIZE");
    if (input.kind === "hard_reference" && (!input.context.targetDocumentId || !/^rep:\S+$/.test(input.context.targetDocumentId))) throw new Error("INVALID_HARD_REFERENCE_TARGET");
    const unique = new Set(input.ids);
    if (unique.size !== input.ids.length) throw new Error("DUPLICATE_PAGING_IDS");
    const snapshotLimited = Boolean(input.upstreamLimited) || input.ids.length > this.maxIdsPerSnapshot;
    const boundedIds = input.ids.slice(0, this.maxIdsPerSnapshot);
    const first = boundedIds.slice(0, input.pageSize);
    if (boundedIds.length <= input.pageSize) return { ids: first, nextCursor: null, snapshotLimited, pageSize: input.pageSize, context: { ...input.context } };

    this.makeRoom(input.clientProfileId, boundedIds.length);
    const now = Date.now();
    const snapshot: PagingSnapshot = {
      id: randomUUID(), clientProfileId: input.clientProfileId, scopeId: input.scopeId, kind: input.kind,
      ids: boundedIds, pageSize: input.pageSize, context: { ...input.context }, snapshotLimited,
      createdAt: now, expiresAt: now + this.ttlSeconds * 1000, lastAccessAt: now
    };
    this.snapshots.set(snapshot.id, snapshot);
    this.totalIds += snapshot.ids.length;
    return { ids: first, nextCursor: this.createCursor(snapshot, input.pageSize), snapshotLimited, pageSize: snapshot.pageSize, context: { ...snapshot.context } };
  }

  next(cursor: string, expected: { clientProfileId: string; scopeId: string; kind: PagingKind; targetDocumentId?: string }): PagingPage {
    this.pruneExpired();
    const payload = this.parseCursor(cursor);
    if (payload.client_profile_id !== expected.clientProfileId || payload.scope_id !== expected.scopeId || payload.kind !== expected.kind) throw new Error("PAGING_CURSOR_SCOPE_MISMATCH");
    const snapshot = this.snapshots.get(payload.snapshot_id);
    if (!snapshot) throw new Error("PAGING_SNAPSHOT_EXPIRED");
    if (snapshot.expiresAt <= Date.now()) { this.remove(snapshot.id); throw new Error("PAGING_SNAPSHOT_EXPIRED"); }
    if (snapshot.clientProfileId !== expected.clientProfileId || snapshot.scopeId !== expected.scopeId || snapshot.kind !== expected.kind) throw new Error("PAGING_CURSOR_SCOPE_MISMATCH");
    if (expected.kind === "hard_reference" && (!expected.targetDocumentId || snapshot.context.targetDocumentId !== expected.targetDocumentId)) throw new Error("PAGING_CURSOR_TARGET_MISMATCH");
    if (payload.page_size !== snapshot.pageSize || payload.offset < 0 || payload.offset >= snapshot.ids.length) throw new Error("INVALID_PAGING_CURSOR");
    snapshot.lastAccessAt = Date.now();
    const end = Math.min(snapshot.ids.length, payload.offset + snapshot.pageSize);
    const ids = snapshot.ids.slice(payload.offset, end);
    const nextCursor = end < snapshot.ids.length ? this.createCursor(snapshot, end) : null;
    const page = { ids, nextCursor, snapshotLimited: snapshot.snapshotLimited, pageSize: snapshot.pageSize, context: { ...snapshot.context } };
    if (!nextCursor) this.remove(snapshot.id);
    return page;
  }

  clear(): void { this.snapshots.clear(); this.totalIds = 0; }

  private createCursor(snapshot: PagingSnapshot, offset: number): string {
    const payload: PagingCursorPayload = {
      v: 1, snapshot_id: snapshot.id, client_profile_id: snapshot.clientProfileId, scope_id: snapshot.scopeId,
      kind: snapshot.kind, offset, page_size: snapshot.pageSize, expires_at: Math.floor(snapshot.expiresAt / 1000)
    };
    const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    return `${body}.${this.sign(body)}`;
  }

  private parseCursor(cursor: string): PagingCursorPayload {
    const [body, signature, extra] = cursor.split(".");
    if (!body || !signature || extra) throw new Error("INVALID_PAGING_CURSOR");
    const expected = this.sign(body);
    const left = Buffer.from(signature, "utf8");
    const right = Buffer.from(expected, "utf8");
    if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error("INVALID_PAGING_CURSOR_SIGNATURE");
    let parsed: PagingCursorPayload;
    try { parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as PagingCursorPayload; } catch { throw new Error("INVALID_PAGING_CURSOR"); }
    if (parsed.v !== 1 || !parsed.snapshot_id || !parsed.client_profile_id || !parsed.scope_id || (parsed.kind !== "search" && parsed.kind !== "folder" && parsed.kind !== "hard_reference") || !Number.isSafeInteger(parsed.offset) || !Number.isSafeInteger(parsed.page_size) || !Number.isSafeInteger(parsed.expires_at)) throw new Error("INVALID_PAGING_CURSOR");
    if (parsed.expires_at < Math.floor(Date.now() / 1000)) throw new Error("PAGING_CURSOR_EXPIRED");
    return parsed;
  }

  private sign(body: string): string { return createHmac("sha256", this.secret).update(`paging-v1.${body}`).digest("base64url"); }
  private pruneExpired(): void { const now = Date.now(); for (const snapshot of this.snapshots.values()) if (snapshot.expiresAt <= now) this.remove(snapshot.id); }

  private makeRoom(clientProfileId: string, incomingIds: number): void {
    const byAge = () => [...this.snapshots.values()].sort((a, b) => a.lastAccessAt - b.lastAccessAt || a.createdAt - b.createdAt);
    while ([...this.snapshots.values()].filter((s) => s.clientProfileId === clientProfileId).length >= this.maxSnapshotsPerClient) {
      const victim = byAge().find((s) => s.clientProfileId === clientProfileId); if (!victim) break; this.remove(victim.id);
    }
    while (this.snapshots.size >= this.maxSnapshots || this.totalIds + incomingIds > this.maxTotalIds) { const victim = byAge()[0]; if (!victim) break; this.remove(victim.id); }
    if (this.snapshots.size >= this.maxSnapshots || this.totalIds + incomingIds > this.maxTotalIds) throw new Error("PAGING_CACHE_LIMIT");
  }

  private remove(id: string): void { const snapshot = this.snapshots.get(id); if (!snapshot) return; this.totalIds -= snapshot.ids.length; this.snapshots.delete(id); }
}
