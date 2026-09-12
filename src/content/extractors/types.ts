export type ExtractRequest = {
  filePath: string;
  fileName: string;
  contentType: string;
  startPage?: number;
  endPage?: number;
  maxExtractedChars?: number;
};

export type ExtractResult = {
  extractor: string;
  text: string;
  pageRange?: { start?: number; end?: number };
  warnings: string[];
};

export interface ContentExtractor {
  readonly name: string;
  supports(contentType: string, fileName: string): boolean;
  extract(request: ExtractRequest): Promise<ExtractResult>;
}
