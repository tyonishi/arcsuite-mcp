import type { ContentExtractor, ExtractRequest, ExtractResult } from "./types.ts";

export class UnsupportedContentHandler implements ContentExtractor {
  readonly name = "unsupported";
  supports(_contentType: string, _fileName: string): boolean { return true; }
  async extract(request: ExtractRequest): Promise<ExtractResult> {
    throw new Error(`UNSUPPORTED_CONTENT_TYPE:${request.contentType}:${request.fileName}`);
  }
}
