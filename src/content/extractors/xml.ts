import { readFile } from "node:fs/promises";
import type { ContentExtractor, ExtractRequest, ExtractResult } from "./types.ts";

export class XmlExtractor implements ContentExtractor {
  readonly name = "xml";
  supports(contentType: string, fileName: string): boolean {
    return /(?:application|text)\/(?:.+\+)?xml/i.test(contentType) || /\.xml$/i.test(fileName);
  }
  async extract(request: ExtractRequest): Promise<ExtractResult> {
    const raw = await readFile(request.filePath, "utf8");
    if (/<!DOCTYPE/i.test(raw) || /<!ENTITY/i.test(raw)) throw new Error("UNSAFE_XML_DECLARATION");
    const withoutComments = raw.replace(/<!--[\s\S]*?-->/g, " ");
    const withCdata = withoutComments.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
    const text = decodeEntities(withCdata.replace(/<[^>]+>/g, " ")).replace(/[ \t]+/g, " ").replace(/\n\s+/g, "\n").trim();
    return { extractor: this.name, text, warnings: request.startPage ? ["PAGE_RANGE_NOT_SUPPORTED_FOR_XML"] : [] };
  }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)));
}
