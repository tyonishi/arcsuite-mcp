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
    const result = await runProcess("pdftotext", args, { timeoutMs: 120_000, maxStdoutBytes: 64 * 1024 * 1024 });
    return {
      extractor: this.name,
      text: result.stdout.toString("utf8"),
      pageRange: request.startPage || request.endPage ? { start: request.startPage, end: request.endPage } : undefined,
      warnings: []
    };
  }
}
