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
    const limit = request.maxExtractedChars ?? 200_000;
    const formatted = boundedPrettyJson(parsed, limit);
    const warnings = request.startPage ? ["PAGE_RANGE_NOT_SUPPORTED_FOR_JSON"] : [];
    if (formatted.truncated) warnings.push("JSON_OUTPUT_LIMIT");
    return { extractor: this.name, text: formatted.text, warnings };
  }
}

const MAX_FORMAT_DEPTH = 256;

type FormatTask =
  | { kind: "value"; value: unknown; depth: number }
  | { kind: "string"; value: string }
  | { kind: "text"; value: string }
  | { kind: "container"; iterator: Iterator<unknown> | Iterator<[string, unknown]>; depth: number; close: string; object: boolean; first: boolean };

type BoundedJson = { text: string; truncated: boolean };

/**
 * Pretty-print parsed JSON without first materializing the complete expanded
 * representation.  The task stack is iterative and every write is charged to
 * the caller's output budget.
 */
export function boundedPrettyJson(value: unknown, maxChars: number): BoundedJson {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error("JSON_OUTPUT_LIMIT_INVALID");
  const chunks: string[] = [];
  let size = 0;
  let truncated = false;
  const write = (valueToWrite: string): boolean => {
    if (size >= maxChars) {
      truncated = true;
      return false;
    }
    const remaining = maxChars - size;
    const part = valueToWrite.length <= remaining ? valueToWrite : valueToWrite.slice(0, remaining);
    chunks.push(part);
    size += part.length;
    if (part.length !== valueToWrite.length) truncated = true;
    return part.length === valueToWrite.length;
  };

  const tasks: FormatTask[] = [{ kind: "value", value, depth: 0 }];
  while (tasks.length && size < maxChars) {
    const task = tasks.pop()!;
    if (task.kind === "text") {
      write(task.value);
      continue;
    }
    if (task.kind === "string") {
      writeJsonString(task.value, write);
      continue;
    }
    if (task.kind === "container") {
      const next = task.iterator.next();
      if (next.done) {
        write(task.first ? (task.object ? "}" : "]") : task.close);
        continue;
      }
      write(task.first ? `\n${"  ".repeat(task.depth + 1)}` : `,\n${"  ".repeat(task.depth + 1)}`);
      tasks.push({ ...task, first: false });
      if (task.object) {
        const [key, child] = next.value as [string, unknown];
        tasks.push({ kind: "value", value: child, depth: task.depth + 1 });
        tasks.push({ kind: "text", value: ": " });
        tasks.push({ kind: "string", value: key });
      } else {
        tasks.push({ kind: "value", value: next.value, depth: task.depth + 1 });
      }
      continue;
    }
    if (task.depth > MAX_FORMAT_DEPTH) {
      // A valid deeply nested value is still valid input. Stop formatting at
      // the safe depth rather than failing after parsing or recursing further.
      truncated = true;
      break;
    }
    const current = task.value;
    if (current === null) {
      write("null");
    } else if (typeof current === "string") {
      tasks.push({ kind: "string", value: current });
    } else if (typeof current === "boolean") {
      write(current ? "true" : "false");
    } else if (typeof current === "number") {
      write(Number.isFinite(current) ? String(current) : "null");
    } else if (Array.isArray(current)) {
      if (current.length === 0) {
        write("[]");
        continue;
      }
      write("[");
      tasks.push({ kind: "container", iterator: arrayValues(current), depth: task.depth, close: `\n${"  ".repeat(task.depth)}]`, object: false, first: true });
    } else if (typeof current === "object") {
      write("{");
      tasks.push({ kind: "container", iterator: objectEntries(current as Record<string, unknown>), depth: task.depth, close: `\n${"  ".repeat(task.depth)}}`, object: true, first: true });
    } else {
      // JSON.parse cannot produce bigint/function/symbol, but keeping this
      // branch conservative prevents accidental non-JSON public output if the
      // helper is reused directly.
      write("null");
    }
  }
  if (tasks.length) truncated = true;
  return { text: chunks.join(""), truncated };
}

function* arrayValues(value: unknown[]): Generator<unknown> {
  for (let index = 0; index < value.length; index += 1) yield value[index];
}

function* objectEntries(value: Record<string, unknown>): Generator<[string, unknown]> {
  for (const key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) yield [key, value[key]];
  }
}

function writeJsonString(value: string, write: (chunk: string) => boolean): void {
  if (!write('"')) return;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let escaped: string;
    switch (code) {
      case 8: escaped = "\\b"; break;
      case 9: escaped = "\\t"; break;
      case 10: escaped = "\\n"; break;
      case 12: escaped = "\\f"; break;
      case 13: escaped = "\\r"; break;
      case 34: escaped = '\\"'; break;
      case 92: escaped = "\\\\"; break;
      default:
        if (code < 32) escaped = `\\u${code.toString(16).padStart(4, "0")}`;
        else if (code >= 0xd800 && code <= 0xdfff) {
          const validPair = code < 0xdc00 && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff;
          if (validPair) {
            escaped = value[index] + value[index + 1];
            index += 1;
          } else {
            escaped = `\\u${code.toString(16).padStart(4, "0")}`;
          }
        } else escaped = value[index];
    }
    if (!write(escaped)) return;
  }
  write('"');
}
