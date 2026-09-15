import { createHash } from "node:crypto";
import { realpath, stat, unlink } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { AdapterContentResult } from "../arcsuite/types.ts";
import type { ContentExtractor, ExtractRequest } from "./extractors/types.ts";
import { TextExtractor, CsvExtractor } from "./extractors/text.ts";
import { JsonExtractor } from "./extractors/json.ts";
import { XmlExtractor } from "./extractors/xml.ts";
import { PdfExtractor } from "./extractors/pdf.ts";
import { OfficeOpenXmlExtractor } from "./extractors/officeOpenXml.ts";
import { UnsupportedContentHandler } from "./extractors/unsupported.ts";
import { CursorManager, type ReadCursorPayload } from "./cursor.ts";
import { ContentSnapshotCache, type ContentCacheContext, type ContentSnapshot } from "./snapshotCache.ts";
import { CONTENT_LABEL_PRIMARY_ALIAS } from "../semantic/contentLabels.ts";

export type ContentInfo = {
  label: string;
  file_name: string;
  content_type: string;
  size_bytes?: number;
  extractable: boolean;
  extractor: string;
  cached?: boolean;
};

export type ReadContentOptions = {
  traceId: string;
  documentId: string;
  revisionNumber?: number;
  startPage?: number;
  endPage?: number;
  cursor?: string;
  contentLabel?: string;
  maxChars: number;
};

export type ReadContentResult = {
  document_id: string;
  revision_number?: number;
  content_label: string;
  file_name: string;
  content_type: string;
  extractor: string;
  page_range?: { start?: number; end?: number };
  content: string;
  truncated: boolean;
  next_cursor: string | null;
  warnings: string[];
  cached: boolean;
};

export class ContentBridge {
  private readonly extractors: ContentExtractor[];
  private readonly sharedTempDir: string;
  private readonly cursors: CursorManager;
  private readonly maxContentBytes: number;
  private readonly maxExtractedChars: number;
  private readonly cache?: ContentSnapshotCache;

  constructor(
    sharedTempDir: string,
    cursors: CursorManager,
    limits: { maxContentBytes: number; maxExtractedChars: number },
    cache?: ContentSnapshotCache
  ) {
    this.sharedTempDir = sharedTempDir;
    this.cursors = cursors;
    this.maxContentBytes = limits.maxContentBytes;
    this.maxExtractedChars = limits.maxExtractedChars;
    this.cache = cache;
    this.extractors = [new TextExtractor(), new CsvExtractor(), new JsonExtractor(), new XmlExtractor(), new PdfExtractor(), new OfficeOpenXmlExtractor(), new UnsupportedContentHandler()];
  }

  info(content: AdapterContentResult, contentLabel = CONTENT_LABEL_PRIMARY_ALIAS): ContentInfo {
    const extractor = this.selectExtractor(content.contentType, content.fileName);
    return {
      label: contentLabel,
      file_name: content.fileName,
      content_type: content.contentType,
      size_bytes: content.sizeBytes,
      extractable: content.sizeBytes <= this.maxContentBytes && extractor.name !== "unsupported",
      extractor: extractor.name,
      cached: false
    };
  }

  async infoCachedOrLoad(context: ContentCacheContext, load: () => Promise<AdapterContentResult>): Promise<ContentInfo> {
    const cached = this.cache?.get({ ...context, variant: "full" });
    if (cached) return infoFromSnapshot(cached.label, cached, true);
    const content = await load();
    this.assertContentAuthority(content, context);
    const basic = this.info(content, context.contentLabel);
    if (!basic.extractable) {
      await this.discard(content);
      return basic;
    }
    const safePath = await this.assertSharedPath(content.filePath);
    try {
      const snapshot = await this.extractSnapshot(content, undefined, undefined, safePath, context.contentLabel);
      const stored = this.cache?.put({ ...context, variant: "full" }, snapshot) ?? snapshot;
      // `cached` means this request was served from an existing private snapshot,
      // not merely that a snapshot is available after this request. Keeping this
      // false on a miss also preserves accurate SOAP-operation audit metadata.
      return infoFromSnapshot(stored.label, stored, false);
    } catch {
      // Content-info is allowed to return validated adapter metadata when the
      // optional snapshot warm-up fails. Document reads still propagate the
      // extraction error through their separate path.
      return basic;
    }
  }

