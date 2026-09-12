import { createHash } from "node:crypto";
import { realpath, stat, unlink } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { AdapterContentResult } from "../arcsuite/types.ts";
import type { ContentExtractor, ExtractRequest, ExtractResult } from "./extractors/types.ts";
import { TextExtractor, CsvExtractor } from "./extractors/text.ts";
import { JsonExtractor } from "./extractors/json.ts";
import { XmlExtractor } from "./extractors/xml.ts";
import { PdfExtractor } from "./extractors/pdf.ts";
import { OfficeOpenXmlExtractor } from "./extractors/officeOpenXml.ts";
import { UnsupportedContentHandler } from "./extractors/unsupported.ts";
import { CursorManager, type ReadCursorPayload } from "./cursor.ts";

export type ContentInfo = {
  label: string;
  file_name: string;
  content_type: string;
  size_bytes?: number;
  extractable: boolean;
  extractor: string;
};

export type ReadContentOptions = {
  traceId: string;
  documentId: string;
  revisionNumber?: number;
  startPage?: number;
  endPage?: number;
  cursor?: string;
  maxChars: number;
};

export type ReadContentResult = {
  document_id: string;
  revision_number?: number;
  file_name: string;
  content_type: string;
  extractor: string;
  page_range?: { start?: number; end?: number };
  content: string;
  truncated: boolean;
  next_cursor: string | null;
  warnings: string[];
};

export class ContentBridge {
  private readonly extractors: ContentExtractor[];
  private readonly sharedTempDir: string;
  private readonly cursors: CursorManager;
  private readonly maxContentBytes: number;
  private readonly maxExtractedChars: number;
  constructor(sharedTempDir: string, cursors: CursorManager, limits: { maxContentBytes: number; maxExtractedChars: number }) {
    this.sharedTempDir = sharedTempDir;
    this.cursors = cursors;
    this.maxContentBytes = limits.maxContentBytes;
    this.maxExtractedChars = limits.maxExtractedChars;
    this.extractors = [new TextExtractor(), new CsvExtractor(), new JsonExtractor(), new XmlExtractor(), new PdfExtractor(), new OfficeOpenXmlExtractor(), new UnsupportedContentHandler()];
  }

  info(content: AdapterContentResult): ContentInfo {
    const extractor = this.selectExtractor(content.contentType, content.fileName);
    return {
      label: content.label,
      file_name: content.fileName,
      content_type: content.contentType,
      size_bytes: content.sizeBytes,
      extractable: content.sizeBytes <= this.maxContentBytes && extractor.name !== "unsupported",
      extractor: extractor.name
    };
  }

  async discard(content: AdapterContentResult): Promise<void> {
    const safePath = await this.assertSharedPath(content.filePath);
    await unlink(safePath).catch(() => undefined);
  }

  async read(content: AdapterContentResult, options: ReadContentOptions): Promise<ReadContentResult> {
    const safePath = await this.assertSharedPath(content.filePath);
    try {
      if (content.sizeBytes > this.maxContentBytes) throw new Error("CONTENT_SIZE_LIMIT");
      const fileStats = await stat(safePath);
      if (fileStats.size > this.maxContentBytes) throw new Error("CONTENT_SIZE_LIMIT");
      let cursorPayload: ReadCursorPayload | undefined;
      if (options.cursor) cursorPayload = this.cursors.parse(options.cursor);
      const extractor = this.selectExtractor(content.contentType, content.fileName);
      if (extractor.name === "unsupported") throw new Error("UNSUPPORTED_CONTENT_TYPE");
      const request: ExtractRequest = {
        filePath: safePath,
        fileName: content.fileName,
        contentType: content.contentType,
        startPage: options.startPage,
        endPage: options.endPage,
        maxExtractedChars: this.maxExtractedChars
      };
      const extracted = await extractor.extract(request);
      const normalized = normalizeExtractedText(extracted.text).slice(0, this.maxExtractedChars);
      const warnings = [...extracted.warnings];
      if (extracted.text.length > this.maxExtractedChars) warnings.push("EXTRACTED_TEXT_LIMIT");
      const hash = `sha256:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
      let offset = 0;
      if (cursorPayload) {
        if (cursorPayload.document_id !== options.documentId || cursorPayload.revision_number !== options.revisionNumber) throw new Error("CURSOR_DOCUMENT_MISMATCH");
        if (cursorPayload.content_hash !== hash || cursorPayload.extractor !== extracted.extractor) throw new Error("CURSOR_CONTENT_CHANGED");
        offset = cursorPayload.offset;
      }
      if (offset > normalized.length) throw new Error("CURSOR_OFFSET_INVALID");
      const end = Math.min(normalized.length, offset + options.maxChars);
      const chunk = normalized.slice(offset, end);
      const truncated = end < normalized.length;
      const next = truncated ? this.cursors.create({
        trace_id: options.traceId,
        document_id: options.documentId,
        revision_number: options.revisionNumber,
        content_hash: hash,
        offset: end,
        extractor: extracted.extractor
      }) : null;
      return {
        document_id: options.documentId,
        revision_number: options.revisionNumber,
        file_name: content.fileName,
        content_type: content.contentType,
        extractor: extracted.extractor,
        page_range: extracted.pageRange,
        content: chunk,
        truncated,
        next_cursor: next,
        warnings
      };
    } finally {
      await unlink(safePath).catch(() => undefined);
    }
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

export function normalizeExtractedText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}
