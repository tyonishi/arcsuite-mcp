import { readFile } from "node:fs/promises";
import type { ContentExtractor, ExtractRequest, ExtractResult } from "./types.ts";

export class TextExtractor implements ContentExtractor {
  readonly name = "text";
  supports(contentType: string, fileName: string): boolean {
    return contentType.startsWith("text/plain") || /\.(txt|log)$/i.test(fileName);
  }
  async extract(request: ExtractRequest): Promise<ExtractResult> {
    const data = await readFile(request.filePath);
    return { extractor: this.name, text: data.toString("utf8"), warnings: pageWarning(request) };
  }
}

export class CsvExtractor implements ContentExtractor {
  readonly name = "csv";
  supports(contentType: string, fileName: string): boolean {
    return contentType.startsWith("text/csv") || /\.csv$/i.test(fileName);
  }
  async extract(request: ExtractRequest): Promise<ExtractResult> {
    const data = await readFile(request.filePath, "utf8");
    return { extractor: this.name, text: data, warnings: pageWarning(request) };
  }
}

function pageWarning(request: ExtractRequest): string[] {
  return request.startPage || request.endPage ? ["PAGE_RANGE_NOT_SUPPORTED_FOR_TEXT"] : [];
}
