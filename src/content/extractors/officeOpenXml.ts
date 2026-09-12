import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { ContentExtractor, ExtractRequest, ExtractResult } from "./types.ts";
import { runProcess } from "../../util/process.ts";

const here = dirname(fileURLToPath(import.meta.url));
const helper = resolve(here, "../../../scripts/ooxml_extract.py");

export class OfficeOpenXmlExtractor implements ContentExtractor {
  readonly name = "office";
  supports(contentType: string, fileName: string): boolean {
    const ct = contentType.toLowerCase();
    return /\.(docx|xlsx|pptx)$/i.test(fileName) ||
      ct.includes("wordprocessingml.document") || ct.includes("spreadsheetml.sheet") || ct.includes("presentationml.presentation");
  }
  async extract(request: ExtractRequest): Promise<ExtractResult> {
    const kind = extensionKind(request.fileName, request.contentType);
    const maxChars = request.maxExtractedChars ?? 200_000;
    const result = await runProcess("python3", [helper, request.filePath, kind, String(maxChars)], { timeoutMs: 120_000, maxStdoutBytes: Math.min(64 * 1024 * 1024, maxChars * 8 + 1024) });
    const warnings = request.startPage || request.endPage ? ["PAGE_RANGE_NOT_SUPPORTED_FOR_OFFICE_OPEN_XML"] : [];
    return { extractor: `${this.name}:${kind}`, text: result.stdout.toString("utf8"), warnings };
  }
}

function extensionKind(fileName: string, contentType: string): "docx" | "xlsx" | "pptx" {
  if (/\.docx$/i.test(fileName) || contentType.toLowerCase().includes("wordprocessingml")) return "docx";
  if (/\.xlsx$/i.test(fileName) || contentType.toLowerCase().includes("spreadsheetml")) return "xlsx";
  return "pptx";
}
