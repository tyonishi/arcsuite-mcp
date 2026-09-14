import type { ContentExtractor, ExtractRequest, ExtractResult } from "./types.ts";
import { runProcess } from "../../util/process.ts";

export class PdfExtractor implements ContentExtractor {
  readonly name = "pdf";
  supports(contentType: string, fileName: string): boolean {
    return contentType.toLowerCase().includes("application/pdf") || /\.pdf$/i.test(fileName);
  }
  async extract(request: ExtractRequest): Promise<ExtractResult> {
    const args = ["-enc", "UTF-8", "-layout"];
    if (request.startPage) args.push("-f", String(request.startPage));
    if (request.endPage) args.push("-l", String(request.endPage));
    args.push(request.filePath, "-");
    // Bound subprocess materialization near the configured text budget. UTF-8
    // output can use up to four bytes per character, with a small framing
    // allowance; the bridge applies the final character bound as well.
    const maxChars = request.maxExtractedChars ?? 200_000;
    const maxStdoutBytes = Math.min(64 * 1024 * 1024, maxChars * 4 + 1024);
    const result = await runProcess("pdftotext", args, { timeoutMs: 120_000, maxStdoutBytes });
    return {
      extractor: this.name,
      text: result.stdout.toString("utf8"),
      pageRange: request.startPage || request.endPage ? { start: request.startPage, end: request.endPage } : undefined,
      warnings: []
    };
  }
}
