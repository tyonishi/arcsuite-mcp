import { readFile } from "node:fs/promises";
import type { ContentExtractor, ExtractRequest, ExtractResult } from "./types.ts";

export class JsonExtractor implements ContentExtractor {
  readonly name = "json";
  supports(contentType: string, fileName: string): boolean {
    return /application\/(.+\+)?json/i.test(contentType) || /\.json$/i.test(fileName);
  }
  async extract(request: ExtractRequest): Promise<ExtractResult> {
    const raw = await readFile(request.filePath, "utf8");
    const parsed = JSON.parse(raw);
    return { extractor: this.name, text: JSON.stringify(parsed, null, 2), warnings: request.startPage ? ["PAGE_RANGE_NOT_SUPPORTED_FOR_JSON"] : [] };
  }
}
