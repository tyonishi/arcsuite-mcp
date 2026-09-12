import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentBridge } from "../../src/content/contentBridge.ts";
import { CursorManager } from "../../src/content/cursor.ts";

function bridge(root: string, maxContentBytes = 1024, maxExtractedChars = 10) {
  return new ContentBridge(root, new CursorManager(Buffer.from("0123456789abcdef0123456789abcdef"), 600), { maxContentBytes, maxExtractedChars });
}

test("content bridge enforces byte bounds and removes rejected temp files", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-bounds-"));
  const path = join(root, "large.txt");
  await writeFile(path, "0123456789");
  const content = { id: "rep:mock:EXAMPLE_CABINET:1", fileName: "large.txt", contentType: "text/plain", sizeBytes: 10, label: "system:primary", filePath: path };
  assert.equal(bridge(root, 5).info(content).extractable, false);
  await assert.rejects(() => bridge(root, 5).read(content, { traceId: "trace", documentId: content.id, maxChars: 100 }), /CONTENT_SIZE_LIMIT/);
  await assert.rejects(() => readFile(path));
});

test("content bridge bounds extracted text and fails unsupported formats safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "content-extract-"));
  const textPath = join(root, "sample.txt");
  await writeFile(textPath, "abcdefghij");
  const textContent = { id: "rep:mock:EXAMPLE_CABINET:1", fileName: "sample.txt", contentType: "text/plain", sizeBytes: 10, label: "system:primary", filePath: textPath };
  const result = await bridge(root, 1024, 5).read(textContent, { traceId: "trace", documentId: textContent.id, maxChars: 100 });
  assert.equal(result.content, "abcde");
  assert.deepEqual(result.warnings, ["EXTRACTED_TEXT_LIMIT"]);

  const unsupportedPath = join(root, "sample.bin");
  await writeFile(unsupportedPath, Buffer.from([0, 1, 2]));
  const unsupported = { ...textContent, fileName: "sample.bin", contentType: "application/octet-stream", sizeBytes: 3, filePath: unsupportedPath };
  await assert.rejects(() => bridge(root).read(unsupported, { traceId: "trace", documentId: unsupported.id, maxChars: 100 }), /UNSUPPORTED_CONTENT_TYPE/);
  await assert.rejects(() => readFile(unsupportedPath));
});
