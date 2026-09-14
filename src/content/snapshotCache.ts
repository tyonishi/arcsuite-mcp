import type { PhysicalContentLabel } from "../arcsuite/types.ts";

export type ContentCacheContext = {
  clientProfileId: string;
  scopeId: string;
  documentId: string;
  /** Current effective identity proven by the gateway before cache access. */
  effectiveDocumentId: string;
  cabinetId: string;
  rootObjectId: string | null;
  revisionNumber?: number;
  contentLabel: string;
  physicalContentLabel: PhysicalContentLabel;
  variant?: string;
};

export type ContentSnapshot = {
  contentHash: string;
  label: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  extractor: string;
  text: string;
  warnings: string[];
  pageRange?: { start?: number; end?: number };
};

type StoredSnapshot = ContentSnapshot & {
  id: string;
  locator: string;
  clientProfileId: string;
  bytes: number;
  createdAt: number;
  expiresAt: number;
  lastAccessAt: number;
};

export class ContentSnapshotCache {
  private readonly entries = new Map<string, StoredSnapshot>();
  private readonly locatorIndex = new Map<string, string>();
  private totalBytes = 0;
  private readonly ttlSeconds: number;
  private readonly maxEntries: number;
  private readonly maxEntriesPerClient: number;
  private readonly maxBytes: number;

  constructor(ttlSeconds: number, maxEntries: number, maxEntriesPerClient: number, maxBytes: number) {
    this.ttlSeconds = ttlSeconds;
    this.maxEntries = maxEntries;
    this.maxEntriesPerClient = maxEntriesPerClient;
    this.maxBytes = maxBytes;
    for (const [name, value] of Object.entries({ ttlSeconds, maxEntries, maxEntriesPerClient, maxBytes })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid content cache limit: ${name}`);
    }
    if (maxEntriesPerClient > maxEntries) throw new Error("Per-client content cache limit cannot exceed global entry limit");
  }

  get(context: ContentCacheContext): ContentSnapshot | undefined {
    this.pruneExpired();
    const locator = locatorKey(context);
    const id = this.locatorIndex.get(locator);
    if (!id) return undefined;
    const entry = this.entries.get(id);
    if (!entry) {
      this.locatorIndex.delete(locator);
      return undefined;
    }
    entry.lastAccessAt = Date.now();
    return publicSnapshot(entry);
  }

  put(context: ContentCacheContext, snapshot: ContentSnapshot): ContentSnapshot {
    this.pruneExpired();
    const bytes = Buffer.byteLength(snapshot.text, "utf8");
    if (bytes > this.maxBytes) return snapshot;
    const locator = locatorKey(context);
    const id = `${locator}\u001f${snapshot.contentHash}`;
    const previousId = this.locatorIndex.get(locator);
    if (previousId && previousId !== id) this.remove(previousId);
    const existing = this.entries.get(id);
    if (existing) {
      existing.lastAccessAt = Date.now();
      existing.expiresAt = Date.now() + this.ttlSeconds * 1000;
      this.locatorIndex.set(locator, id);
      return publicSnapshot(existing);
    }
    this.makeRoom(context.clientProfileId, bytes);
    const now = Date.now();
    const stored: StoredSnapshot = {
      ...snapshot,
      id,
      locator,
      clientProfileId: context.clientProfileId,
      bytes,
      createdAt: now,
      expiresAt: now + this.ttlSeconds * 1000,
      lastAccessAt: now
    };
    this.entries.set(id, stored);
    this.locatorIndex.set(locator, id);
    this.totalBytes += bytes;
    return snapshot;
  }

  clear(): void { this.entries.clear(); this.locatorIndex.clear(); this.totalBytes = 0; }

  private pruneExpired(): void { const now = Date.now(); for (const entry of this.entries.values()) if (entry.expiresAt <= now) this.remove(entry.id); }

  private makeRoom(clientProfileId: string, incomingBytes: number): void {
    const byAge = () => [...this.entries.values()].sort((a, b) => a.lastAccessAt - b.lastAccessAt || a.createdAt - b.createdAt);
    while ([...this.entries.values()].filter((entry) => entry.clientProfileId === clientProfileId).length >= this.maxEntriesPerClient) {
      const victim = byAge().find((entry) => entry.clientProfileId === clientProfileId); if (!victim) break; this.remove(victim.id);
    }
    while (this.entries.size >= this.maxEntries || this.totalBytes + incomingBytes > this.maxBytes) { const victim = byAge()[0]; if (!victim) break; this.remove(victim.id); }
    if (this.entries.size >= this.maxEntries || this.totalBytes + incomingBytes > this.maxBytes) throw new Error("CONTENT_CACHE_LIMIT");
  }

  private remove(id: string): void {
    const entry = this.entries.get(id); if (!entry) return;
    this.entries.delete(id);
    if (this.locatorIndex.get(entry.locator) === id) this.locatorIndex.delete(entry.locator);
    this.totalBytes -= entry.bytes;
  }
}

function locatorKey(context: ContentCacheContext): string {
  return JSON.stringify([
    context.clientProfileId,
    context.scopeId,
    context.documentId,
    context.effectiveDocumentId,
    context.cabinetId,
    context.rootObjectId,
    context.revisionNumber ?? "current",
    context.contentLabel,
    context.physicalContentLabel.ns,
    context.physicalContentLabel.name,
    context.variant ?? "full"
  ]);
}

function publicSnapshot(entry: StoredSnapshot): ContentSnapshot {
  return {
    contentHash: entry.contentHash,
    label: entry.label,
    fileName: entry.fileName,
    contentType: entry.contentType,
    sizeBytes: entry.sizeBytes,
    extractor: entry.extractor,
    text: entry.text,
    warnings: [...entry.warnings],
    pageRange: entry.pageRange ? { ...entry.pageRange } : undefined
  };
}