  async discard(content: AdapterContentResult): Promise<void> {
    const safePath = await this.assertSharedPath(content.filePath);
    await unlink(safePath).catch(() => undefined);
  }

  async read(content: AdapterContentResult, options: ReadContentOptions, context: ContentCacheContext): Promise<ReadContentResult> {
    const cursorPayload = options.cursor ? this.cursors.parse(options.cursor) : undefined;
    const contentLabel = options.contentLabel ?? context.contentLabel;
    if (context.documentId !== options.documentId || context.requestedRevisionNumber !== options.revisionNumber || context.contentLabel !== contentLabel) {
      throw new Error("CONTENT_AUTHORITY_MISMATCH");
    }
    this.assertContentAuthority(content, context);
    validateCursorIdentity(
      cursorPayload,
      options.documentId,
      options.revisionNumber,
      context.clientProfileId,
      context.scopeId,
      contentLabel,
      this.cursors.bindEffectiveIdentity(contentAuthorityInput(context))
    );
    const startPage = cursorPayload?.start_page ?? options.startPage;
    const endPage = cursorPayload?.end_page ?? options.endPage;
    const snapshot = await this.extractSnapshot(content, startPage, endPage, undefined, contentLabel);
    return this.sliceSnapshot(snapshot, options, cursorPayload, context, false);
  }

  async readCachedOrLoad(
    context: ContentCacheContext,
    options: ReadContentOptions,
    load: () => Promise<AdapterContentResult>
  ): Promise<ReadContentResult> {
    const cursorPayload = options.cursor ? this.cursors.parse(options.cursor) : undefined;
    validateCursorIdentity(
      cursorPayload,
      options.documentId,
      options.revisionNumber,
      context.clientProfileId,
      context.scopeId,
      context.contentLabel,
      this.cursors.bindEffectiveIdentity(contentAuthorityInput(context))
    );
    const startPage = cursorPayload?.start_page ?? options.startPage;
    const endPage = cursorPayload?.end_page ?? options.endPage;
    const cacheContext = { ...context, variant: pageVariant(startPage, endPage) };
    let snapshot = this.cache?.get(cacheContext);
    const cacheHit = Boolean(snapshot);
    if (!snapshot) {
      const content = await load();
      this.assertContentAuthority(content, context);
      snapshot = await this.extractSnapshot(content, startPage, endPage, undefined, context.contentLabel);
      this.cache?.put(cacheContext, snapshot);
    }
    if (snapshot.label !== context.contentLabel) throw new Error("CONTENT_CACHE_LABEL_MISMATCH");
    return this.sliceSnapshot(snapshot, options, cursorPayload, context, cacheHit);
  }

  resolveCursorContentLabel(cursor: string): string {
    const payload = this.cursors.parse(cursor);
    return payload.content_label ?? CONTENT_LABEL_PRIMARY_ALIAS;
  }

  clearCache(): void {
    this.cache?.clear();
  }

  private async extractSnapshot(
    content: AdapterContentResult,
    startPage?: number,
    endPage?: number,
    verifiedPath?: string,
    contentLabel = CONTENT_LABEL_PRIMARY_ALIAS
  ): Promise<ContentSnapshot> {
    const safePath = verifiedPath ?? await this.assertSharedPath(content.filePath);
    try {
      if (content.sizeBytes > this.maxContentBytes) throw new Error("CONTENT_SIZE_LIMIT");
      const fileStats = await stat(safePath);
      if (fileStats.size > this.maxContentBytes) throw new Error("CONTENT_SIZE_LIMIT");
      const extractor = this.selectExtractor(content.contentType, content.fileName);
      if (extractor.name === "unsupported") throw new Error("UNSUPPORTED_CONTENT_TYPE");
      const request: ExtractRequest = {
        filePath: safePath,
        fileName: content.fileName,
        contentType: content.contentType,
        startPage,
        endPage,
        maxExtractedChars: this.maxExtractedChars
      };
      const extracted = await extractor.extract(request);
      const normalized = normalizeExtractedText(extracted.text, this.maxExtractedChars);
      const warnings = [...extracted.warnings];
      if (extracted.text.length > this.maxExtractedChars && !warnings.includes("EXTRACTED_TEXT_LIMIT")) warnings.push("EXTRACTED_TEXT_LIMIT");
      const hash = `sha256:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
      return {
        contentHash: hash,
        label: contentLabel,
        fileName: content.fileName,
        contentType: content.contentType,
        sizeBytes: content.sizeBytes,
        extractor: extracted.extractor,
        text: normalized,
        warnings,
        pageRange: extracted.pageRange
      };
    } finally {
      await unlink(safePath).catch(() => undefined);
    }
  }

  private assertContentAuthority(content: AdapterContentResult, context: ContentCacheContext): void {
    if (content.id !== context.documentId
      || content.effectiveId !== context.effectiveDocumentId
      || content.wireId !== context.wireDocumentId
      || content.revisionNumber !== context.provenRevisionNumber
      || content.label.ns !== context.physicalContentLabel.ns
      || content.label.name !== context.physicalContentLabel.name) {
      throw new Error("CONTENT_AUTHORITY_MISMATCH");
    }
  }

  private sliceSnapshot(
    snapshot: ContentSnapshot,
    options: ReadContentOptions,
    cursorPayload?: ReadCursorPayload,
    context?: ContentCacheContext,
    cacheHit = false
  ): ReadContentResult {
    if (cursorPayload) {
      if (cursorPayload.content_hash !== snapshot.contentHash || cursorPayload.extractor !== snapshot.extractor) throw new Error("CURSOR_CONTENT_CHANGED");
    }
    const offset = cursorPayload?.offset ?? 0;
    if (offset > snapshot.text.length) throw new Error("CURSOR_OFFSET_INVALID");
    const end = Math.min(snapshot.text.length, offset + options.maxChars);
    const chunk = snapshot.text.slice(offset, end);
    const truncated = end < snapshot.text.length;
    const next = truncated ? this.cursors.create({
      version: 2,
      trace_id: options.traceId,
      client_profile_id: context?.clientProfileId,
      scope_id: context?.scopeId,
      document_id: options.documentId,
      revision_number: options.revisionNumber,
      content_label: snapshot.label,
      content_hash: snapshot.contentHash,
      offset: end,
      extractor: snapshot.extractor,
      start_page: cursorPayload?.start_page ?? options.startPage,
      end_page: cursorPayload?.end_page ?? options.endPage,
      effective_identity_binding: context
        ? this.cursors.bindEffectiveIdentity(contentAuthorityInput(context))
        : (() => { throw new Error("CONTENT_AUTHORITY_REQUIRED"); })()
    }) : null;
    return {
      document_id: options.documentId,
      revision_number: options.revisionNumber,
      content_label: snapshot.label,
      file_name: snapshot.fileName,
      content_type: snapshot.contentType,
      extractor: snapshot.extractor,
      page_range: snapshot.pageRange,
      content: chunk,
      truncated,
      next_cursor: next,
      warnings: [...snapshot.warnings],
      cached: cacheHit
    };
  }

  private selectExtractor(contentType: string, fileName: string): ContentExtractor {
    return this.extractors.find((x) => x.supports(contentType, fileName))!;
  }

  private async assertSharedPath(filePath: string): Promise<string> {
    const root = resolve(this.sharedTempDir);
    const actual = await realpath(filePath);
    if (actual !== root && !actual.startsWith(root + sep)) throw new Error("ADAPTER_FILE_PATH_OUTSIDE_SHARED_TEMP");
    return actual;
  }
}

function validateCursorIdentity(
  cursor: ReadCursorPayload | undefined,
  documentId: string,
  revisionNumber?: number,
  clientProfileId?: string,
  scopeId?: string,
  contentLabel = CONTENT_LABEL_PRIMARY_ALIAS,
  authorityBinding?: string
): void {
  if (!cursor) return;
  if (cursor.document_id !== documentId || cursor.revision_number !== revisionNumber) throw new Error("CURSOR_DOCUMENT_MISMATCH");
  // When the caller supplies an authority boundary, the cursor must carry and
  // exactly match that boundary. A pre-v1.1 cursor without these claims is
  // intentionally invalidated rather than accepted across profiles/scopes.
  if (clientProfileId !== undefined && cursor.client_profile_id !== clientProfileId) throw new Error("CURSOR_PROFILE_MISMATCH");
  if (scopeId !== undefined && cursor.scope_id !== scopeId) throw new Error("CURSOR_SCOPE_MISMATCH");
  const cursorLabel = cursor.content_label ?? CONTENT_LABEL_PRIMARY_ALIAS;
  if (cursorLabel !== contentLabel) throw new Error("CURSOR_CONTENT_LABEL_MISMATCH");
  if (authorityBinding !== undefined && cursor.effective_identity_binding !== authorityBinding) throw new Error("CURSOR_AUTHORITY_MISMATCH");
}

function pageVariant(startPage?: number, endPage?: number): string {
  return startPage === undefined ? "full" : `pages:${startPage}-${endPage ?? "end"}`;
}

function contentAuthorityInput(context: ContentCacheContext) {
  return {
    clientProfileId: context.clientProfileId,
    scopeId: context.scopeId,
    requestedDocumentId: context.documentId,
    effectiveDocumentId: context.effectiveDocumentId,
    wireDocumentId: context.wireDocumentId,
    requestedRevisionNumber: context.requestedRevisionNumber,
    provenRevisionNumber: context.provenRevisionNumber,
    contentLabel: context.contentLabel,
    physicalContentLabel: context.physicalContentLabel,
    cabinetId: context.cabinetId,
    rootObjectId: context.rootObjectId
  };
}

function infoFromSnapshot(label: string, snapshot: ContentSnapshot, cached: boolean): ContentInfo {
  return {
    label,
    file_name: snapshot.fileName,
    content_type: snapshot.contentType,
    size_bytes: snapshot.sizeBytes,
    extractable: true,
    extractor: snapshot.extractor,
    cached
  };
}

export function normalizeExtractedText(text: string, maxChars = Number.MAX_SAFE_INTEGER): string {
  // A single pass keeps normalization O(n), including adversarial runs of
  // spaces/tabs before line boundaries.
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error("EXTRACTED_TEXT_LIMIT_INVALID");
  const output: string[] = [];
  let outputLength = 0;
  const append = (value: string) => {
    if (outputLength >= maxChars) return false;
    const remaining = maxChars - outputLength;
    const part = value.length <= remaining ? value : value.slice(0, remaining);
    if (part) {
      output.push(part);
      outputLength += part.length;
    }
    return outputLength < maxChars;
  };
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 13 || code === 10) {
      if (code === 13 && text.charCodeAt(index + 1) === 10) index += 1;
      while (output.length && (output[output.length - 1].endsWith(" ") || output[output.length - 1].endsWith("\t"))) {
        const last = output.pop()!;
        outputLength -= 1;
        const trimmed = last.slice(0, -1);
        if (trimmed) {
          output.push(trimmed);
          outputLength += trimmed.length;
          break;
        }
      }
      if (!append("\n")) break;
      continue;
    }
    if (code === 0 || (code >= 1 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) continue;
    if (!append(text[index])) break;
  }
  return output.join("").trim();
}
